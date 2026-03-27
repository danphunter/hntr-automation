// HNTR Flow Bridge - Content Script
// Injected into our app pages (Railway + localhost).
// Bridges custom DOM events from our React app to the background service worker.

// Signal to the page that the extension is installed
window.__HNTR_EXTENSION_INSTALLED = true;
window.dispatchEvent(new CustomEvent('hntr-extension-ready'));

// Listen for token requests dispatched by our React app
window.addEventListener('hntr-request-token', () => {
  chrome.runtime.sendMessage({ action: 'getRecaptchaToken' }, (response) => {
    if (chrome.runtime.lastError) {
      window.dispatchEvent(new CustomEvent('hntr-token-error', {
        detail: { error: chrome.runtime.lastError.message },
      }));
      return;
    }
    if (response?.success) {
      window.dispatchEvent(new CustomEvent('hntr-token-response', {
        detail: { token: response.token },
      }));
    } else {
      window.dispatchEvent(new CustomEvent('hntr-token-error', {
        detail: { error: response?.error || 'Failed to get reCAPTCHA token' },
      }));
    }
  });
});
