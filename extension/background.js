// HNTR Flow Bridge - Background Service Worker
// Receives image generation requests from our app's content script,
// finds an existing labs.google tab (e.g. GenAIPro's service tab), and executes
// the full Flow API call there: reCAPTCHA token + batchGenerateImages fetch.
// This works because labs.google already has reCAPTCHA Enterprise loaded and
// the fetch originates from labs.google, satisfying CORS requirements.

const FLOW_SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'generateImage') {
    const { prompt, bearerToken, projectId, seed } = message;
    generateImageFromLabs(prompt, bearerToken, projectId, seed)
      .then(fifeUrl => sendResponse({ success: true, fifeUrl }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // Keep message channel open for async response
  }
});

async function generateImageFromLabs(prompt, bearerToken, projectId, seed) {
  // Prefer any existing labs.google tab — GenAIPro keeps one open with
  // reCAPTCHA Enterprise already loaded and initialized.
  const existing = await chrome.tabs.query({ url: '*://labs.google/*' });
  let tabId;

  if (existing.length > 0) {
    tabId = existing[0].id;
  } else {
    // No existing tab — open labs.google/flow which bootstraps reCAPTCHA Enterprise.
    // Keep it in the background; do NOT close it after use so future requests are fast.
    const tab = await chrome.tabs.create({ url: 'https://labs.google/flow', active: false });
    tabId = tab.id;
    await waitForTabLoad(tabId);
  }

  // Execute in the page's main world — grecaptcha.enterprise is already there,
  // and fetch() will use labs.google as the origin (satisfying CORS).
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: executeInPage,
    args: [FLOW_SITE_KEY, prompt, bearerToken, projectId, seed],
  });

  const result = results[0];
  if (result.error) throw new Error(result.error.message);
  if (result.result?.error) throw new Error(result.result.error);
  if (!result.result?.fifeUrl) throw new Error('No fifeUrl returned from Flow API');
  return result.result.fifeUrl;
}

// Runs inside the labs.google page's main world.
// Gets a fresh reCAPTCHA token then makes the full Flow API call.
// Must be self-contained — no closures over extension variables.
async function executeInPage(siteKey, prompt, bearerToken, projectId, seed) {
  // Wait up to 10 s for grecaptcha.enterprise.execute to be available.
  for (let i = 0; i < 100; i++) {
    if (window.grecaptcha?.enterprise?.execute) break;
    await new Promise(r => setTimeout(r, 100));
  }
  if (!window.grecaptcha?.enterprise?.execute) {
    return { error: 'grecaptcha.enterprise not available on this labs.google tab' };
  }

  try {
    // Get a fresh reCAPTCHA token — valid because we're on labs.google.
    const recaptchaToken = await window.grecaptcha.enterprise.execute(siteKey, { action: 'generate' });

    const clientContext = {
      recaptchaContext: {
        token: recaptchaToken,
        applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
      },
      projectId,
      tool: 'PINHOLE',
      sessionId: `;${Date.now()}`,
    };

    const body = {
      clientContext,
      mediaGenerationContext: { batchId: crypto.randomUUID() },
      useNewMedia: true,
      requests: [{
        clientContext,
        imageModelName: 'NARWHAL',
        imageAspectRatio: 'IMAGE_ASPECT_RATIO_LANDSCAPE',
        structuredPrompt: { parts: [{ text: prompt }] },
        seed,
        imageInputs: [],
      }],
    };

    // fetch() here originates from labs.google — CORS is satisfied.
    const response = await fetch(
      `https://aisandbox-pa.googleapis.com/v1/projects/${projectId}/flowMedia:batchGenerateImages`,
      {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${bearerToken}`,
          'content-type': 'application/json',
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
      reject(new Error('labs.google tab timed out loading'));
    }, 30000);

    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        // Extra delay to let the page's reCAPTCHA JS fully initialize.
        setTimeout(resolve, 1500);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}
