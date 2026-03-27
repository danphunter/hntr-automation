// HNTR Flow Bridge - labs.google Content Script
// Injects inject-flow.js into the page's main world, then bridges
// messages from the background service worker to the injected script
// via window CustomEvents (the only cross-world channel available
// without inline scripts or scripting.executeScript).

let injectReady = false;
const pendingResolvers = new Map(); // correlationId → { resolve, reject }

// Inject the script file — runs in MAIN world so it can access grecaptcha.
(function injectScript() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inject-flow.js');
  document.documentElement.appendChild(script);
  script.remove(); // clean up the tag once it has been parsed
})();

// inject-flow.js signals when it has loaded and its listener is active.
window.addEventListener('hntr-flow-inject-ready', () => {
  injectReady = true;
});

// Receive results from inject-flow.js and resolve the matching pending promise.
window.addEventListener('hntr-flow-result', (e) => {
  const { correlationId, fifeUrl, error } = e.detail || {};
  const resolver = pendingResolvers.get(correlationId);
  if (resolver) {
    pendingResolvers.delete(correlationId);
    resolver.resolve({ fifeUrl, error });
  }
});

// Handle requests from background.js.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action !== 'executeFlow') return false;

  const { prompt, bearerToken, projectId, seed } = msg;
  const correlationId = `${Date.now()}-${Math.random()}`;

  // Wait up to 5 s for the injected script to be ready, then fire the request.
  waitForInjectReady(5000)
    .then(() => {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingResolvers.delete(correlationId);
          reject(new Error('inject-flow.js did not respond within 60 s'));
        }, 60000);

        pendingResolvers.set(correlationId, {
          resolve: (result) => { clearTimeout(timeout); resolve(result); },
          reject: (err)    => { clearTimeout(timeout); reject(err); },
        });

        window.dispatchEvent(new CustomEvent('hntr-flow-execute', {
          detail: { correlationId, prompt, bearerToken, projectId, seed },
        }));
      });
    })
    .then(result => sendResponse(result))
    .catch(err  => sendResponse({ error: err.message }));

  return true; // keep the message channel open for the async response
});

function waitForInjectReady(maxMs) {
  if (injectReady) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error('inject-flow.js never became ready')),
      maxMs
    );
    const handler = () => { clearTimeout(deadline); resolve(); };
    window.addEventListener('hntr-flow-inject-ready', handler, { once: true });
  });
}
