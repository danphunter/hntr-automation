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
const VIDEOS_DIR = path.join(UPLOADS_BASE, 'videos');
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });
if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });

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
  const apiKey = settings.openai_api_key?.trim() || process.env.OPENAI_API_KEY?.trim();

  let styleContext = '';
  if (project.style_id) {
    const style = db.prepare('SELECT * FROM styles WHERE id = ?').get(project.style_id);
    if (style) styleContext = `Visual style: ${style.name}. ${style.description}`;
  }

  if (!apiKey) {
    const updated = scenes.map(scene => {
      db.prepare('UPDATE scenes SET image_prompt = ? WHERE id = ?').run(scene.text, scene.id);
      return { id: scene.id, image_prompt: scene.text };
    });
    return res.json({ scenes: updated });
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
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
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
  res.json({ scenes: updated });
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
  if (cleanToken) {
    // New token value submitted — reset all stale state
    db.prepare("UPDATE whisk_tokens SET label = COALESCE(?, label), token = ?, status = 'active', last_error = NULL, usage_count = 0, rate_limited_until = NULL, project_id = COALESCE(?, project_id) WHERE id = ?").run(label, cleanToken, cleanProjectId, req.params.id);
  } else {
    db.prepare('UPDATE whisk_tokens SET label = COALESCE(?, label), status = COALESCE(?, status), project_id = COALESCE(?, project_id) WHERE id = ?').run(label, status, cleanProjectId, req.params.id);
  }
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

// POST /api/generate/video/:sceneId — submit a Veo t2v job
router.post('/video/:sceneId', authMiddleware, async (req, res) => {
  const db = getDb();
  const scene = db.prepare('SELECT * FROM scenes WHERE id = ?').get(req.params.sceneId);
  if (!scene) return res.status(404).json({ error: 'Scene not found' });
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(scene.project_id);
  if (req.user.role !== 'admin' && project.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

  const wt = getNextToken(db);
  if (!wt) return res.status(429).json({ error: 'No active Bearer tokens — add a token in Settings' });

  const settings = getSettings(db);
  const projectId = wt.project_id || settings.flow_project_id || FLOW_PROJECT_ID_DEFAULT;
  const videoPrompt = scene.image_prompt || scene.text;
  const batchId = uuidv4();

  const body = {
    mediaGenerationContext: { batchId },
    clientContext: { projectId, tool: 'PINHOLE' },
    requests: [{
      aspectRatio: 'VIDEO_ASPECT_RATIO_PORTRAIT',
      metadata: {},
      seed: Math.floor(Math.random() * 1000000),
      textInput: { structuredPrompt: { parts: [{ text: videoPrompt }] } },
      videoModelKey: 'veo_3_1_t2v_fast_portrait_ultra',
    }],
    useV2ModelConfig: true,
  };

  const fetch = (await import('node-fetch')).default;
  try {
    const r = await fetch('https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${wt.token.trim()}`,
        'origin': 'https://labs.google',
        'referer': 'https://labs.google/',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: JSON.stringify(body),
    });

    if (r.status === 429 || r.status === 403) {
      markTokenRateLimited(db, wt.id, `HTTP ${r.status}`);
      return res.status(429).json({ error: 'Token rate limited — try again or add a fresh token' });
    }
    if (!r.ok) {
      const text = await r.text();
      console.error('[veo t2v] Submit error:', r.status, text.slice(0, 300));
      return res.status(502).json({ error: `Veo error ${r.status}: ${text.slice(0, 200)}` });
    }

    const data = await r.json();
    console.log('[veo t2v] Job submitted batchId=%s response:', batchId, JSON.stringify(data).slice(0, 300));
    markTokenUsed(db, wt.id);

    // Store batchId on the scene so the status endpoint can track it
    db.prepare('UPDATE scenes SET video_job_id = ?, video_url = NULL WHERE id = ?').run(batchId, scene.id);

    res.json({ batchId, prompt: videoPrompt });
  } catch (err) {
    console.error('[veo t2v] Submit fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/generate/video-status/:batchId — poll job; downloads + saves video when done
router.get('/video-status/:batchId', authMiddleware, async (req, res) => {
  const db = getDb();
  const { batchId } = req.params;

  // Check if already done
  const scene = db.prepare('SELECT * FROM scenes WHERE video_job_id = ?').get(batchId);
  if (!scene) return res.status(404).json({ error: 'Job not found' });
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(scene.project_id);
  if (req.user.role !== 'admin' && project.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

  if (scene.video_url) return res.json({ status: 'complete', video_url: scene.video_url });

  // Poll Veo
  const wt = getNextToken(db);
  if (!wt) return res.status(429).json({ error: 'No active tokens for status check' });

  const fetch = (await import('node-fetch')).default;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${wt.token.trim()}`,
    'origin': 'https://labs.google',
    'referer': 'https://labs.google/',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  };

  try {
    const pollRes = await fetch('https://aisandbox-pa.googleapis.com/v1/video:batchGetVideoStatus', {
      method: 'POST',
      headers,
      body: JSON.stringify({ batchIds: [batchId] }),
    });

    if (!pollRes.ok) {
      const text = await pollRes.text();
      console.error('[veo status] Poll error:', pollRes.status, text.slice(0, 200));
      return res.json({ status: 'processing' }); // don't error out — keep polling
    }

    const pollData = await pollRes.json();
    const batchEntry = pollData.batches?.[0] || pollData.results?.[0] || pollData.statuses?.[0] || pollData;

    const isDone =
      batchEntry.done === true ||
      batchEntry.status === 'COMPLETE' || batchEntry.status === 'SUCCEEDED' ||
      batchEntry.state === 'DONE' || batchEntry.state === 'SUCCEEDED';

    if (!isDone) {
      const state = batchEntry.status || batchEntry.state || batchEntry.done;
      console.log(`[veo status] batchId=${batchId} state=${state}`);
      return res.json({ status: 'processing', state });
    }

    console.log('[veo status] Done! batchId=%s response shape:', batchId, JSON.stringify(pollData).slice(0, 500));

    // Extract video bytes or URL from the (unknown) response shape
    const resp = batchEntry.response || batchEntry;
    const candidates = [
      ...(resp.videos || []),
      ...(resp.media || []),
      ...(resp.generatedSamples || []),
      ...(resp.generateVideoResponse?.generatedSamples || []),
      ...(resp.results || []),
      ...(resp.predictions || []),
    ];

    let videoBuffer = null;
    for (const item of candidates) {
      const vid = item.video || item;
      if (vid.bytesBase64Encoded) { videoBuffer = Buffer.from(vid.bytesBase64Encoded, 'base64'); break; }
      const url = vid.uri || vid.videoUri || vid.url || vid.downloadUri || item.videoUri || item.uri;
      if (url) {
        const dl = await fetch(url, { headers: { 'Authorization': `Bearer ${wt.token.trim()}` } });
        if (dl.ok) { videoBuffer = await dl.buffer(); break; }
        console.error('[veo status] Failed to download from url:', dl.status);
      }
    }

    if (!videoBuffer) {
      // Return the raw done-response so we can debug the shape
      console.error('[veo status] Unrecognised done response:', JSON.stringify(resp).slice(0, 500));
      return res.json({ status: 'complete_unknown_shape', raw: JSON.stringify(pollData).slice(0, 1000) });
    }

    const filename = `vid-${uuidv4()}.mp4`;
    const vidPath = path.join(VIDEOS_DIR, filename);
    fs.writeFileSync(vidPath, videoBuffer);
    const videoUrl = `/api/generate/video-file/${filename}`;
    db.prepare('UPDATE scenes SET video_url = ? WHERE id = ?').run(videoUrl, scene.id);

    res.json({ status: 'complete', video_url: videoUrl });
  } catch (err) {
    console.error('[veo status] Error:', err.message);
    res.json({ status: 'processing' }); // keep polling on transient errors
  }
});

// GET /api/generate/video-file/:filename
router.get('/video-file/:filename', (req, res) => {
  const vidPath = path.join(VIDEOS_DIR, path.basename(req.params.filename));
  if (!vidPath.startsWith(VIDEOS_DIR)) return res.status(404).json({ error: 'Not found' });
  if (!fs.existsSync(vidPath)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(vidPath);
});

// -- Veo text-to-video ---------------------------------------------------------

// POST /api/generate/video/:sceneId
// Submits a Veo t2v job and returns the operation name as job_id.
router.post('/video/:sceneId', authMiddleware, async (req, res) => {
  const db = getDb();
  const scene = db.prepare('SELECT * FROM scenes WHERE id = ?').get(req.params.sceneId);
  if (!scene) return res.status(404).json({ error: 'Scene not found' });
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(scene.project_id);
  if (req.user.role !== 'admin' && project.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

  const wt = getNextToken(db);
  if (!wt) return res.status(429).json({ error: 'No active Bearer tokens — add a token in Settings' });

  const settings = getSettings(db);
  const projectId = wt.project_id || settings.flow_project_id || FLOW_PROJECT_ID_DEFAULT;
  const prompt = scene.image_prompt || scene.text;
  const batchId = uuidv4();

  const fetch = (await import('node-fetch')).default;
  const body = {
    mediaGenerationContext: { batchId },
    clientContext: { projectId, tool: 'PINHOLE' },
    requests: [{
      aspectRatio: 'VIDEO_ASPECT_RATIO_PORTRAIT',
      seed: Math.floor(Math.random() * 1000000),
      textPrompt: { parts: [{ text: prompt }] },
      videoModelKey: 'veo_3_1_t2v_fast_portrait_ultra',
    }],
    useV2ModelConfig: true,
  };

  let rawStatus, rawBody;
  try {
    const r = await fetch(
      'https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoText',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${wt.token.trim()}`,
          'origin': 'https://labs.google',
          'referer': 'https://labs.google/',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        body: JSON.stringify(body),
      }
    );
    rawStatus = r.status;
    rawBody = await r.text();
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }

  if (rawStatus === 429 || rawStatus === 403) {
    markTokenRateLimited(db, wt.id, rawBody.slice(0, 200));
    return res.status(rawStatus).json({ error: `Veo API error: ${rawStatus}`, details: rawBody.slice(0, 500) });
  }
  if (rawStatus < 200 || rawStatus >= 300) {
    return res.status(rawStatus).json({ error: `Veo API error: ${rawStatus}`, details: rawBody.slice(0, 500) });
  }

  let data;
  try { data = JSON.parse(rawBody); } catch { return res.status(502).json({ error: 'Invalid JSON from Veo API', raw: rawBody.slice(0, 500) }); }

  // Google LRO: response has a `name` field like "operations/abc123"
  // Also handle arrays: { operations: [{ name: '...' }] }
  const operationName = data?.name
    || data?.operations?.[0]?.name
    || batchId;

  db.prepare('UPDATE scenes SET veo_job_id = ? WHERE id = ?').run(operationName, scene.id);
  markTokenUsed(db, wt.id);

  res.json({ job_id: operationName, batchId });
});

// GET /api/generate/video-status/:jobId
// Polls the Veo operation status. Returns { status: 'pending'|'complete', video_url }.
router.get('/video-status/:jobId', authMiddleware, async (req, res) => {
  const jobId = decodeURIComponent(req.params.jobId);
  const db = getDb();

  // Check if already saved to DB
  const scene = db.prepare('SELECT * FROM scenes WHERE veo_job_id = ?').get(jobId);
  if (scene?.video_url) {
    return res.json({ status: 'complete', video_url: scene.video_url });
  }

  const wt = getNextToken(db);
  if (!wt) return res.status(429).json({ error: 'No active Bearer tokens' });

  const fetch = (await import('node-fetch')).default;
  let rawStatus, rawBody;
  try {
    const r = await fetch(
      `https://aisandbox-pa.googleapis.com/v1/${jobId}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${wt.token.trim()}`,
          'origin': 'https://labs.google',
          'referer': 'https://labs.google/',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      }
    );
    rawStatus = r.status;
    rawBody = await r.text();
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }

  if (rawStatus < 200 || rawStatus >= 300) {
    return res.status(rawStatus).json({ error: `Veo status error: ${rawStatus}`, details: rawBody.slice(0, 500) });
  }

  let data;
  try { data = JSON.parse(rawBody); } catch { return res.status(502).json({ error: 'Invalid JSON from Veo status API' }); }

  if (!data.done) return res.json({ status: 'pending' });

  // Extract video URL — try several known response shapes
  const fifeUrl =
    data?.response?.media?.[0]?.video?.generatedVideo?.fifeUrl ||
    data?.response?.media?.[0]?.video?.fifeUrl ||
    data?.response?.operations?.[0]?.response?.media?.[0]?.video?.generatedVideo?.fifeUrl ||
    data?.media?.[0]?.video?.generatedVideo?.fifeUrl ||
    data?.media?.[0]?.video?.fifeUrl;

  if (!fifeUrl) {
    // Done but no URL yet — treat as still pending and return raw for debugging
    console.warn('[veo-status] done=true but no fifeUrl found, response:', JSON.stringify(data).slice(0, 500));
    return res.json({ status: 'pending', _debug: data });
  }

  if (scene) {
    db.prepare('UPDATE scenes SET video_url = ? WHERE id = ?').run(fifeUrl, scene.id);
  }

  res.json({ status: 'complete', video_url: fifeUrl });
});

module.exports = router;
