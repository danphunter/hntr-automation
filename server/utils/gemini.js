// Shared API utilities used by both generate.js and render.js
const { v4: uuidv4 } = require('uuid');

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

async function generateViaGemini(bearerToken, prompt) {
  const fetch = (await import('node-fetch')).default;

  const res = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${bearerToken}` },
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

// -- Veo video generation via aisandbox-pa.googleapis.com ---------------------
// Confirmed endpoint (captured by Dan from Flow network tab):
//   POST https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoText
//
// Request body structure partially confirmed. Fields still needing verification
// from Dan's network tab:
//   - Image field name inside requests[] (guessing "image" with base64)
//   - Prompt field name inside requests[] (guessing "structuredPrompt" matching Flow image gen)
//   - Polling endpoint/method — TODO: capture status check request from network tab
//   - Done condition field name in poll response
//   - Video data location in final response

async function generateViaVeo(bearerToken, imageBuffer, motionPrompt) {
  const fetch = (await import('node-fetch')).default;
  const batchId = uuidv4();

  // Request body — top-level structure confirmed; requests[] fields are inferred
  const body = {
    mediaGenerationContext: {
      batchId,
    },
    clientContext: {
      projectId: 'b998a407-4f9a-4b0c-9bc9-f2fae2a5a077',
      tool: 'PINHOLE',
    },
    requests: [{
      aspectRatio: 'VIDEO_ASPECT_RATIO_PORTRAIT',
      seed: Math.floor(Math.random() * 1000000),
      // Image source — field name needs verification; "image" matches Flow image gen pattern
      image: {
        bytesBase64Encoded: imageBuffer.toString('base64'),
        mimeType: 'image/jpeg',
      },
      // Prompt — "structuredPrompt" matches the Flow image gen request format
      // TODO: Dan — verify this field name from the captured network request body
      structuredPrompt: {
        parts: [{ text: motionPrompt }],
      },
    }],
    useV2ModelConfig: true,
  };

  const startRes = await fetch(
    'https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoText',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${bearerToken}`,
        'origin': 'https://labs.google',
        'referer': 'https://labs.google/',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: JSON.stringify(body),
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

  const startData = await startRes.json();
  console.log('[veo] Job submitted (batchId=%s) response:', batchId, JSON.stringify(startData).slice(0, 500));

  // TODO: Capture the status-check request from Flow's network tab to confirm:
  //   (a) The polling URL/method
  //   (b) Whether it uses batchId or an operation ID from the start response
  //   (c) The done-state field name
  //
  // Best guess: POST .../video:batchGetVideoStatus with { "batchIds": [batchId] }
  // Polling every 10s, max 15 minutes (90 polls)

  const POLL_URL = 'https://aisandbox-pa.googleapis.com/v1/video:batchGetVideoStatus';
  const POLL_HEADERS = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${bearerToken}`,
    'origin': 'https://labs.google',
    'referer': 'https://labs.google/',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  };

  for (let i = 0; i < 90; i++) {
    await new Promise(r => setTimeout(r, 10000));

    const pollRes = await fetch(POLL_URL, {
      method: 'POST',
      headers: POLL_HEADERS,
      body: JSON.stringify({ batchIds: [batchId] }),
    });

    if (!pollRes.ok) {
      const text = await pollRes.text();
      throw new Error(`VEO_POLL_ERROR:${pollRes.status}:${text.slice(0, 200)}`);
    }

    const pollData = await pollRes.json();
    if (pollData.error) throw new Error(`VEO_ERROR:${JSON.stringify(pollData.error).slice(0, 200)}`);

    // Locate this batch in the poll response — try common shapes
    const batchEntry = pollData.batches?.[0]
      || pollData.results?.[0]
      || pollData.statuses?.[0]
      || pollData;

    const isDone = batchEntry.done === true
      || batchEntry.status === 'COMPLETE'
      || batchEntry.status === 'SUCCEEDED'
      || batchEntry.state === 'DONE'
      || batchEntry.state === 'SUCCEEDED';

    if (!isDone) {
      const state = batchEntry.status || batchEntry.state || batchEntry.done;
      console.log(`[veo] Poll ${i + 1}/90: running... state=${state}`);
      continue;
    }

    console.log('[veo] Job complete. Full response:', JSON.stringify(pollData).slice(0, 1000));

    // Extract video — log the full shape above so Dan can tighten this once confirmed
    const resp = batchEntry.response || batchEntry;

    const candidates = [
      ...(resp.videos || []),
      ...(resp.media || []),
      ...(resp.generatedSamples || []),
      ...(resp.generateVideoResponse?.generatedSamples || []),
      ...(resp.results || []),
      ...(resp.predictions || []),
    ];

    for (const item of candidates) {
      const vid = item.video || item;
      if (vid.bytesBase64Encoded) return Buffer.from(vid.bytesBase64Encoded, 'base64');
      const url = vid.uri || vid.videoUri || vid.url || vid.downloadUri || item.videoUri || item.uri;
      if (url) {
        const dl = await fetch(url, { headers: { 'Authorization': `Bearer ${bearerToken}` } });
        if (!dl.ok) throw new Error(`VEO_ERROR: Failed to download video: ${dl.status}`);
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
