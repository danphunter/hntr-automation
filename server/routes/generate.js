const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
const UPLOADS_BASE = process.env.UPLOADS_PATH || path.join(__dirname, '..', 'uploads');
const IMAGES_DIR = path.join(UPLOADS_BASE, 'images');
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

const RECAPTCHA_SITE_KEY = '6Lf4cposAAAAAGKXuD1jmpAmr4Yf0kGTq_AGLxtz';
// Default Flow project ID captured from labs.google â can be overridden via settings/env
const FLOW_PROJECT_ID_DEFAULT = '0b18c780-3509-4d6e-84c6-dc4528e2b92b';

function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

// ââ Prompt sanitization âââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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

// ââ Token rotation ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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

// ââ Whisk API ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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
      'accept-language': 'en-US,en;q=0.9',
      'authorization': 'Bearer ' + bearerToken,
      'content-type': 'application/json',
      'origin': 'https://labs.google',
      'referer': 'https://labs.google/',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    },
    body: JSON.stringify(body),
  });

  if (res.status === 429 || res.status === 403) {
    const text = await res.text();
    console.log('Whisk rate-limited/forbidden:', res.status, text.slice(0, 500));
    throw new Error(`RATE_LIMITED:${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    const text = await res.text();
    console.log('Whisk error:', res.status, text.slice(0, 500));
    if (text.includes('PUBLIC_ERROR_UNSAFE_GENERATION') || text.includes('SAFETY') || text.includes('BLOCKED')) {
      throw new Error(`UNSAFE_CONTENT:${text.slice(0, 200)}`);
    }
    throw new Error(`WHISK_ERROR:${res.status}:${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const encodedImage = data?.imagePanels?.[0]?.generatedImages?.[0]?.encodedImage;
  if (!encodedImage) {
    console.log('Whisk response missing encodedImage:', JSON.stringify(data).slice(0, 500));
    return null;
  }
  return Buffer.from(encodedImage, 'base64');
}

// ââ Flow API (Google AI Sandbox) ââââââââââââââââââââââââââââââââââââââââââââââ
// The extension obtains a reCAPTCHA Enterprise token from the labs.google tab,
// makes the Flow API call there (satisfying CORS), and returns the fifeUrl.
// The server-side route below (/image/:sceneId) is an alternate path that
// accepts a pre-obtained recaptchaToken and calls the Flow API server-side.

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
      imageInputs: (referenceIds || []).map(id => ({
        imageInputType: 'IMAGE_INPUT_TYPE_REFERENCE',
        name: id,
      })),
    }],
  };

  const res = await fetch(
    `https://aisandbox-pa.googleapis.com/v1/projects/${flowProjectId}/flowMedia:batchGenerateImages`,
    {
      method: 'POST',
      headers: {
        'accept': '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'authorization': 'Bearer ' + bearerToken,
        'content-type': 'application/json',
        'origin': 'https://labs.google',
        'referer': 'https://labs.google/',
        'sec-ch-ua': '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'cross-site',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
        'x-browser-channel': 'stable',
        'x-browser-copyright': 'Copyright 2026 Google LLC. All rights reserved.',
        'x-browser-validation': 'G41Ld2zZUk0hyYZx+J5sgTeMu5o=',
        'x-browser-year': '2026',
      },
      body: JSON.stringify(body),
    }
  );

  if (res.status === 429 || res.status === 403) {
    const text = await res.text();
    console.log('Flow rate-limited/forbidden:', res.status, text.slice(0, 500));
    throw new Error(`RATE_LIMITED:${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    const text = await res.text();
    console.log('Flow error:', res.status, text.slice(0, 500));
    if (text.includes('PUBLIC_ERROR_UNSAFE_GENERATION')) {
      throw new Error(`UNSAFE_CONTENT:${text.slice(0, 200)}`);
    }
    throw new Error(`FLOW_ERROR:${res.status}:${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const fifeUrl = data?.media?.[0]?.image?.generatedImage?.fifeUrl;
  if (!fifeUrl) {
    console.log('Flow response missing fifeUrl:', JSON.stringify(data).slice(0, 500));
    return null;
  }

  // Download image from the signed GCS URL
  const imgRes = await fetch(fifeUrl);
  if (!imgRes.ok) {
    throw new Error(`Failed to download image from fifeUrl: ${imgRes.status}`);
  }
  return await imgRes.buffer();
}

async function saveImageFromBuffer(buffer) {
  const filename = `img-${uuidv4()}.jpg`;
  const imgPath = path.join(IMAGES_DIR, filename);
  fs.writeFileSync(imgPath, buffer);
  return { filename, imgPath };
}

// ââ Routes âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

// GET /api/generate/flow-config â returns image generation config for the client
router.get('/flow-config', authMiddleware, (req, res) => {
  const db = getDb();
  const settings = getSettings(db);
  const flowProjectId = settings.flow_project_id || process.env.FLOW_PROJECT_ID || FLOW_PROJECT_ID_DEFAULT || null;
  const imageProvider = settings.image_provider || 'whisk';
  const wt = getNextToken(db);
  res.json({
    flowProjectId,
    siteKey: RECAPTCHA_SITE_KEY,
    hasToken: !!wt,
    imageProvider,
    // Expose bearer token so the client (via extension) can call the Flow API directly
    bearerToken: wt?.token || null,
  });
});

// POST /api/generate/save-image â download a fifeUrl and save it for a scene
router.post('/save-image', authMiddleware, async (req, res) => {
  const { sceneId, fifeUrl } = req.body;
  if (!sceneId || !fifeUrl) return res.status(400).json({ error: 'sceneId and fifeUrl required' });

  const db = getDb();
  const scene = db.prepare('SELECT * FROM scenes WHERE id = ?').get(sceneId);
  if (!scene) return res.status(404).json({ error: 'Scene not found' });

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(scene.project_id);
  if (req.user.role !== 'admin' && project.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    const fetch = (await import('node-fetch')).default;
    const imgRes = await fetch(fifeUrl);
    if (!imgRes.ok) return res.status(502).json({ error: `Failed to download image from fifeUrl: ${imgRes.status}` });
    const buffer = await imgRes.buffer();

    const { filename, imgPath } = await saveImageFromBuffer(buffer);
    const localUrl = `/api/generate/image-file/${filename}`;
    db.prepare('UPDATE scenes SET image_url = ?, image_path = ?, status = ? WHERE id = ?')
      .run(localUrl, imgPath, 'generated', scene.id);

    res.json({ image_url: localUrl });
  } catch (err) {
    console.error('save-image error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/generate/image/:sceneId
router.post('/image/:sceneId', authMiddleware, async (req, res) => {
  const db = getDb();
  const scene = db.prepare('SELECT * FROM scenes WHERE id = ?').get(req.params.sceneId);
  if (!scene) return res.status(404).json({ error: 'Scene not found' });

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(scene.project_id);
  if (req.user.role !== 'admin' && project.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const settings = getSettings(db);
  const imageProvider = settings.image_provider || 'whisk';
  const flowProjectId = settings.flow_project_id || process.env.FLOW_PROJECT_ID || FLOW_PROJECT_ID_DEFAULT;
  const { recaptchaToken } = req.body;


  // Build prompt with style prefix/suffix
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

  // Sanitize prompt for Whisk (has safety filters); Flow's NARWHAL model is more permissive
  let prompt = imageProvider === 'whisk' ? sanitizePrompt(rawPrompt) : rawPrompt;

  // Token rotation
  let imageBuffer = null;
  let source = 'unknown';
  let triedCount = 0;
  let unsafeContentRetried = false;

  while (true) {
    const wt = getNextToken(db);
    if (!wt) {
      const cooldown = db.prepare(`
        SELECT MIN(CAST((julianday(rate_limited_until) - julianday('now')) * 86400 AS INTEGER)) as secs
        FROM whisk_tokens
        WHERE status = 'rate_limited' AND rate_limited_until IS NOT NULL
      `).get();
      const retrySecs = cooldown?.secs != null ? Math.max(0, cooldown.secs) : null;
      const msg = triedCount === 0
        ? 'No active tokens â add a token in Settings'
        : 'All tokens are rate-limited â add a fresh token in Settings';
      return res.status(429).json({ error: msg, retry_after: retrySecs });
    }

    triedCount++;
    try {
      let buffer;
      if (imageProvider === 'flow') {
        buffer = await generateViaFlow(wt.token.trim(), recaptchaToken, prompt, referenceIds, flowProjectId);
      } else {
        buffer = await generateViaWhisk(wt.token.trim(), prompt);
      }
      if (buffer) {
        markTokenUsed(db, wt.id);
        imageBuffer = buffer;
        source = `${imageProvider}:${wt.label}`;
        break;
      }
      markTokenRateLimited(db, wt.id, `Empty response from ${imageProvider}`);
    } catch (err) {
      if (err.message.startsWith('RATE_LIMITED')) {
        markTokenRateLimited(db, wt.id, err.message.slice(12));
        console.log(`Token "${wt.label}" rate limited, rotating...`);
      } else if (err.message.startsWith('UNSAFE_CONTENT') && !unsafeContentRetried) {
        console.warn(`Safety filter triggered, retrying with fallback prompt. Token: "${wt.label}"`);
        unsafeContentRetried = true;
        prompt = makeSimpleFallbackPrompt(rawPrompt);
        console.log('Fallback prompt:', prompt);
        triedCount--;
        continue;
      } else {
        markTokenRateLimited(db, wt.id, err.message);
        console.error(`Token "${wt.label}" error:`, err.message);
      }
    }

    const totalTokens = db.prepare('SELECT COUNT(*) as c FROM whisk_tokens').get().c;
    if (triedCount >= totalTokens) break;
  }

  if (!imageBuffer) {
    const cooldown = db.prepare(`
      SELECT MIN(CAST((julianday(rate_limited_until) - julianday('now')) * 86400 AS INTEGER)) as secs
      FROM whisk_tokens
      WHERE status = 'rate_limited' AND rate_limited_until IS NOT NULL
    `).get();
    const retrySecs = cooldown?.secs != null ? Math.max(0, cooldown.secs) : null;
    return res.status(429).json({
      error: 'All tokens are rate-limited or expired â add a fresh token in Settings',
      retry_after: retrySecs,
    });
  }

  const { filename, imgPath } = await saveImageFromBuffer(imageBuffer);
  const localUrl = `/api/generate/image-file/${filename}`;
  db.prepare('UPDATE scenes SET image_url = ?, image_path = ?, status = ? WHERE id = ?')
    .run(localUrl, imgPath, 'generated', scene.id);

  res.json({ image_url: localUrl, prompt, source });
});

// GET /api/generate/image-file/:filename
router.get('/image-file/:filename', (req, res) => {
  const imgPath = path.join(IMAGES_DIR, path.basename(req.params.filename));
  if (!imgPath.startsWith(IMAGES_DIR)) return res.status(404).json({ error: 'Not found' });
  if (!fs.existsSync(imgPath)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(imgPath);
});

// POST /api/generate/prompts/:projectId â auto-generate all image prompts
router.post('/prompts/:projectId', authMiddleware, async (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && project.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const scenes = db.prepare('SELECT * FROM scenes WHERE project_id = ? ORDER BY scene_order').all(req.params.projectId);
  const settings = getSettings(db);
  const apiKey = settings.openai_api_key;

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
    'You are an expert at writing image generation prompts for AI art tools like Stable Diffusion and Whisk.',
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
      const prompt = data.choices?.[0]?.message?.content?.trim() || '';
      db.prepare('UPDATE scenes SET image_prompt = ? WHERE id = ?').run(prompt, scene.id);
      updated.push({ id: scene.id, image_prompt: prompt });
    } catch {
      updated.push({ id: scene.id, image_prompt: scene.image_prompt || '' });
    }
  }
  res.json({ scenes: updated, demo: false });
});

// ââ Token Management ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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
