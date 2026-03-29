const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');
const { getNextToken, markTokenUsed, markTokenRateLimited } = require('../utils/gemini');

const router = express.Router();
const UPLOADS_BASE = process.env.UPLOADS_PATH || path.join(__dirname, '..', 'uploads');
const IMAGES_DIR = path.join(UPLOADS_BASE, 'images');
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

const FLOW_PROJECT_ID_DEFAULT = 'b998a407-4f9a-4b0c-9bc9-f2fae2a5a077';

function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

// -- Flow API ------------------------------------------------------------------

async function generateViaFlow(bearerToken, prompt, referenceIds, flowProjectId) {
  const fetch = (await import('node-fetch')).default;
  const clientContext = {
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

  let rawPrompt = scene.image_prompt || scene.text;
  let referenceIds = [];
  if (project.style_id) {
    const style = db.prepare('SELECT * FROM styles WHERE id = ?').get(project.style_id);
    if (style) {
      rawPrompt = `${style.prompt_prefix} ${rawPrompt} ${style.prompt_suffix}`.trim();
      const refs = db.prepare('SELECT flow_media_id FROM style_references WHERE style_id = ? AND flow_media_id IS NOT NULL').all(project.style_id);
      referenceIds = refs.map(r => r.flow_media_id);
    }
  }

  let prompt = rawPrompt;
  let imageBuffer = null;
  let triedCount = 0;
  let unsafeContentRetried = false;

  while (true) {
    const wt = getNextToken(db);
    if (!wt) {
      const cooldown = db.prepare(`SELECT MIN(CAST((julianday(rate_limited_until) - julianday('now')) * 86400 AS INTEGER)) as secs FROM whisk_tokens WHERE status = 'rate_limited' AND rate_limited_until IS NOT NULL`).get();
      const retrySecs = cooldown?.secs != null ? Math.max(0, cooldown.secs) : null;
      const msg = triedCount === 0
        ? 'No active Bearer tokens — add a token in Settings'
        : 'All Bearer tokens are rate-limited — add a fresh token in Settings';
      return res.status(429).json({ error: msg, retry_after: retrySecs });
    }
    triedCount++;
    const projectId = wt.project_id || settings.flow_project_id || FLOW_PROJECT_ID_DEFAULT;
    try {
      const buffer = await generateViaFlow(wt.token.trim(), prompt, referenceIds, projectId);
      if (buffer) {
        markTokenUsed(db, wt.id);
        imageBuffer = buffer;
        break;
      }
      markTokenRateLimited(db, wt.id, 'Empty response from Flow');
    } catch (err) {
      if (err.message.startsWith('RATE_LIMITED')) {
        markTokenRateLimited(db, wt.id, err.message.slice(12));
        console.log(`Token "${wt.label}" rate limited, rotating...`);
      } else if (err.message.startsWith('UNSAFE_CONTENT') && !unsafeContentRetried) {
        console.warn(`Safety filter triggered, retrying with scene text only`);
        unsafeContentRetried = true;
        prompt = scene.text;
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
    const cooldown = db.prepare(`SELECT MIN(CAST((julianday(rate_limited_until) - julianday('now')) * 86400 AS INTEGER)) as secs FROM whisk_tokens WHERE status = 'rate_limited' AND rate_limited_until IS NOT NULL`).get();
    const retrySecs = cooldown?.secs != null ? Math.max(0, cooldown.secs) : null;
    return res.status(429).json({ error: 'All Bearer tokens are rate-limited or exhausted — add a fresh token in Settings', retry_after: retrySecs });
  }

  const { filename, imgPath } = await saveImageFromBuffer(imageBuffer);
  const localUrl = `/api/generate/image-file/${filename}`;
  db.prepare('UPDATE scenes SET image_url = ?, image_path = ?, status = ? WHERE id = ?').run(localUrl, imgPath, 'generated', scene.id);
  res.json({ image_url: localUrl, prompt });
});

// GET /api/generate/image-file/:filename
router.get('/image-file/:filename', (req, res) => {
  const imgPath = path.join(IMAGES_DIR, path.basename(req.params.filename));
  if (!imgPath.startsWith(IMAGES_DIR)) return res.status(404).json({ error: 'Not found' });
  if (!fs.existsSync(imgPath)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(imgPath);
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
    let prompt = scene.text;
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
        console.warn(`[prompts] OpenAI error for scene ${scene.id}, falling back to scene text:`, data.error.message || data.error.code);
      } else {
        prompt = data.choices?.[0]?.message?.content?.trim() || scene.text;
      }
    } catch (err) {
      console.warn(`[prompts] OpenAI fetch failed for scene ${scene.id}, falling back to scene text:`, err.message);
    }
    db.prepare('UPDATE scenes SET image_prompt = ? WHERE id = ?').run(prompt, scene.id);
    updated.push({ id: scene.id, image_prompt: prompt });
  }
  res.json({ scenes: updated, demo: false });
});

// -- Bearer token management ---------------------------------------------------

router.get('/whisk-tokens', authMiddleware, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const db = getDb();
  const tokens = db.prepare('SELECT id, label, project_id, usage_count, status, last_used, last_error, rate_limited_until, sort_order, created_at FROM whisk_tokens ORDER BY sort_order ASC, created_at ASC').all();
  res.json(tokens);
});

router.post('/whisk-tokens', authMiddleware, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { label, token, project_id } = req.body;
  if (!label || !token) return res.status(400).json({ error: 'label and token required' });
  const cleanToken = token.trim().replace(/^Bearer\s+/i, '');
  const cleanProjectId = (project_id || FLOW_PROJECT_ID_DEFAULT).trim();
  const db = getDb();
  const id = uuidv4();
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as m FROM whisk_tokens').get().m;
  db.prepare('INSERT INTO whisk_tokens (id, label, token, project_id, sort_order) VALUES (?, ?, ?, ?, ?)').run(id, label, cleanToken, cleanProjectId, maxOrder + 1);
  res.status(201).json({ id, label, project_id: cleanProjectId, usage_count: 0, status: 'active', sort_order: maxOrder + 1 });
});

router.put('/whisk-tokens/:id', authMiddleware, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const db = getDb();
  const { label, status, project_id } = req.body;
  const cleanToken = req.body.token ? req.body.token.trim().replace(/^Bearer\s+/i, '') : undefined;
  const cleanProjectId = project_id ? project_id.trim() : undefined;
  db.prepare('UPDATE whisk_tokens SET label = COALESCE(?, label), token = COALESCE(?, token), status = COALESCE(?, status), project_id = COALESCE(?, project_id) WHERE id = ?').run(label, cleanToken, status, cleanProjectId, req.params.id);
  const t = db.prepare('SELECT id, label, project_id, usage_count, status, last_used, last_error, rate_limited_until, sort_order FROM whisk_tokens WHERE id = ?').get(req.params.id);
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
