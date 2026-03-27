// HNTR Flow Bridge - Background Service Worker
// Receives token requests from our app's content script,
// finds an existing labs.google tab (e.g. GenAIPro's service tab), and executes
// reCAPTCHA Enterprise there using the already-initialized grecaptcha.enterprise object.

const FLOW_SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getRecaptchaToken') {
    getTokenFromLabs()
      .then(token => sendResponse({ success: true, token }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // Keep message channel open for async response
  }
});

async function getTokenFromLabs() {
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

  // Execute in the page's main world — grecaptcha.enterprise is already there.
  // Do NOT inject the script ourselves; that produces invalid tokens on a blank page.
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: executeRecaptchaInPage,
    args: [FLOW_SITE_KEY],
  });

  const result = results[0];
  if (result.error) throw new Error(result.error.message);
  if (!result.result) throw new Error('No token returned from reCAPTCHA');
  return result.result;
}

// Runs inside the labs.google page's main world.
// Assumes grecaptcha.enterprise is already loaded (it is on any labs.google tab).
// Must be self-contained — no closures over extension variables.
async function executeRecaptchaInPage(siteKey) {
  // Wait up to 10 s for grecaptcha.enterprise.execute to be available.
  for (let i = 0; i < 100; i++) {
    if (window.grecaptcha?.enterprise?.execute) break;
    await new Promise(r => setTimeout(r, 100));
  }
  if (!window.grecaptcha?.enterprise?.execute) {
    throw new Error('grecaptcha.enterprise not available on this labs.google tab');
  }

  // Call execute directly — no need for .ready() wrapper when the API is already up.
  const token = await window.grecaptcha.enterprise.execute(siteKey, { action: 'generate' });
  return token;
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
