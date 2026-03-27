// HNTR Flow Bridge - Background Service Worker
// Receives image generation requests from content-hntr.js, finds the user's
// existing signed-in labs.google/fx/* tab, then delegates to content-labs.js
// which bridges to inject-flow.js (running in the page's MAIN world with direct
// access to grecaptcha.enterprise).  No scripting.executeScript needed.
// NOTE: The extension never opens a Flow tab itself — reCAPTCHA only works in
// a tab where the user is already signed in to Google.

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
  // Verify the stored tab is still alive and on a real Flow workspace page.
  if (flowTabId !== null) {
    try {
      const tab = await chrome.tabs.get(flowTabId);
      if (tab.url && tab.url.startsWith('https://labs.google/fx/')) {
        return flowTabId;
      }
    } catch {
      // tab was closed
    }
    flowTabId = null;
  }

  // Find an existing signed-in Flow workspace tab (labs.google/fx/...).
  // We never open one ourselves — reCAPTCHA only works when the user is
  // already signed in, and auto-opening the landing page (labs.google/flow)
  // won't have the grecaptcha.enterprise token available.
  const existing = await chrome.tabs.query({ url: '*://labs.google/fx/*' });
  if (existing.length > 0) {
    flowTabId = existing[0].id;
    return flowTabId;
  }

  throw new Error(
    'No Flow workspace tab found. Please open labs.google/fx/tools/flow and sign in, then try again.'
  );
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
