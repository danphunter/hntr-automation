// HNTR Flow Bridge - Page Injected Script
// Runs in the labs.google page's MAIN world (injected by content-labs.js).
// Has direct access to window.grecaptcha.enterprise.
// Communicates with content-labs.js via window CustomEvents.

const FLOW_SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';

// Intercept fetch to capture the bearer token from Flow's own requests
let capturedBearerToken = null;
const originalFetch = window.fetch;
window.fetch = function(...args) {
  const [url, options] = args;
  if (options && options.headers) {
    const headers = options.headers;
    let authHeader = null;
    if (headers instanceof Headers) {
      authHeader = headers.get('authorization');
    } else if (typeof headers === 'object') {
      authHeader = headers['authorization'] || headers['Authorization'];
    }
    if (authHeader && authHeader.startsWith('Bearer ')) {
      capturedBearerToken = authHeader.replace('Bearer ', '');
      console.log('[HNTR inject] Captured bearer token (first 20 chars):', capturedBearerToken.substring(0, 20));
    }
  }
  return originalFetch.apply(this, args);
};

function waitForRecaptcha(maxWait) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function check() {
      if (
        window.grecaptcha &&
        window.grecaptcha.enterprise &&
        typeof window.grecaptcha.enterprise.execute === 'function'
      ) {
        resolve();
      } else if (Date.now() - start > maxWait) {
        reject(new Error('grecaptcha.enterprise not available after ' + maxWait + 'ms'));
      } else {
        setTimeout(check, 500);
      }
    })();
  });
}

window.addEventListener('hntr-flow-execute', async (e) => {
  const { correlationId, prompt, projectId, seed } = e.detail || {};

  function respond(detail) {
    window.dispatchEvent(new CustomEvent('hntr-flow-result', {
      detail: { correlationId, ...detail },
    }));
  }

  // ── reCAPTCHA (required — Flow API returns 403 without a valid token) ────
  let recaptchaToken;
  try {
    await Promise.race([
      waitForRecaptcha(30000),
      new Promise((_, reject) => setTimeout(() => reject(new Error('reCAPTCHA wait timeout')), 30000)),
    ]);
    recaptchaToken = await Promise.race([
      window.grecaptcha.enterprise.execute(FLOW_SITE_KEY, { action: 'generate' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('reCAPTCHA execute timeout')), 10000)),
    ]);
    console.log('[HNTR] reCAPTCHA token obtained');
  } catch (err) {
    console.error('[HNTR] reCAPTCHA failed:', err.message);
    respond({ error: `reCAPTCHA failed: ${err.message}. Make sure labs.google/fx/tools/flow is open and fully loaded.` });
    return;
  }

  // ── Flow API call ─────────────────────────────────────────────────────────
  try {
    const sessionId = `;${Date.now()}`;
    const batchId = crypto.randomUUID();

    const clientContext = {
      recaptchaContext: {
        token: recaptchaToken,
        applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
      },
      projectId,
      tool: 'PINHOLE',
      sessionId,
    };

    const body = {
      clientContext,
      mediaGenerationContext: { batchId },
      useNewMedia: true,
      requests: [{
        clientContext,
        imageModelName: 'NARWHAL',
        imageAspectRatio: 'IMAGE_ASPECT_RATIO_LANDSCAPE',
        structuredPrompt: { parts: [{ text: prompt }] },
        seed: seed || Math.floor(Math.random() * 1000000),
        imageInputs: [],
      }],
    };

    if (!capturedBearerToken) {
      respond({ error: 'No bearer token captured yet. Please generate one image in Flow first, then retry.' });
      return;
    }

    const response = await originalFetch(
      `https://aisandbox-pa.googleapis.com/v1/projects/${projectId}/flowMedia:batchGenerateImages`,
      {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${capturedBearerToken}`,
          'content-type': 'text/plain;charset=UTF-8',
        },
        body: JSON.stringify(body),
      }
    );

    const data = await response.json();

    if (data.error) {
      respond({ error: `Flow API error: ${JSON.stringify(data.error)}` });
      return;
    }

    const fifeUrl = data?.media?.[0]?.image?.generatedImage?.fifeUrl;
    if (!fifeUrl) {
      respond({ error: `No fifeUrl in response: ${JSON.stringify(data).slice(0, 300)}` });
      return;
    }

    respond({ fifeUrl });
  } catch (err) {
    respond({ error: err.message });
  }
});

// Signal to content-labs.js that this script is loaded and listening.
window.dispatchEvent(new CustomEvent('hntr-flow-inject-ready'));
