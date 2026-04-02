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

// -- useapi.net Google Flow API ------------------------------------------------

async function generateViaUseApi(useApiToken, prompt) {
  const fetch = (await import('node-fetch')).default;
  const response = await fetch('https://api.useapi.net/v1/google-flow/images', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + useApiToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
      model: 'imagen-4',
      aspectRatio: '16:9',
      count: 1,
    }),
  });
  return response;
}

async function saveImageFromBuffer(buffer) {
  const filename = `img-${uuidv4()}.jpg`;
  const imgPath = path.join(IMAGES_DIR, filename);
  fs.writeFileSync(imgPath, buffer);
  return { filename, imgPath };
}

// -- Routes --------------------------------------------------------------------

// POST /api/generate/image/:sceneId
router.post('/image/:sceneId', authMiddleware, async (req, res) => {
  const db = getDb();
  const scene = db.prepare('SELECT * FROM scenes WHERE id = ?').get(req.params.sceneId);
  if (!scene) return res.status(404).json({ error: 'Scene not found' });
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(scene.project_id);
  if (req.user.role !== 'admin' && project.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

  const settings = getSettings(db);
  const useApiToken = settings.useapi_token?.trim();
  if (!useApiToken) {
    return res.status(400).json({ error: 'No useapi.net token configured — add one in Settings.' });
  }

  let rawPrompt = scene.image_prompt || scene.text;
  if (project.style_id) {
    const style = db.prepare('SELECT * FROM styles WHERE id = ?').get(project.style_id);
    if (style) {
      rawPrompt = `${style.prompt_prefix} ${rawPrompt} ${style.prompt_suffix}`.trim();
    }
  }

  const prompt = rawPrompt;

  let apiRes;
  try {
    apiRes = await generateViaUseApi(useApiToken, prompt);
  } catch (err) {
    console.error('[generate] useapi.net fetch error:', err.message);
    return res.status(500).json({ error: `Image generation failed: ${err.message}` });
  }

  if (apiRes.status === 429) {
    const text = await apiRes.text();
    console.warn('[generate] useapi.net rate limited:', text.slice(0, 300));
    return res.status(429).json({ error: 'Rate limited by useapi.net — try again shortly.' });
  }

  if (apiRes.status === 402) {
    const text = await apiRes.text();
    console.warn('[generate] useapi.net subscription error:', text.slice(0, 300));
    return res.status(402).json({ error: 'useapi.net subscription required or quota exceeded.' });
  }

  if (apiRes.status === 596) {
    const text = await apiRes.text();
    console.warn('[generate] useapi.net session error:', text.slice(0, 300));
    return res.status(596).json({ error: 'useapi.net Google session expired — refresh Google cookies in your useapi.net account.' });
  }

  if (!apiRes.ok) {
    const text = await apiRes.text();
    console.error('[generate] useapi.net error:', apiRes.status, text.slice(0, 500));
    return res.status(500).json({ error: `useapi.net error ${apiRes.status}: ${text.slice(0, 200)}` });
  }

  const result = await apiRes.json();
  const imageUrl = result?.media?.[0]?.image?.generatedImage?.fifeUrl;
  if (!imageUrl) {
    console.error('[generate] useapi.net missing fifeUrl in response:', JSON.stringify(result).slice(0, 500));
    return res.status(500).json({ error: 'Image generation succeeded but no image URL returned.' });
  }

  // Fetch the image and save locally
  let imageBuffer;
  try {
    const fetch = (await import('node-fetch')).default;
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) throw new Error(`Failed to fetch image: ${imgRes.status}`);
    imageBuffer = Buffer.from(await imgRes.arrayBuffer());
  } catch (err) {
    console.error('[generate] Failed to download generated image:', err.message);
    return res.status(500).json({ error: `Failed to download generated image: ${err.message}` });
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

module.exports = router;
