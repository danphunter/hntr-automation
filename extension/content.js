// HNTR Flow Bridge - Content Script
// Injected into our app pages (Railway + localhost).
// Bridges custom DOM events from our React app to the background service worker.

// Signal to the page that the extension is installed.
// Content scripts run in an isolated world — setting window properties here
// is NOT visible to the page's JS. Inject a <script> tag to run in the page's
// main world so window.__HNTR_EXTENSION_INSTALLED is actually visible to React.
const _bridge = document.createElement('script');
_bridge.textContent = 'window.__HNTR_EXTENSION_INSTALLED = true; window.dispatchEvent(new CustomEvent("hntr-extension-ready"));';
document.documentElement.appendChild(_bridge);
_bridge.remove();

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
