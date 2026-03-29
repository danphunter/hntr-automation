const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
const UPLOADS_BASE = process.env.UPLOADS_PATH || path.join(__dirname, '..', 'uploads');
const IMAGES_DIR = path.join(UPLOADS_BASE, 'images');
const VIDEOS_DIR = path.join(UPLOADS_BASE, 'videos');
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });
if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });

// Legacy constants kept for backward compatibility with existing whisk/flow provider settings
const RECAPTCHA_SITE_KEY = '6Lf4cposAAAAAGKXuD1jmpAmr4Yf0kGTq_AGLxtz';
const FLOW_PROJECT_ID_DEFAULT = '0b18c780-3509-4d6e-84c6-dc4528e2b92b';

function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

// -- Prompt sanitization (kept for whisk/flow backward compat) -----------------

const WHISK_WORD_REPLACEMENTS = {
  'blood': 'red mist', 'bloody': 'dramatic', 'gore': 'detail', 'gory': 'intense',
  'dead': 'still', 'death': 'stillness', 'die': 'fade', 'dying': 'fading',
  'kill': 'halt', 'killing': 'halting', 'killer': 'figure', 'killed': 'fallen',
  'murder': 'mystery', 'murdered': 'fallen', 'murderer': 'shadowy figure',
  'war': 'conflict', 'warfare': 'struggle', 'battle': 'encounter', 'battles': 'encounters',
  'combat': 'action', 'fight': 'confrontation', 'fighting': 'confrontation',
  'attack': 'approach', 'attacked': 'confronted', 'assault': 'rush', 'assaulted': 'rushed',
  'violence': 'intensity', 'violent': 'intense',
  'destroy': 'transform', 'destruction': 'transformation', 'destroyed': 'transformed',
  'weapon': 'instrument', 'weapons': 'instruments', 'armed': 'equipped',
  'gun': 'device', 'guns': 'devices', 'rifle': 'long instrument', 'pistol': 'device',
  'sword': 'blade', 'knife': 'tool', 'dagger': 'implement', 'spear': 'long tool',
  'bomb': 'sphere', 'explosion': 'burst of light', 'explosive': 'powerful', 'blast': 'wave of light',
  'military': 'organized', 'soldier': 'figure', 'soldiers': 'figures', 'warrior': 'figure', 'warriors': 'figures',
  'troops': 'people', 'army': 'group', 'nuclear': 'powerful', 'missile': 'craft',
  'skull': 'stone carving', 'skeleton': 'ancient structure', 'corpse': 'still figure',
  'wound': 'mark', 'wounded': 'weathered', 'bleeding': 'glowing', 'scar': 'mark',
  'torture': 'ordeal', 'execution': 'ceremony', 'massacre': 'upheaval',
};

function sanitizePrompt(prompt) {
  let sanitized = prompt;
  for (const [word, replacement] of Object.entries(WHISK_WORD_REPLACEMENTS)) {
    sanitized = sanitized.replace(new RegExp(`\\b${word}\\b`, 'gi'), replacement);
  }
  if (!/^(a |an )?(digital|cinematic|artistic|photographic|illustration|painting|dramatic)/i.test(sanitized.trim())) {
    sanitized = `A cinematic still of ${sanitized}`;
  }
  return sanitized.trim();
}

function makeSimpleFallbackPrompt(prompt) {
  const stripped = prompt
    .replace(/[^a-zA-Z0-9\s,]/g, '')
    .replace(/\b\w{1,2}\b/g, '')
    .trim()
    .slice(0, 80);
  return `A digital illustration of ${stripped}, dramatic lighting, cinematic composition`;
}

// -- Token rotation ------------------------------------------------------------

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

// -- Gemini API (Imagen 3) -----------------------------------------------------

async function generateViaGemini(apiKey, prompt) {
  const fetch = (await import('node-fetch')).default;

  const body = {
    instances: [{ prompt }],
    parameters: {
      sampleCount: 1,
      aspectRatio: '16:9',
    },
  };

  const res = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
    }
  );

  if (res.status === 429) {
    const text = await res.text();
    console.log('Gemini rate-limited:', res.status, text.slice(0, 500));
    throw new Error(`RATE_LIMITED:${text.slice(0, 200)}`);
  }

  if (res.status === 403) {
    const text = await res.text();
    console.log('Gemini forbidden (bad key or quota):', res.status, text.slice(0, 500));
    throw new Error(`RATE_LIMITED:${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    const text = await res.text();
    console.log('Gemini error:', res.status, text.slice(0, 500));
    if (
      text.includes('PROHIBITED_CONTENT') ||
      text.includes('SAFETY') ||
      text.includes('BLOCKED') ||
      text.includes('blocked')
    ) {
      throw new Error(`UNSAFE_CONTENT:${text.slice(0, 200)}`);
    }
    throw new Error(`GEMINI_ERROR:${res.status}:${text.slice(0, 200)}`);
  }

  const data = await res.json();

  // Empty predictions array means safety filter blocked the prompt
  if (data.predictions && data.predictions.length === 0) {
    const reason = data.metadata?.filteredReason || 'Safety filter';
    throw new Error(`UNSAFE_CONTENT:${reason}`);
  }

  const encoded = data?.predictions?.[0]?.bytesBase64Encoded;
  if (!encoded) {
    console.log('Gemini response missing bytesBase64Encoded:', JSON.stringify(data).slice(0, 500));
    return null;
  }
  return Buffer.from(encoded, 'base64');
}

// -- Gemini API (Veo 2) --------------------------------------------------------
// Uses predictLongRunning for async video generation, then polls until done.
// The generated image is passed as a base64-encoded frame to drive image-to-video.

async function generateViaVeo(apiKey, imageBuffer, motionPrompt) {
  const fetch = (await import('node-fetch')).default;

  const body = {
    instances: [{
      prompt: motionPrompt,
      image: {
        bytesBase64Encoded: imageBuffer.toString('base64'),
        mimeType: 'image/jpeg',
      },
    }],
    parameters: {
      aspectRatio: '16:9',
      durationSeconds: 8,
      sampleCount: 1,
    },
  };

  // Start the long-running operation
  const startRes = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/veo-2.0-generate-001:predictLongRunning',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
    }
  );

  if (startRes.status === 429) {
    const text = await startRes.text();
    console.log('Veo rate-limited:', startRes.status, text.slice(0, 500));
    throw new Error(`RATE_LIMITED:${text.slice(0, 200)}`);
  }

  if (startRes.status === 403) {
    const text = await startRes.text();
    console.log('Veo forbidden:', startRes.status, text.slice(0, 500));
    throw new Error(`RATE_LIMITED:${text.slice(0, 200)}`);
  }

  if (!startRes.ok) {
    const text = await startRes.text();
    console.log('Veo start error:', startRes.status, text.slice(0, 500));
    if (text.includes('PROHIBITED_CONTENT') || text.includes('SAFETY') || text.includes('BLOCKED')) {
      throw new Error(`UNSAFE_CONTENT:${text.slice(0, 200)}`);
    }
    throw new Error(`VEO_ERROR:${startRes.status}:${text.slice(0, 200)}`);
  }

  const operation = await startRes.json();
  const operationName = operation.name;
  if (!operationName) {
    console.log('Veo start response (no operation name):', JSON.stringify(operation).slice(0, 500));
    throw new Error('VEO_ERROR: No operation name returned');
  }

  console.log('[veo] Operation started:', operationName);

  // Poll until done — max 15 minutes (90 polls × 10s)
  const MAX_POLLS = 90;
  for (let i = 0; i < MAX_POLLS; i++) {
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

    if (status.error) {
      throw new Error(`VEO_ERROR:${JSON.stringify(status.error).slice(0, 200)}`);
    }

    if (!status.done) {
      console.log(`[veo] Poll ${i + 1}/${MAX_POLLS}: still running...`);
      continue;
    }

    console.log('[veo] Operation complete, extracting video...');

    // Handle both possible response shapes
    const response = status.response || {};

    // Shape A: { generateVideoResponse: { generatedSamples: [{ video: {...} }] } }
    // Shape B: { predictions: [{ bytesBase64Encoded, mimeType }] }
    const samples = response.generateVideoResponse?.generatedSamples
      || response.generatedSamples;

    if (samples && samples.length > 0) {
      const video = samples[0].video || samples[0];
      if (video.bytesBase64Encoded) {
        return Buffer.from(video.bytesBase64Encoded, 'base64');
      }
      if (video.uri) {
        const vidRes = await fetch(video.uri, {
          headers: { 'x-goog-api-key': apiKey },
        });
        if (!vidRes.ok) throw new Error(`Failed to download video from URI: ${vidRes.status}`);
        return await vidRes.buffer();
      }
    }

    const predictions = response.predictions;
    if (predictions && predictions.length > 0) {
      const pred = predictions[0];
      if (pred.bytesBase64Encoded) return Buffer.from(pred.bytesBase64Encoded, 'base64');
      if (pred.videoUri) {
        const vidRes = await fetch(pred.videoUri, { headers: { 'x-goog-api-key': apiKey } });
        if (!vidRes.ok) throw new Error(`Failed to download video: ${vidRes.status}`);
        return await vidRes.buffer();
      }
    }

    console.log('[veo] Unexpected done response shape:', JSON.stringify(response).slice(0, 500));
    throw new Error('VEO_ERROR: Unrecognised response shape — check server logs');
  }

  throw new Error('VEO_ERROR: Operation timed out after 15 minutes');
}

// -- Whisk API (legacy) --------------------------------------------------------

async function generateViaWhisk(bearerToken, prompt) {
  const fetch = (await import('node-fetch')).default;

  const body = {
    clientContext: {
      workflowId: uuidv4(),
      tool: 'BACKBONE',
      sessionId: `;${Date.now()}`,
    },
    imageModelSettings: {
      imageModel: 'IMAGEN_3_5',
      aspectRatio: 'IMAGE_ASPECT_RATIO_LANDSCAPE',
    },
    seed: Math.floor(Math.random() * 1000000),
    prompt,
    mediaCategory: 'MEDIA_CATEGORY_BOARD',
  };

  const res = await fetch('https://aisandbox-pa.googleapis.com/v1/whisk:generateImage', {
    method: 'POST',
    headers: {
      'accept': '*/*',
      'authorization': 'Bearer ' + bearerToken,
      'content-type': 'application/json',
      'origin': 'https://labs.google',
      'referer': 'https://labs.google/',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    body: JSON.stringify(body),
  });

  if (res.status === 429 || res.status === 403) {
    const text = await res.text();
    throw new Error(`RATE_LIMITED:${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const text = await res.text();
    if (text.includes('PUBLIC_ERROR_UNSAFE_GENERATION') || text.includes('SAFETY') || text.includes('BLOCKED')) {
      throw new Error(`UNSAFE_CONTENT:${text.slice(0, 200)}`);
    }
    throw new Error(`WHISK_ERROR:${res.status}:${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const encodedImage = data?.imagePanels?.[0]?.generatedImages?.[0]?.encodedImage;
  if (!encodedImage) return null;
  return Buffer.from(encodedImage, 'base64');
}

// -- Flow API (legacy) ---------------------------------------------------------

async function generateViaFlow(bearerToken, recaptchaToken, prompt, referenceIds, flowProjectId) {
  const fetch = (await import('node-fetch')).default;
  const clientContext = {
    ...(recaptchaToken ? { recaptchaContext: { token: recaptchaToken, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' } } : {}),
    projectId: flowProjectId,
    tool: 'PINHOLE',
    sessionId: `;${Date.now()}`,
  };
  const body = {
    clientContext,
    mediaGenerationContext: { batchId: uuidv4() },
    useNewMedia: true,
    requests: [{
      clientContext,
      imageModelName: 'NARWHAL',
      imageAspectRatio: 'IMAGE_ASPECT_RATIO_LANDSCAPE',
      structuredPrompt: { parts: [{ text: prompt }] },
      seed: Math.floor(Math.random() * 1000000),
      imageInputs: (referenceIds || []).map(id => ({ imageInputType: 'IMAGE_INPUT_TYPE_REFERENCE', name: id })),
    }],
  };
  const res = await fetch(
    `https://aisandbox-pa.googleapis.com/v1/projects/${flowProjectId}/flowMedia:batchGenerateImages`,
    {
      method: 'POST',
      headers: {
        'accept': '*/*',
        'authorization': 'Bearer ' + bearerToken,
        'content-type': 'application/json',
        'origin': 'https://labs.google',
        'referer': 'https://labs.google/',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: JSON.stringify(body),
    }
  );
  if (res.status === 429 || res.status === 403) {
    const text = await res.text();
    throw new Error(`RATE_LIMITED:${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const text = await res.text();
    if (text.includes('PUBLIC_ERROR_UNSAFE_GENERATION')) throw new Error(`UNSAFE_CONTENT:${text.slice(0, 200)}`);
    throw new Error(`FLOW_ERROR:${res.status}:${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const fifeUrl = data?.media?.[0]?.image?.generatedImage?.fifeUrl;
  if (!fifeUrl) return null;
  const imgRes = await fetch(fifeUrl);
  if (!imgRes.ok) throw new Error(`Failed to download image from fifeUrl: ${imgRes.status}`);
  return await imgRes.buffer();
}

async function saveImageFromBuffer(buffer) {
  const filename = `img-${uuidv4()}.jpg`;
  const imgPath = path.join(IMAGES_DIR, filename);
  fs.writeFileSync(imgPath, buffer);
  return { filename, imgPath };
}

// -- Routes --------------------------------------------------------------------

// GET /api/generate/flow-config
router.get('/flow-config', authMiddleware, (req, res) => {
  const db = getDb();
  const settings = getSettings(db);
  const flowProjectId = settings.flow_project_id || process.env.FLOW_PROJECT_ID || FLOW_PROJECT_ID_DEFAULT || null;
  const imageProvider = settings.image_provider || 'gemini';
  const veoEnabled = settings.veo_enabled === 'true' || settings.veo_enabled === '1';
  const wt = getNextToken(db);
  res.json({
    flowProjectId,
    siteKey: RECAPTCHA_SITE_KEY,
    hasToken: !!wt,
    imageProvider,
    veoEnabled,
    bearerToken: (imageProvider !== 'gemini' && wt?.token) ? wt.token : null,
  });
});

// POST /api/generate/save-image
router.post('/save-image', authMiddleware, async (req, res) => {
  const { sceneId, fifeUrl } = req.body;
  if (!sceneId || !fifeUrl) return res.status(400).json({ error: 'sceneId and fifeUrl required' });
  const db = getDb();
  const scene = db.prepare('SELECT * FROM scenes WHERE id = ?').get(sceneId);
  if (!scene) return res.status(404).json({ error: 'Scene not found' });
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(scene.project_id);
  if (req.user.role !== 'admin' && project.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });
  try {
    const fetch = (await import('node-fetch')).default;
    const imgRes = await fetch(fifeUrl);
    if (!imgRes.ok) return res.status(502).json({ error: `Failed to download image: ${imgRes.status}` });
    const buffer = await imgRes.buffer();
    const { filename, imgPath } = await saveImageFromBuffer(buffer);
    const localUrl = `/api/generate/image-file/${filename}`;
    db.prepare('UPDATE scenes SET image_url = ?, image_path = ?, status = ? WHERE id = ?').run(localUrl, imgPath, 'generated', scene.id);
    res.json({ image_url: localUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/generate/image/:sceneId
router.post('/image/:sceneId', authMiddleware, async (req, res) => {
  const db = getDb();
  const scene = db.prepare('SELECT * FROM scenes WHERE id = ?').get(req.params.sceneId);
  if (!scene) return res.status(404).json({ error: 'Scene not found' });
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(scene.project_id);
  if (req.user.role !== 'admin' && project.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

  const settings = getSettings(db);
  const imageProvider = settings.image_provider || 'gemini';
  const flowProjectId = settings.flow_project_id || process.env.FLOW_PROJECT_ID || FLOW_PROJECT_ID_DEFAULT;
  const { recaptchaToken } = req.body;

  let rawPrompt = scene.image_prompt || scene.text;
  let referenceIds = [];
  if (project.style_id) {
    const style = db.prepare('SELECT * FROM styles WHERE id = ?').get(project.style_id);
    if (style) {
      rawPrompt = `${style.prompt_prefix} ${rawPrompt} ${style.prompt_suffix}`.trim();
      if (imageProvider === 'flow') {
        const refs = db.prepare('SELECT flow_media_id FROM style_references WHERE style_id = ? AND flow_media_id IS NOT NULL').all(project.style_id);
        referenceIds = refs.map(r => r.flow_media_id);
      }
    }
  }

  let prompt = imageProvider === 'whisk' ? sanitizePrompt(rawPrompt) : rawPrompt;
  let imageBuffer = null;
  let source = 'unknown';
  let triedCount = 0;
  let unsafeContentRetried = false;

  while (true) {
    const wt = getNextToken(db);
    if (!wt) {
      const cooldown = db.prepare(`SELECT MIN(CAST((julianday(rate_limited_until) - julianday('now')) * 86400 AS INTEGER)) as secs FROM whisk_tokens WHERE status = 'rate_limited' AND rate_limited_until IS NOT NULL`).get();
      const retrySecs = cooldown?.secs != null ? Math.max(0, cooldown.secs) : null;
      const msg = triedCount === 0 ? 'No active API keys — add a Gemini API key in Settings' : 'All API keys are rate-limited — add a fresh key in Settings';
      return res.status(429).json({ error: msg, retry_after: retrySecs });
    }
    triedCount++;
    try {
      let buffer;
      if (imageProvider === 'gemini') {
        buffer = await generateViaGemini(wt.token.trim(), prompt);
      } else if (imageProvider === 'flow') {
        buffer = await generateViaFlow(wt.token.trim(), recaptchaToken, prompt, referenceIds, flowProjectId);
      } else {
        buffer = await generateViaWhisk(wt.token.trim(), prompt);
      }
      if (buffer) { markTokenUsed(db, wt.id); imageBuffer = buffer; source = `${imageProvider}:${wt.label}`; break; }
      markTokenRateLimited(db, wt.id, `Empty response from ${imageProvider}`);
    } catch (err) {
      if (err.message.startsWith('RATE_LIMITED')) {
        markTokenRateLimited(db, wt.id, err.message.slice(12));
        console.log(`Key "${wt.label}" rate limited, rotating...`);
      } else if (err.message.startsWith('UNSAFE_CONTENT') && !unsafeContentRetried) {
        console.warn(`Safety filter triggered, retrying with fallback prompt`);
        unsafeContentRetried = true;
        prompt = makeSimpleFallbackPrompt(rawPrompt);
        triedCount--;
        continue;
      } else {
        markTokenRateLimited(db, wt.id, err.message);
        console.error(`Key "${wt.label}" error:`, err.message);
      }
    }
    const totalTokens = db.prepare('SELECT COUNT(*) as c FROM whisk_tokens').get().c;
    if (triedCount >= totalTokens) break;
  }

  if (!imageBuffer) {
    const cooldown = db.prepare(`SELECT MIN(CAST((julianday(rate_limited_until) - julianday('now')) * 86400 AS INTEGER)) as secs FROM whisk_tokens WHERE status = 'rate_limited' AND rate_limited_until IS NOT NULL`).get();
    const retrySecs = cooldown?.secs != null ? Math.max(0, cooldown.secs) : null;
    return res.status(429).json({ error: 'All API keys are rate-limited or exhausted — add a fresh key in Settings', retry_after: retrySecs });
  }

  const { filename, imgPath } = await saveImageFromBuffer(imageBuffer);
  const localUrl = `/api/generate/image-file/${filename}`;
  db.prepare('UPDATE scenes SET image_url = ?, image_path = ?, status = ? WHERE id = ?').run(localUrl, imgPath, 'generated', scene.id);
  res.json({ image_url: localUrl, prompt, source });
});

// GET /api/generate/image-file/:filename
router.get('/image-file/:filename', (req, res) => {
  const imgPath = path.join(IMAGES_DIR, path.basename(req.params.filename));
  if (!imgPath.startsWith(IMAGES_DIR)) return res.status(404).json({ error: 'Not found' });
  if (!fs.existsSync(imgPath)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(imgPath);
});

// POST /api/generate/video/:sceneId — animate a scene image with Veo
router.post('/video/:sceneId', authMiddleware, async (req, res) => {
  const db = getDb();
  const scene = db.prepare('SELECT * FROM scenes WHERE id = ?').get(req.params.sceneId);
  if (!scene) return res.status(404).json({ error: 'Scene not found' });
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(scene.project_id);
  if (req.user.role !== 'admin' && project.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

  if (!scene.image_url && !scene.image_path) {
    return res.status(400).json({ error: 'Generate an image for this scene first' });
  }

  // Load the generated image from disk
  let imageBuffer;
  try {
    const imgFilename = path.basename(scene.image_url || scene.image_path || '');
    const imgPath = path.join(IMAGES_DIR, imgFilename);
    if (!fs.existsSync(imgPath)) return res.status(404).json({ error: 'Image file not found on disk' });
    imageBuffer = fs.readFileSync(imgPath);
  } catch (err) {
    return res.status(500).json({ error: `Failed to read image: ${err.message}` });
  }

  // Build a motion prompt that matches the style's slow_pan preference
  const style = project.style_id ? db.prepare('SELECT * FROM styles WHERE id = ?').get(project.style_id) : null;
  const slowPan = style?.slow_pan === 1 || style?.slow_pan === true;
  const motionPrompt = slowPan
    ? 'Cinematic slow camera pan across the scene, smooth parallax depth, atmospheric mood, photorealistic motion, no text'
    : 'Gentle cinematic camera movement, subtle zoom and atmospheric motion, high quality, photorealistic, no text';

  // Rotate through API keys (same pool as image generation)
  let videoBuffer = null;
  let triedCount = 0;

  while (true) {
    const wt = getNextToken(db);
    if (!wt) {
      const msg = triedCount === 0
        ? 'No active API keys — add a Gemini API key in Settings'
        : 'All API keys are rate-limited — try again shortly';
      return res.status(429).json({ error: msg });
    }
    triedCount++;
    try {
      const buf = await generateViaVeo(wt.token.trim(), imageBuffer, motionPrompt);
      if (buf) { markTokenUsed(db, wt.id); videoBuffer = buf; break; }
      markTokenRateLimited(db, wt.id, 'Empty response from Veo');
    } catch (err) {
      if (err.message.startsWith('RATE_LIMITED')) {
        markTokenRateLimited(db, wt.id, err.message.slice(12));
        console.log(`Key "${wt.label}" Veo rate limited, rotating...`);
      } else {
        // Non-retryable errors (safety, timeout, bad response) — mark and stop
        markTokenRateLimited(db, wt.id, err.message);
        console.error(`Key "${wt.label}" Veo error:`, err.message);
        // Only rotate for rate-limit errors; abort for other errors
        return res.status(500).json({ error: `Veo generation failed: ${err.message}` });
      }
    }
    const total = db.prepare('SELECT COUNT(*) as c FROM whisk_tokens').get().c;
    if (triedCount >= total) break;
  }

  if (!videoBuffer) {
    return res.status(429).json({ error: 'All API keys are rate-limited for Veo — try again shortly' });
  }

  const filename = `vid-${uuidv4()}.mp4`;
  const vidPath = path.join(VIDEOS_DIR, filename);
  fs.writeFileSync(vidPath, videoBuffer);
  const localUrl = `/api/generate/video-file/${filename}`;

  db.prepare('UPDATE scenes SET video_url = ?, video_path = ?, video_status = ? WHERE id = ?')
    .run(localUrl, vidPath, 'generated', scene.id);

  res.json({ video_url: localUrl });
});

// GET /api/generate/video-file/:filename
router.get('/video-file/:filename', (req, res) => {
  const vidPath = path.join(VIDEOS_DIR, path.basename(req.params.filename));
  if (!vidPath.startsWith(VIDEOS_DIR)) return res.status(404).json({ error: 'Not found' });
  if (!fs.existsSync(vidPath)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(vidPath);
});

// POST /api/generate/prompts/:projectId
router.post('/prompts/:projectId', authMiddleware, async (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && project.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

  const scenes = db.prepare('SELECT * FROM scenes WHERE project_id = ? ORDER BY scene_order').all(req.params.projectId);
  const settings = getSettings(db);
  const apiKey = settings.openai_api_key?.trim();

  let styleContext = '';
  if (project.style_id) {
    const style = db.prepare('SELECT * FROM styles WHERE id = ?').get(project.style_id);
    if (style) styleContext = `Visual style: ${style.name}. ${style.description}`;
  }

  if (!apiKey) {
    const updated = scenes.map(scene => {
      const stylePrefix = styleContext ? `${styleContext}, ` : '';
      const prompt = `${stylePrefix}cinematic scene, dramatic lighting, high detail, photorealistic, 16:9 widescreen, no text, no words`;
      db.prepare('UPDATE scenes SET image_prompt = ? WHERE id = ?').run(prompt, scene.id);
      return { id: scene.id, image_prompt: prompt };
    });
    return res.json({ scenes: updated, demo: true });
  }

  const systemPrompt = [
    'You are an expert at writing image generation prompts for AI art tools like Stable Diffusion and Imagen.',
    styleContext ? `Style context: ${styleContext}` : '',
    '',
    'Your job is to translate spoken narration into a vivid VISUAL scene description.',
    'Rules:',
    '- Describe what would be SEEN in the image, never what is being SAID',
    '- Never include any text, words, letters, captions, subtitles, or narration in the prompt',
    '- Be specific: subjects, environment, lighting, mood, camera angle, time of day',
    '- Keep under 100 words',
    '- Return ONLY the image prompt, no explanation or preamble',
  ].filter(Boolean).join('\n');

  const fetch = (await import('node-fetch')).default;
  const updated = [];
  for (const scene of scenes) {
    try {
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Narration: "${scene.text}"\n\nWrite a visual image prompt for what should be shown on screen during this narration.` },
          ],
          max_tokens: 150,
        }),
      });
      const data = await resp.json();
      if (data.error) {
        console.error('[prompts] OpenAI error:', data.error);
        return res.status(400).json({ error: `OpenAI: ${data.error.message || data.error.code || 'Unknown error'}` });
      }
      const prompt = data.choices?.[0]?.message?.content?.trim() || '';
      db.prepare('UPDATE scenes SET image_prompt = ? WHERE id = ?').run(prompt, scene.id);
      updated.push({ id: scene.id, image_prompt: prompt });
    } catch (err) {
      console.error('[prompts] fetch error:', err.message);
      return res.status(500).json({ error: `Prompt generation failed: ${err.message}` });
    }
  }
  res.json({ scenes: updated, demo: false });
});

// -- API Key Management --------------------------------------------------------

router.get('/whisk-tokens', authMiddleware, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const db = getDb();
  const tokens = db.prepare('SELECT id, label, usage_count, status, last_used, last_error, rate_limited_until, sort_order, created_at FROM whisk_tokens ORDER BY sort_order ASC, created_at ASC').all();
  res.json(tokens);
});

router.post('/whisk-tokens', authMiddleware, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { label, token } = req.body;
  if (!label || !token) return res.status(400).json({ error: 'label and token required' });
  const cleanToken = token.trim().replace(/^Bearer\s+/i, '');
  const db = getDb();
  const id = uuidv4();
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as m FROM whisk_tokens').get().m;
  db.prepare('INSERT INTO whisk_tokens (id, label, token, sort_order) VALUES (?, ?, ?, ?)').run(id, label, cleanToken, maxOrder + 1);
  res.status(201).json({ id, label, usage_count: 0, status: 'active', sort_order: maxOrder + 1 });
});

router.put('/whisk-tokens/:id', authMiddleware, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const db = getDb();
  const { label, status } = req.body;
  const cleanToken = req.body.token ? req.body.token.trim().replace(/^Bearer\s+/i, '') : undefined;
  db.prepare('UPDATE whisk_tokens SET label = COALESCE(?, label), token = COALESCE(?, token), status = COALESCE(?, status) WHERE id = ?').run(label, cleanToken, status, req.params.id);
  const t = db.prepare('SELECT id, label, usage_count, status, last_used, last_error, rate_limited_until, sort_order FROM whisk_tokens WHERE id = ?').get(req.params.id);
  res.json(t);
});

router.delete('/whisk-tokens/:id', authMiddleware, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const db = getDb();
  db.prepare('DELETE FROM whisk_tokens WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

router.post('/whisk-tokens/:id/reset', authMiddleware, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const db = getDb();
  db.prepare("UPDATE whisk_tokens SET status = 'active', last_error = NULL WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
