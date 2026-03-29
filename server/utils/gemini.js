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
// Endpoint confirmed by Dan from Flow network tab:
//   POST https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoText
//
// NOTE: The exact request body structure and polling/retrieval fields are not yet
// fully confirmed. The implementation below is inferred from the Whisk/Flow image
// generation pattern. Dan should capture one successful request/response from Flow's
// network tab to verify: (1) exact body field names, (2) polling endpoint URL,
// (3) done/status field name, and (4) video data location in the final response.

async function generateViaVeo(bearerToken, imageBuffer, motionPrompt) {
  const fetch = (await import('node-fetch')).default;

  // Inferred body structure — Dan should verify against actual Flow network traffic
  const body = {
    clientContext: {
      sessionId: `;${Date.now()}`,
    },
    requests: [{
      prompt: motionPrompt,
      image: {
        bytesBase64Encoded: imageBuffer.toString('base64'),
        mimeType: 'image/jpeg',
      },
      parameters: {
        aspectRatio: '16:9',
        durationSeconds: 8,
        sampleCount: 1,
      },
    }],
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
  console.log('[veo] Job start response:', JSON.stringify(startData).slice(0, 500));

  // Try common operation ID field names — verify from actual response
  const operationId = startData.operationId || startData.name || startData.jobId
    || startData.operations?.[0]?.name || startData.id;

  if (!operationId) {
    throw new Error('VEO_ERROR: No operation ID in response — check server logs for response shape');
  }
  console.log('[veo] Job started:', operationId);

  // Poll every 10s, max 15 minutes (90 polls)
  // Polling URL: if operationId looks like a full path, use it directly; otherwise prefix host
  for (let i = 0; i < 90; i++) {
    await new Promise(r => setTimeout(r, 10000));

    const pollUrl = String(operationId).startsWith('http')
      ? operationId
      : `https://aisandbox-pa.googleapis.com/v1/${operationId}`;

    const pollRes = await fetch(pollUrl, {
      headers: {
        'Authorization': `Bearer ${bearerToken}`,
        'origin': 'https://labs.google',
        'referer': 'https://labs.google/',
      },
    });

    if (!pollRes.ok) {
      const text = await pollRes.text();
      throw new Error(`VEO_POLL_ERROR:${pollRes.status}:${text.slice(0, 200)}`);
    }

    const status = await pollRes.json();
    if (status.error) throw new Error(`VEO_ERROR:${JSON.stringify(status.error).slice(0, 200)}`);

    // Check for completion — verify field name from actual polling response
    const isDone = status.done === true
      || status.status === 'COMPLETE'
      || status.status === 'SUCCEEDED'
      || status.state === 'DONE';

    if (!isDone) {
      console.log(`[veo] Poll ${i + 1}/90: running... state=${status.status || status.state || status.done}`);
      continue;
    }

    console.log('[veo] Job complete, extracting video...');
    // Log full response on first success so Dan can verify/tighten the extraction below
    console.log('[veo] Full done response:', JSON.stringify(status).slice(0, 1000));

    const resp = status.response || status;

    // Try various response shapes — tighten once actual shape is confirmed
    const samples = resp.generateVideoResponse?.generatedSamples
      || resp.generatedSamples
      || resp.videos
      || resp.media;

    if (samples?.length > 0) {
      const video = samples[0].video || samples[0];
      if (video.bytesBase64Encoded) return Buffer.from(video.bytesBase64Encoded, 'base64');
      const videoUrl = video.uri || video.videoUri || video.url || video.downloadUri;
      if (videoUrl) {
        const dl = await fetch(videoUrl, { headers: { 'Authorization': `Bearer ${bearerToken}` } });
        if (!dl.ok) throw new Error(`VEO_ERROR: Failed to download video: ${dl.status}`);
        return await dl.buffer();
      }
    }

    const preds = resp.predictions || resp.results;
    if (preds?.length > 0) {
      if (preds[0].bytesBase64Encoded) return Buffer.from(preds[0].bytesBase64Encoded, 'base64');
      const videoUrl = preds[0].videoUri || preds[0].uri || preds[0].url;
      if (videoUrl) {
        const dl = await fetch(videoUrl, { headers: { 'Authorization': `Bearer ${bearerToken}` } });
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
