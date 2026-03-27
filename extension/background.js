// HNTR Flow Bridge - Background Service Worker
// Receives token requests from our app's content script,
// opens/reuses a labs.google tab, and executes reCAPTCHA Enterprise there.

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
  // Reuse an existing labs.google tab if available
  const existing = await chrome.tabs.query({ url: 'https://labs.google/*' });
  let tabId;

  if (existing.length > 0) {
    tabId = existing[0].id;
  } else {
    // Open labs.google in the background (not focused)
    const tab = await chrome.tabs.create({ url: 'https://labs.google/', active: false });
    tabId = tab.id;
    await waitForTabLoad(tabId);
  }

  // Run reCAPTCHA Enterprise in the page's main world so it can access window.grecaptcha
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

// This function runs in the labs.google page's main world.
// It must be self-contained (no closures over extension variables).
async function executeRecaptchaInPage(siteKey) {
  // Load the Enterprise script if not already present
  if (!document.getElementById('hntr-recaptcha-enterprise')) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.id = 'hntr-recaptcha-enterprise';
      s.src = `https://www.google.com/recaptcha/enterprise.js?render=${siteKey}`;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load reCAPTCHA Enterprise script'));
      document.head.appendChild(s);
    });
  }

  // Wait for grecaptcha.enterprise to be available (up to 10s)
  for (let i = 0; i < 100; i++) {
    if (window.grecaptcha?.enterprise?.ready) break;
    await new Promise(r => setTimeout(r, 100));
  }
  if (!window.grecaptcha?.enterprise?.ready) {
    throw new Error('reCAPTCHA Enterprise did not initialize');
  }

  return new Promise((resolve, reject) => {
    window.grecaptcha.enterprise.ready(async () => {
      try {
        const token = await window.grecaptcha.enterprise.execute(siteKey, { action: 'generate' });
        resolve(token);
      } catch (e) {
        reject(e);
      }
    });
  });
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
        // Small delay to let page JS initialize
        setTimeout(resolve, 500);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}
