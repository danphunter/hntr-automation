const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');
const { getSceneMediaType } = require('../utils/mediaStyle');

const router = express.Router();
const UPLOADS_BASE = process.env.UPLOADS_PATH || path.join(__dirname, '..', 'uploads');
const IMAGES_DIR = path.join(UPLOADS_BASE, 'images');
const VIDEOS_DIR = path.join(UPLOADS_BASE, 'videos');
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });
if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });

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

  // Check niche media style — skip image generation for video scenes
  if (project.niche_id) {
    const niche = db.prepare('SELECT * FROM niches WHERE id = ?').get(project.niche_id);
    if (niche) {
      const styleConfig = JSON.parse(niche.style_config || '{}');
      const mediaType = getSceneMediaType(scene.scene_order, niche.style_type, styleConfig);
      if (mediaType === 'video') {
        console.log(`[generate] TODO: video generation for scene ${scene.scene_order} (scene id: ${scene.id}) — skipping`);
        return res.json({ skipped: true, reason: 'video', scene_order: scene.scene_order });
      }
    }
  }

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

// GET /api/generate/video-file/:filename
router.get('/video-file/:filename', (req, res) => {
  const vidPath = path.join(VIDEOS_DIR, path.basename(req.params.filename));
  if (!vidPath.startsWith(VIDEOS_DIR)) return res.status(404).json({ error: 'Not found' });
  if (!fs.existsSync(vidPath)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(vidPath);
});

// POST /api/generate/scene/:sceneId/animate
router.post('/scene/:sceneId/animate', authMiddleware, async (req, res) => {
  const db = getDb();
  const scene = db.prepare('SELECT * FROM scenes WHERE id = ?').get(req.params.sceneId);
  if (!scene) return res.status(404).json({ error: 'Scene not found' });
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(scene.project_id);
  if (req.user.role !== 'admin' && project.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

  if (!scene.image_url && !scene.image_path) {
    return res.status(400).json({ error: 'Scene has no generated image to animate' });
  }

  const settings = getSettings(db);
  const useApiToken = settings.useapi_token?.trim();
  if (!useApiToken) {
    return res.status(400).json({ error: 'No useapi.net token configured — add one in Settings.' });
  }

  // Read image as base64 for firstFrame
  let imageBase64;
  try {
    const imgFilename = scene.image_path
      ? path.basename(scene.image_path)
      : path.basename(scene.image_url);
    const imgPath = path.join(IMAGES_DIR, imgFilename);
    const imgBuffer = fs.readFileSync(imgPath);
    imageBase64 = `data:image/jpeg;base64,${imgBuffer.toString('base64')}`;
  } catch (err) {
    console.error('[animate] Failed to read image file:', err.message);
    return res.status(500).json({ error: `Failed to read scene image: ${err.message}` });
  }

  const prompt = scene.image_prompt || scene.text;

  const fetch = (await import('node-fetch')).default;

  // Start video generation
  let startRes;
  try {
    startRes = await fetch('https://api.useapi.net/v1/google-flow/videos', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + useApiToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt,
        model: 'veo-3.1-fast-relaxed',
        firstFrame: { imageUrl: imageBase64 },
      }),
    });
  } catch (err) {
    console.error('[animate] useapi.net fetch error:', err.message);
    return res.status(500).json({ error: `Video generation request failed: ${err.message}` });
  }

  if (startRes.status === 429) return res.status(429).json({ error: 'Rate limited by useapi.net — try again shortly.' });
  if (startRes.status === 402) return res.status(402).json({ error: 'useapi.net subscription required or quota exceeded.' });
  if (startRes.status === 596) return res.status(596).json({ error: 'useapi.net Google session expired — refresh Google cookies in your useapi.net account.' });

  if (!startRes.ok) {
    const text = await startRes.text();
    console.error('[animate] useapi.net error:', startRes.status, text.slice(0, 500));
    return res.status(500).json({ error: `useapi.net error ${startRes.status}: ${text.slice(0, 200)}` });
  }

  let result = await startRes.json();
  console.log('[animate] Initial response:', JSON.stringify(result).slice(0, 500));

  // Helper to extract video URL from response
  function extractVideoUrl(data) {
    return data?.media?.[0]?.video?.generatedVideo?.uri
      || data?.media?.[0]?.video?.uri
      || data?.videoUrl
      || data?.url
      || null;
  }

  // Poll for completion if we have a mediaId and no immediate URL
  let videoUrl = extractVideoUrl(result);
  const mediaId = result?.mediaId || result?.id || result?.jobId;

  if (!videoUrl && mediaId) {
    const maxWaitMs = 5 * 60 * 1000; // 5 minutes
    const pollMs = 5000;
    const deadline = Date.now() + maxWaitMs;
    console.log(`[animate] Polling for mediaId=${mediaId}...`);

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, pollMs));
      try {
        const pollRes = await fetch(`https://api.useapi.net/v1/google-flow/videos/${mediaId}`, {
          headers: { 'Authorization': 'Bearer ' + useApiToken },
        });
        if (!pollRes.ok) {
          console.warn('[animate] Poll returned', pollRes.status);
          continue;
        }
        result = await pollRes.json();
        videoUrl = extractVideoUrl(result);
        const status = result?.status;
        console.log(`[animate] Poll status=${status}, hasUrl=${!!videoUrl}`);
        if (videoUrl) break;
        if (status === 'error' || status === 'failed') {
          return res.status(500).json({ error: 'Video generation failed: ' + (result.error || result.message || 'unknown') });
        }
      } catch (err) {
        console.warn('[animate] Poll error:', err.message);
      }
    }
  }

  if (!videoUrl) {
    console.error('[animate] No video URL after polling. Last result:', JSON.stringify(result).slice(0, 500));
    return res.status(500).json({ error: 'Video generation succeeded but no video URL returned.' });
  }

  // Download and save the video locally
  let videoBuffer;
  try {
    const vidRes = await fetch(videoUrl);
    if (!vidRes.ok) throw new Error(`Failed to fetch video: ${vidRes.status}`);
    videoBuffer = Buffer.from(await vidRes.arrayBuffer());
  } catch (err) {
    console.error('[animate] Failed to download generated video:', err.message);
    return res.status(500).json({ error: `Failed to download generated video: ${err.message}` });
  }

  const vidFilename = `vid-${uuidv4()}.mp4`;
  const vidPath = path.join(VIDEOS_DIR, vidFilename);
  fs.writeFileSync(vidPath, videoBuffer);

  const localVideoUrl = `/api/generate/video-file/${vidFilename}`;
  db.prepare('UPDATE scenes SET video_url = ?, video_path = ?, video_status = ? WHERE id = ?')
    .run(localVideoUrl, vidPath, 'generated', scene.id);

  res.json({ video_url: localVideoUrl });
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
