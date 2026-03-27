// HNTR Flow Bridge - Content Script
// Runs in the isolated world. Bridges CustomEvents from the React app
// to the background service worker via chrome.runtime.
//
// window.__HNTR_EXTENSION_INSTALLED is set by page-bridge.js (MAIN world)
// which bypasses any page CSP restrictions on inline scripts.

window.addEventListener('hntr-request-token', async () => {
  // Retry up to 3 times. In MV3, the service worker may need a moment to wake
  // up from idle — "Could not establish connection" is the symptom.
  let lastError = 'Failed to communicate with extension background';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 300 * attempt));
    const result = await sendMessageToBackground({ action: 'getRecaptchaToken' });
    if (result.ok) {
      window.dispatchEvent(new CustomEvent('hntr-token-response', {
        detail: { token: result.token },
      }));
      return;
    }
    lastError = result.error;
    // Only retry connection-level errors (service worker not yet awake).
    // For reCAPTCHA or other logic errors, fail immediately.
    const isConnectionError =
      lastError.includes('Could not establish connection') ||
      lastError.includes('Receiving end does not exist');
    if (!isConnectionError) break;
  }
  window.dispatchEvent(new CustomEvent('hntr-token-error', {
    detail: { error: lastError },
  }));
});

function sendMessageToBackground(message) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else if (response?.success) {
        resolve({ ok: true, token: response.token });
      } else {
        resolve({ ok: false, error: response?.error || 'Unknown error from background' });
      }
    });
  });
}
