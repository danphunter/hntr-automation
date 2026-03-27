// HNTR Flow Bridge - Background Service Worker
// Receives image generation requests from content-hntr.js, ensures a
// labs.google/flow tab exists, then delegates to content-labs.js which
// bridges to inject-flow.js (running in the page's MAIN world with direct
// access to grecaptcha.enterprise).  No scripting.executeScript needed.

console.log('[HNTR bg] service worker loaded');

let flowTabId = null;

console.log('[HNTR] Background service worker started');

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('[HNTR bg] onMessage fired, action:', msg?.action, 'from tab:', sender?.tab?.id);
  if (msg.action === 'generateImage') {
    console.log('[HNTR bg] handling generateImage request, prompt length:', msg.prompt?.length);
    handleGenerate(msg)
      .then(result => {
        console.log('[HNTR bg] generateImage succeeded, fifeUrl:', result.fifeUrl?.slice(0, 60));
        sendResponse({ success: true, fifeUrl: result.fifeUrl });
      })
      .catch(err => {
        console.error('[HNTR bg] generateImage failed:', err.message);
        sendResponse({ success: false, error: err.message });
      });
    return true; // keep message channel open for async response
  }
});

async function handleGenerate({ prompt, bearerToken, projectId, seed }) {
  const tabId = await ensureFlowTab();

  const result = await sendTabMessage(tabId, {
    action: 'executeFlow',
    prompt,
    bearerToken,
    projectId,
    seed,
  });

  if (result?.error) throw new Error(result.error);
  if (!result?.fifeUrl) throw new Error('No fifeUrl returned from Flow API');
  return { fifeUrl: result.fifeUrl };
}

async function ensureFlowTab() {
  // Verify stored tab is still alive and on labs.google/flow.
  if (flowTabId !== null) {
    try {
      const tab = await chrome.tabs.get(flowTabId);
      if (tab.url && tab.url.startsWith('https://labs.google/flow')) {
        return flowTabId;
      }
    } catch {
      // tab was closed
    }
    flowTabId = null;
  }

  // Reuse an existing flow tab if one is open.
  const existing = await chrome.tabs.query({ url: '*://labs.google/flow*' });
  if (existing.length > 0) {
    flowTabId = existing[0].id;
    return flowTabId;
  }

  // Open a fresh tab and wait for it to fully load.
  const tab = await chrome.tabs.create({ url: 'https://labs.google/flow', active: false });
  flowTabId = tab.id;
  await waitForTabLoad(flowTabId);
  return flowTabId;
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
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
        // Extra delay for reCAPTCHA JS and page app to fully initialise,
        // and for content-labs.js to inject and ready inject-flow.js.
        setTimeout(resolve, 3000);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}
