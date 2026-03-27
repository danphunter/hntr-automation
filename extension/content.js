// HNTR Flow Bridge - Content Script
// Runs in the isolated world. Bridges CustomEvents from the React app
// to the background service worker via chrome.runtime.
//
// Uses document-level CustomEvents (NOT window) — these cross the isolated
// world / page world boundary via the shared DOM without any inline scripts,
// making this approach fully CSP-safe.

// Signal to the page that the extension is installed and ready
document.dispatchEvent(new CustomEvent('hntr-extension-ready'));

// Respond to pings so the page can detect the extension at any time
document.addEventListener('hntr-ping', () => {
  document.dispatchEvent(new CustomEvent('hntr-pong'));
});

// Handle token requests
document.addEventListener('hntr-request-token', async () => {
  // Retry up to 3 times. In MV3, the service worker may need a moment to wake
  // up from idle — "Could not establish connection" is the symptom.
  let lastError = 'Failed to communicate with extension background';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 300 * attempt));
    const result = await sendMessageToBackground({ action: 'getRecaptchaToken' });
    if (result.ok) {
      document.dispatchEvent(new CustomEvent('hntr-token-response', {
        detail: { token: result.token },
      }));
      return;
    }
    lastError = result.error;
    // Only retry connection-level errors (service worker not yet awake).
    const isConnectionError =
      lastError.includes('Could not establish connection') ||
      lastError.includes('Receiving end does not exist');
    if (!isConnectionError) break;
  }
  document.dispatchEvent(new CustomEvent('hntr-token-error', {
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
