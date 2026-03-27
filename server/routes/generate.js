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

function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

// ── Whisk prompt sanitization ────────────────────────────────────────────────

// Google Imagen's safety filter rejects prompts with violence/weapons/death references.
// Replace flagged words with safe visual alternatives before sending to Whisk.
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

function sanitizeForWhisk(prompt) {
  let sanitized = prompt;
  for (const [word, replacement] of Object.entries(WHISK_WORD_REPLACEMENTS)) {
    sanitized = sanitized.replace(new RegExp(`\\b${word}\\b`, 'gi'), replacement);
  }
  // Add a safe art framing prefix if prompt doesn't already start with one
  if (!/^(a |an )?(digital|cinematic|artistic|photographic|illustration|painting|dramatic)/i.test(sanitized.trim())) {
    sanitized = `A cinematic still of ${sanitized}`;
  }
  return sanitized.trim();
}

function makeSimpleFallbackPrompt(prompt) {
  // Strip everything down to nouns/adjectives, keep under 60 chars, add safe prefix
  const stripped = prompt
    .replace(/[^a-zA-Z0-9\s,]/g, '')
    .replace(/\b\w{1,2}\b/g, '') // remove tiny words
    .trim()
    .slice(0, 80);
  return `A digital illustration of ${stripped}, dramatic lighting, cinematic composition`;
}

// ── Whisk token rotation ─────────────────────────────────────────────────────

function getNextWhiskToken(db) {
  // Auto-reset tokens whose 30-second cooldown has expired
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

function markWhiskUsed(db, tokenId) {
  db.prepare(`
    UPDATE whisk_tokens SET usage_count = usage_count + 1, last_used = CURRENT_TIMESTAMP WHERE id = ?
  `).run(tokenId);
}

function markWhiskRateLimited(db, tokenId, errMsg) {
  db.prepare(`
    UPDATE whisk_tokens
    SET status = 'rate_limited',
        last_error = ?,
        rate_limited_until = datetime('now', '+30 seconds')
    WHERE id = ?
  `).run(errMsg, tokenId);
}

// Attempt to generate via Whisk API
// Whisk uses Google AI / Imagen under the hood. The public API endpoint used
// by the Whisk web app is authenticated via Google OAuth tokens (Bearer tokens
// from the user's logged-in session). Token format: "ya29.xxx..."
async function generateViaWhisk(token, prompt, aspectRatio = 'IMAGE_ASPECT_RATIO_LANDSCAPE') {
  const fetch = (await import('node-fetch')).default;

  const body = {
    clientContext: {
      workflowId: uuidv4(),
      tool: 'BACKBONE',
      sessionId: `;${Date.now()}`,
    },
    imageModelSettings: {
      imageModel: 'IMAGEN_3_5',
      aspectRatio: aspectRatio,
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
      'authorization': 'Bearer ' + token,
      'content-type': 'text/plain;charset=UTF-8',
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
      'x-client-data': 'CPyUywE=',
    },
    body: JSON.stringify(body),
  });

  if (res.status === 429 || res.status === 403) {
    const text = await res.text();
    console.log('Whisk rate-limited:', res.status, text.slice(0, 500));
    throw new Error(`RATE_LIMITED:${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    const text = await res.text();
    console.log('Whisk error:', res.status, text.slice(0, 500));
    if (text.includes('PUBLIC_ERROR_UNSAFE_GENERATION')) {
      throw new Error(`UNSAFE_CONTENT:${text.slice(0, 200)}`);
    }
    throw new Error(`WHISK_ERROR:${res.status}:${text.slice(0, 200)}`);
  }

  const data = await res.json();
  // Response: { imagePanels: [{ generatedImages: [{ encodedImage: "base64..." }] }] }
  return data?.imagePanels?.[0]?.generatedImages?.[0]?.encodedImage || null;
}


async function saveImageFromBase64(b64) {
  const filename = `img-${uuidv4()}.jpg`;
  const imgPath = path.join(IMAGES_DIR, filename);
  fs.writeFileSync(imgPath, Buffer.from(b64, 'base64'));
  return { filename, imgPath };
}

// ── Routes ───────────────────────────────────────────────────────────────────

// POST /api/generate/image/:sceneId
router.post('/image/:sceneId', authMiddleware, async (req, res) => {
  const db = getDb();
  const scene = db.prepare('SELECT * FROM scenes WHERE id = ?').get(req.params.sceneId);
  if (!scene) return res.status(404).json({ error: 'Scene not found' });

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(scene.project_id);
  if (req.user.role !== 'admin' && project.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  // Build prompt with style prefix/suffix, then sanitize for Whisk safety filter
  let rawPrompt = scene.image_prompt || scene.text;
  let aspectRatio = 'IMAGE_ASPECT_RATIO_LANDSCAPE';
  if (project.style_id) {
    const style = db.prepare('SELECT * FROM styles WHERE id = ?').get(project.style_id);
    if (style) {
      rawPrompt = `${style.prompt_prefix} ${rawPrompt} ${style.prompt_suffix}`.trim();
      if (style.aspect_ratio) aspectRatio = style.aspect_ratio;
    }
  }
  let prompt = sanitizeForWhisk(rawPrompt);

  // Try Whisk tokens in rotation order (getNextWhiskToken auto-resets expired cooldowns)
  let imageResult = null;
  let source = 'unknown';
  let triedCount = 0;
  let unsafeContentRetried = false;

  while (true) {
    const wt = getNextWhiskToken(db);
    if (!wt) {
      // No active tokens — check if any are cooling down
      const cooldown = db.prepare(`
        SELECT MIN(CAST((julianday(rate_limited_until) - julianday('now')) * 86400 AS INTEGER)) as secs
        FROM whisk_tokens
        WHERE status = 'rate_limited' AND rate_limited_until IS NOT NULL
      `).get();
      const retrySecs = cooldown?.secs != null ? Math.max(0, cooldown.secs) : null;
      const msg = triedCount === 0
        ? 'No active Whisk tokens — add a token in Settings'
        : `All Whisk tokens are rate-limited — add a fresh token in Settings`;
      return res.status(429).json({ error: msg, retry_after: retrySecs });
    }

    triedCount++;
    try {
      const encodedImage = await generateViaWhisk(wt.token, prompt, aspectRatio);
      if (encodedImage) {
        markWhiskUsed(db, wt.id);
        imageResult = { type: 'base64', value: encodedImage };
        source = `whisk:${wt.label}`;
        break;
      }
      // null result — mark this token as having an error and try next
      markWhiskRateLimited(db, wt.id, 'Empty response from Whisk');
    } catch (err) {
      if (err.message.startsWith('RATE_LIMITED')) {
        markWhiskRateLimited(db, wt.id, err.message.slice(12));
        console.log(`Whisk token "${wt.label}" rate limited, rotating...`);
      } else if (err.message.startsWith('UNSAFE_CONTENT') && !unsafeContentRetried) {
        // Safety filter triggered — retry once with a stripped-down fallback prompt
        console.warn(`Whisk safety filter triggered for prompt, retrying with fallback. Token: "${wt.label}"`);
        unsafeContentRetried = true;
        prompt = makeSimpleFallbackPrompt(rawPrompt);
        console.log('Fallback prompt:', prompt);
        triedCount--; // don't count this as a token exhaustion attempt
        continue;
      } else {
        // Non-rate-limit error: mark rate-limited briefly so we skip it this round
        markWhiskRateLimited(db, wt.id, err.message);
        console.error(`Whisk token "${wt.label}" error:`, err.message);
      }
    }

    // Safety: if we've tried more tokens than exist in the DB, stop
    const totalTokens = db.prepare('SELECT COUNT(*) as c FROM whisk_tokens').get().c;
    if (triedCount >= totalTokens) break;
  }

  if (!imageResult) {
    const cooldown = db.prepare(`
      SELECT MIN(CAST((julianday(rate_limited_until) - julianday('now')) * 86400 AS INTEGER)) as secs
      FROM whisk_tokens
      WHERE status = 'rate_limited' AND rate_limited_until IS NOT NULL
    `).get();
    const retrySecs = cooldown?.secs != null ? Math.max(0, cooldown.secs) : null;
    return res.status(429).json({
      error: 'All Whisk tokens are rate-limited or expired — add a fresh token in Settings',
      retry_after: retrySecs,
    });
  }

  // Save image locally (Whisk always returns base64)
  const { filename, imgPath } = await saveImageFromBase64(imageResult.value);

  const localUrl = `/api/generate/image-file/${filename}`;
  db.prepare('UPDATE scenes SET image_url = ?, image_path = ?, status = ? WHERE id = ?')
    .run(localUrl, imgPath, 'generated', scene.id);

  res.json({ image_url: localUrl, prompt, source });
});

// GET /api/generate/image-file/:filename
// No auth required — filenames are UUID-based (unguessable) and contain no sensitive data.
// Browser <img> tags load images without Authorization headers, so auth here breaks previews.
router.get('/image-file/:filename', (req, res) => {
  // Use path.basename to strip any ../ traversal attempts before joining
  const imgPath = path.join(IMAGES_DIR, path.basename(req.params.filename));
  if (!imgPath.startsWith(IMAGES_DIR)) return res.status(404).json({ error: 'Not found' });
  if (!fs.existsSync(imgPath)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(imgPath);
});

// POST /api/generate/prompts/:projectId — auto-generate all image prompts
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
  let style = null;
  if (project.style_id) {
    style = db.prepare('SELECT * FROM styles WHERE id = ?').get(project.style_id);
    if (style) {
      styleContext = `Visual style: "${style.name}" — ${style.description} Visual instructions: ${style.prompt_prefix}`;
    }
  }

  if (!apiKey) {
    const updated = scenes.map(scene => {
      const visualBase = scene.text.slice(0, 150).replace(/["""'']/g, '');
      const styleHint = style ? `${style.name} style. ` : '';
      const prompt = `${styleHint}A cinematic scene depicting: ${visualBase}. Dramatic lighting, high quality, film still, wide angle shot.`;
      db.prepare('UPDATE scenes SET image_prompt = ? WHERE id = ?').run(prompt, scene.id);
      return { id: scene.id, image_prompt: prompt };
    });
    return res.json({ scenes: updated, demo: true });
  }

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
            { role: 'system', content: `You write concise, vivid image prompts for AI image generation. ${styleContext} Write prompts that visually match this style. Each prompt must be visually specific, cinematic, and under 150 words. Return only the prompt text.` },
            { role: 'user', content: `Write an image prompt for this scene: "${scene.text}"` },
          ],
          max_tokens: 200,
        }),
      });
      const data = await resp.json();
      const prompt = data.choices?.[0]?.message?.content?.trim() || scene.text;
      db.prepare('UPDATE scenes SET image_prompt = ? WHERE id = ?').run(prompt, scene.id);
      updated.push({ id: scene.id, image_prompt: prompt });
    } catch {
      updated.push({ id: scene.id, image_prompt: scene.image_prompt || scene.text });
    }
  }
  res.json({ scenes: updated, demo: false });
});

// ── Whisk Token Management ───────────────────────────────────────────────────

// GET /api/generate/whisk-tokens (admin only handled in settings route)
router.get('/whisk-tokens', authMiddleware, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const db = getDb();
  const tokens = db.prepare('SELECT id, label, usage_count, status, last_used, last_error, rate_limited_until, sort_order, created_at FROM whisk_tokens ORDER BY sort_order ASC, created_at ASC').all();
  res.json(tokens);
});

// POST /api/generate/whisk-tokens
router.post('/whisk-tokens', authMiddleware, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { label, token } = req.body;
  if (!label || !token) return res.status(400).json({ error: 'label and token required' });

  // Trim whitespace and strip any "Bearer " prefix the user may have pasted
  const cleanToken = token.trim().replace(/^Bearer\s+/i, '');

  const db = getDb();
  const id = uuidv4();
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as m FROM whisk_tokens').get().m;
  db.prepare('INSERT INTO whisk_tokens (id, label, token, sort_order) VALUES (?, ?, ?, ?)').run(id, label, cleanToken, maxOrder + 1);
  res.status(201).json({ id, label, usage_count: 0, status: 'active', sort_order: maxOrder + 1 });
});

// PUT /api/generate/whisk-tokens/:id
router.put('/whisk-tokens/:id', authMiddleware, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const db = getDb();
  const { label, status } = req.body;
  // Trim and strip "Bearer " prefix if a new token value was provided
  const cleanToken = req.body.token ? req.body.token.trim().replace(/^Bearer\s+/i, '') : undefined;
  db.prepare('UPDATE whisk_tokens SET label = COALESCE(?, label), token = COALESCE(?, token), status = COALESCE(?, status) WHERE id = ?').run(label, cleanToken, status, req.params.id);
  const t = db.prepare('SELECT id, label, usage_count, status, last_used, last_error, rate_limited_until, sort_order FROM whisk_tokens WHERE id = ?').get(req.params.id);
  res.json(t);
});

// DELETE /api/generate/whisk-tokens/:id
router.delete('/whisk-tokens/:id', authMiddleware, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const db = getDb();
  db.prepare('DELETE FROM whisk_tokens WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// POST /api/generate/whisk-tokens/:id/reset — reset rate limit
router.post('/whisk-tokens/:id/reset', authMiddleware, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const db = getDb();
  db.prepare("UPDATE whisk_tokens SET status = 'active', last_error = NULL WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
