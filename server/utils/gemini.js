// Shared Gemini API utilities used by both generate.js and render.js

// -- Token rotation (whisk_tokens table) --------------------------------------

function getNextToken(db) {
  db.prepare(`
    UPDATE whisk_tokens SET status = 'active', last_error = NULL
    WHERE status = 'rate_limited'
      AND rate_limited_until IS NOT NULL
      AND rate_limited_until <= datetime('now')
  `).run();
  return db.prepare(`
    SELECT * FROM whisk_tokens
    WHERE status = 'active'
    ORDER BY usage_count ASC, sort_order ASC
    LIMIT 1
  `).get();
}

function markTokenUsed(db, tokenId) {
  db.prepare(`
    UPDATE whisk_tokens SET usage_count = usage_count + 1, last_used = CURRENT_TIMESTAMP WHERE id = ?
  `).run(tokenId);
}

function markTokenRateLimited(db, tokenId, errMsg) {
  db.prepare(`
    UPDATE whisk_tokens
    SET status = 'rate_limited',
        last_error = ?,
        rate_limited_until = datetime('now', '+30 seconds')
    WHERE id = ?
  `).run(errMsg, tokenId);
}

// -- Imagen 3 image generation ------------------------------------------------

async function generateViaGemini(apiKey, prompt) {
  const fetch = (await import('node-fetch')).default;

  const res = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio: '16:9' } }),
    }
  );

  if (res.status === 429 || res.status === 403) {
    const text = await res.text();
    throw new Error(`RATE_LIMITED:${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const text = await res.text();
    if (text.includes('PROHIBITED_CONTENT') || text.includes('SAFETY') || text.includes('BLOCKED') || text.includes('blocked')) {
      throw new Error(`UNSAFE_CONTENT:${text.slice(0, 200)}`);
    }
    throw new Error(`GEMINI_ERROR:${res.status}:${text.slice(0, 200)}`);
  }

  const data = await res.json();
  if (data.predictions && data.predictions.length === 0) {
    throw new Error(`UNSAFE_CONTENT:${data.metadata?.filteredReason || 'Safety filter'}`);
  }
  const encoded = data?.predictions?.[0]?.bytesBase64Encoded;
  if (!encoded) return null;
  return Buffer.from(encoded, 'base64');
}

// -- Veo 2 image-to-video generation ------------------------------------------
// Starts a predictLongRunning operation and polls until complete.

async function generateViaVeo(apiKey, imageBuffer, motionPrompt) {
  const fetch = (await import('node-fetch')).default;

  const startRes = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/veo-2.0-generate-001:predictLongRunning',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        instances: [{
          prompt: motionPrompt,
          image: { bytesBase64Encoded: imageBuffer.toString('base64'), mimeType: 'image/jpeg' },
        }],
        parameters: { aspectRatio: '16:9', durationSeconds: 8, sampleCount: 1 },
      }),
    }
  );

  if (startRes.status === 429 || startRes.status === 403) {
    const text = await startRes.text();
    throw new Error(`RATE_LIMITED:${text.slice(0, 200)}`);
  }
  if (!startRes.ok) {
    const text = await startRes.text();
    if (text.includes('PROHIBITED_CONTENT') || text.includes('SAFETY') || text.includes('BLOCKED')) {
      throw new Error(`UNSAFE_CONTENT:${text.slice(0, 200)}`);
    }
    throw new Error(`VEO_ERROR:${startRes.status}:${text.slice(0, 200)}`);
  }

  const operation = await startRes.json();
  const operationName = operation.name;
  if (!operationName) {
    console.log('[veo] Start response (no operation name):', JSON.stringify(operation).slice(0, 500));
    throw new Error('VEO_ERROR: No operation name in response');
  }
  console.log('[veo] Operation started:', operationName);

  // Poll every 10s, max 15 minutes
  for (let i = 0; i < 90; i++) {
    await new Promise(r => setTimeout(r, 10000));

    const pollRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${operationName}`,
      { headers: { 'x-goog-api-key': apiKey } }
    );
    if (!pollRes.ok) {
      const text = await pollRes.text();
      throw new Error(`VEO_POLL_ERROR:${pollRes.status}:${text.slice(0, 200)}`);
    }

    const status = await pollRes.json();
    if (status.error) throw new Error(`VEO_ERROR:${JSON.stringify(status.error).slice(0, 200)}`);
    if (!status.done) { console.log(`[veo] Poll ${i + 1}/90: running...`); continue; }

    console.log('[veo] Operation complete, extracting video...');
    const resp = status.response || {};

    // Shape A: { generateVideoResponse: { generatedSamples: [{ video: { ... } }] } }
    const samples = resp.generateVideoResponse?.generatedSamples || resp.generatedSamples;
    if (samples?.length > 0) {
      const video = samples[0].video || samples[0];
      if (video.bytesBase64Encoded) return Buffer.from(video.bytesBase64Encoded, 'base64');
      if (video.uri) {
        const dl = await fetch(video.uri, { headers: { 'x-goog-api-key': apiKey } });
        if (!dl.ok) throw new Error(`VEO_ERROR: Failed to download video URI: ${dl.status}`);
        return await dl.buffer();
      }
    }
    // Shape B: { predictions: [{ bytesBase64Encoded | videoUri }] }
    const preds = resp.predictions;
    if (preds?.length > 0) {
      if (preds[0].bytesBase64Encoded) return Buffer.from(preds[0].bytesBase64Encoded, 'base64');
      if (preds[0].videoUri) {
        const dl = await fetch(preds[0].videoUri, { headers: { 'x-goog-api-key': apiKey } });
        if (!dl.ok) throw new Error(`VEO_ERROR: Failed to download videoUri: ${dl.status}`);
        return await dl.buffer();
      }
    }

    console.log('[veo] Unexpected done response shape:', JSON.stringify(resp).slice(0, 500));
    throw new Error('VEO_ERROR: Unrecognised response shape — check server logs');
  }

  throw new Error('VEO_ERROR: Operation timed out after 15 minutes');
}

// -- Scene pattern logic -------------------------------------------------------
// Returns true if the scene at sceneIndex should be animated with Veo.

function applyScenePattern(sceneIndex, patternType, patternN, sceneUseVeo) {
  switch (patternType) {
    case 'all_video':       return true;
    case 'alternating':     return sceneIndex % 2 === 1;   // 0=img, 1=vid, 2=img, ...
    case '2_image_1_video': return (sceneIndex + 1) % 3 === 0; // every 3rd
    case 'first_n_video':   return sceneIndex < (patternN || 10);
    case 'custom':          return !!sceneUseVeo;
    default:                return false; // all_image
  }
}

module.exports = {
  getNextToken,
  markTokenUsed,
  markTokenRateLimited,
  generateViaGemini,
  generateViaVeo,
  applyScenePattern,
};
