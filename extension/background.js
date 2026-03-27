// HNTR Flow Bridge - Background Service Worker
// Receives image generation requests from our app's content script,
// opens (or reuses) a dedicated labs.google/flow tab, and executes
// the full Flow API call there: reCAPTCHA token (with timeout + fallback)
// + batchGenerateImages fetch.
//
// reCAPTCHA is optional — if it times out or errors we continue with an
// empty token (the Flow API sometimes accepts this from a valid browser
// session).  The fetch always originates from labs.google, satisfying CORS.

const FLOW_SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';

// Persisted across service-worker invocations via the module-level variable.
// We keep our own tab open so we're not dependent on GenAIPro or any other
// third-party extension's tabs.
let flowTabId = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'generateImage') {
    handleGenerate(msg)
      .then(result => sendResponse({ success: true, fifeUrl: result.fifeUrl }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // keep message channel open for async response
  }
});

async function handleGenerate({ prompt, bearerToken, projectId, seed }) {
  // Verify our stored tab still exists and is on labs.google/flow.
  if (flowTabId !== null) {
    try {
      const tab = await chrome.tabs.get(flowTabId);
      if (!tab.url || !tab.url.startsWith('https://labs.google/flow')) {
        flowTabId = null; // stale — will create a fresh one below
      }
    } catch {
      flowTabId = null; // tab was closed
    }
  }

  // If we don't have a valid stored tab, look for an existing flow tab or
  // create a new one.
  if (flowTabId === null) {
    const existing = await chrome.tabs.query({ url: '*://labs.google/flow*' });
    if (existing.length > 0) {
      flowTabId = existing[0].id;
    } else {
      const tab = await chrome.tabs.create({ url: 'https://labs.google/flow', active: false });
      flowTabId = tab.id;
      await waitForTabLoad(flowTabId);
    }
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId: flowTabId },
    world: 'MAIN',
    func: executeInPage,
    args: [FLOW_SITE_KEY, prompt, bearerToken, projectId, seed],
  });

  const result = results[0];
  if (result.error) throw new Error(result.error.message);
  if (result.result?.error) throw new Error(result.result.error);
  if (!result.result?.fifeUrl) throw new Error('No fifeUrl returned from Flow API');
  return { fifeUrl: result.result.fifeUrl };
}

// Runs inside the labs.google/flow page's main world.
// Gets a reCAPTCHA token (10 s timeout — falls through with empty token on
// failure), then makes the full Flow API call.
// Must be self-contained — no closures over extension variables.
async function executeInPage(siteKey, prompt, bearerToken, projectId, seed) {
  // ── reCAPTCHA (best-effort) ─────────────────────────────────────────────
  let recaptchaToken = '';
  try {
    // Wait up to 10 s for grecaptcha.enterprise to initialise.
    for (let i = 0; i < 100; i++) {
      if (window.grecaptcha?.enterprise?.execute) break;
      await new Promise(r => setTimeout(r, 100));
    }

    if (window.grecaptcha?.enterprise?.execute) {
      recaptchaToken = await Promise.race([
        window.grecaptcha.enterprise.execute(siteKey, { action: 'generate' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('reCAPTCHA timeout')), 10000)),
      ]);
      console.log('[HNTR] reCAPTCHA token obtained');
    } else {
      console.log('[HNTR] grecaptcha.enterprise not available — proceeding without token');
    }
  } catch (e) {
    console.log('[HNTR] reCAPTCHA failed, continuing without token:', e.message);
  }

  // ── Flow API call ────────────────────────────────────────────────────────
  try {
    const sessionId = `;${Date.now()}`;
    const batchId = crypto.randomUUID();

    const clientContext = {
      recaptchaContext: {
        token: recaptchaToken,
        applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
      },
      projectId,
      tool: 'PINHOLE',
      sessionId,
    };

    const body = {
      clientContext,
      mediaGenerationContext: { batchId },
      useNewMedia: true,
      requests: [{
        clientContext,
        imageModelName: 'NARWHAL',
        imageAspectRatio: 'IMAGE_ASPECT_RATIO_LANDSCAPE',
        structuredPrompt: { parts: [{ text: prompt }] },
        seed: seed || Math.floor(Math.random() * 1000000),
        imageInputs: [],
      }],
    };

    const response = await fetch(
      `https://aisandbox-pa.googleapis.com/v1/projects/${projectId}/flowMedia:batchGenerateImages`,
      {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${bearerToken}`,
          'content-type': 'text/plain;charset=UTF-8',
        },
        body: JSON.stringify(body),
      }
    );

    const data = await response.json();
    if (data.error) return { error: `Flow API error: ${JSON.stringify(data.error)}` };

    const fifeUrl = data?.media?.[0]?.image?.generatedImage?.fifeUrl;
    if (!fifeUrl) return { error: `No fifeUrl in response: ${JSON.stringify(data).slice(0, 300)}` };

    return { fifeUrl };
  } catch (err) {
    return { error: err.message };
  }
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('labs.google/flow tab timed out loading'));
    }, 30000);

    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        // Extra delay for reCAPTCHA JS and page app to fully initialise.
        setTimeout(resolve, 3000);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}
