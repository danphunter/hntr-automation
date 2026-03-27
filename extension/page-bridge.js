// HNTR Flow Bridge - Page World Script
// Runs in the page's main world (not the content script isolated world),
// so window properties set here are directly visible to React — no CSP issues.
window.__HNTR_EXTENSION_INSTALLED = true;
window.dispatchEvent(new CustomEvent('hntr-extension-ready'));
