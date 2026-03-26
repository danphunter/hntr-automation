const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
const IMAGES_DIR = path.join(__dirname, '..', 'uploads', 'images');
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

// ── Whisk token rotation ─────────────────────────────────────────────────────

function getNextWhiskToken(db) {
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
    UPDATE whisk_tokens SET status = 'rate_limited', last_error = ? WHERE id = ?
  `).run(errMsg, tokenId);
}

// Attempt to generate via Whisk API
// Whisk uses Google AI / Imagen under the hood. The public API endpoint used
// by the Whisk web app is authenticated via Google OAuth tokens (Bearer tokens
// from the user's logged-in session). Token format: "ya29.xxx..."
async function generateViaWhisk(token, prompt, subjectRefs, styleRefImages) {
  const fetch = (await import('node-fetch')).default;

  console.log('Using Whisk token (first 20 chars):', token.substring(0, 20));

  // Whisk uses Google's Imagen API via the whisk.withgoogle.com backend
  const body = {
    prompt,
    ...(subjectRefs && subjectRefs.length > 0 && {
      subjectImages: subjectRefs.map(r => r.url || r.file_path),
    }),
    ...(styleRefImages && styleRefImages.length > 0 && {
      styleImages: styleRefImages.map(r => r.url || r.file_path),
    }),
    aspectRatio: 'LANDSCAPE',
    outputFormat: 'JPEG',
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
    console.log('Whisk response:', res.status, text.slice(0, 500));
    throw new Error(`RATE_LIMITED:${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    const text = await res.text();
    console.log('Whisk response:', res.status, text.slice(0, 500));
    throw new Error(`WHISK_ERROR:${res.status}:${text.slice(0, 200)}`);
  }

  const data = await res.json();
  // Whisk returns base64 image data or a URL depending on endpoint
  return data?.image?.data || data?.imageData || data?.url || null;
}


async function saveImageFromUrl(url) {
  const fetch = (await import('node-fetch')).default;
  const res = await fetch(url);
  const filename = `img-${uuidv4()}.jpg`;
  const imgPath = path.join(IMAGES_DIR, filename);
  const buffer = await res.buffer();
  fs.writeFileSync(imgPath, buffer);
  return { filename, imgPath };
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

  const settings = getSettings(db);

  // Build prompt with style
  let prompt = scene.image_prompt || scene.text;
  let subjectRefs = [];
  let styleRefs = [];
  if (project.style_id) {
    const style = db.prepare('SELECT * FROM styles WHERE id = ?').get(project.style_id);
    if (style) {
      prompt = `${style.prompt_prefix} ${prompt} ${style.prompt_suffix}`.trim();
      const allRefs = db.prepare('SELECT * FROM style_references WHERE style_id = ?').all(style.id);
      subjectRefs = allRefs.filter(r => (r.reference_type || 'subject') === 'subject');
      styleRefs = allRefs.filter(r => r.reference_type === 'style');
    }
  }

  const whiskTokens = db.prepare("SELECT * FROM whisk_tokens WHERE status = 'active' ORDER BY usage_count ASC").all();

  // No active Whisk tokens — return a clear error
  if (!whiskTokens.length) {
    return res.status(400).json({ error: 'No active Whisk tokens — add a token in Settings' });
  }

  // Try Whisk tokens in rotation order
  let imageResult = null;
  let source = 'unknown';

  for (const wt of whiskTokens) {
    try {
      const result = await generateViaWhisk(wt.token, prompt, subjectRefs, styleRefs);
      if (result) {
        markWhiskUsed(db, wt.id);
        imageResult = { type: result.startsWith('http') ? 'url' : 'base64', value: result };
        source = `whisk:${wt.label}`;
        break;
      }
    } catch (err) {
      if (err.message.startsWith('RATE_LIMITED')) {
        markWhiskRateLimited(db, wt.id, err.message.slice(12));
        console.log(`Whisk token "${wt.label}" rate limited, trying next...`);
      } else {
        console.error(`Whisk token "${wt.label}" error:`, err.message);
      }
    }
  }

  if (!imageResult) {
    return res.status(400).json({ error: 'All Whisk tokens are rate-limited or expired — add a fresh token in Settings' });
  }

  // Save image locally
  let filename, imgPath;
  if (imageResult.type === 'url') {
    ({ filename, imgPath } = await saveImageFromUrl(imageResult.value));
  } else {
    ({ filename, imgPath } = await saveImageFromBase64(imageResult.value));
  }

  const localUrl = `/api/generate/image-file/${filename}`;
  db.prepare('UPDATE scenes SET image_url = ?, image_path = ?, status = ? WHERE id = ?')
    .run(localUrl, imgPath, 'generated', scene.id);

  res.json({ image_url: localUrl, prompt, source });
});

// GET /api/generate/image-file/:filename
router.get('/image-file/:filename', authMiddleware, (req, res) => {
  const imgPath = path.join(IMAGES_DIR, req.params.filename);
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
  if (project.style_id) {
    const style = db.prepare('SELECT * FROM styles WHERE id = ?').get(project.style_id);
    if (style) styleContext = `Visual style: ${style.name}. ${style.description}`;
  }

  if (!apiKey) {
    const updated = scenes.map(scene => {
      const visualBase = scene.text.slice(0, 150).replace(/["""'']/g, '');
      const stylePrefix = styleContext ? `${styleContext}. ` : '';
      const prompt = `${stylePrefix}A cinematic scene depicting: ${visualBase}. Dramatic lighting, high quality, film still, wide angle shot.`;
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
            { role: 'system', content: `You write concise, vivid image prompts for AI image generation. ${styleContext} Each prompt must be visually specific, cinematic, and under 150 words. Return only the prompt.` },
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
  const tokens = db.prepare('SELECT id, label, usage_count, status, last_used, last_error, sort_order, created_at FROM whisk_tokens ORDER BY sort_order ASC, created_at ASC').all();
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
  const t = db.prepare('SELECT id, label, usage_count, status, last_used, last_error, sort_order FROM whisk_tokens WHERE id = ?').get(req.params.id);
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
