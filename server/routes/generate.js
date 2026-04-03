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

async function generateViaUseApi(useApiToken, prompt, referenceImages = []) {
  const fetch = (await import('node-fetch')).default;
  const body = {
    prompt,
    model: 'nano-banana-2',
    aspectRatio: '16:9',
    count: 1,
  };
  // Re-upload any refs missing mediaGenerationId
  for (const ref of referenceImages) {
    if (!ref.mediaGenerationId) {
      try {
        let imgBuffer = null;
        if (ref.filePath) {
          try { imgBuffer = require('fs').readFileSync(ref.filePath); } catch (_) {}
        }
        if (!imgBuffer && ref.imageData) {
          imgBuffer = Buffer.from(ref.imageData, 'base64');
        }
        if (imgBuffer) {
          const uploadData = await uploadAssetToUseApi(useApiToken, imgBuffer, 'image/jpeg');
          const uploadJson = await uploadData.json();
          ref.mediaGenerationId = uploadJson?.mediaGenerationId?.mediaGenerationId || uploadJson?.mediaGenerationId || uploadJson?.id;
          console.log(`Re-uploaded reference image, got mediaGenerationId: ${ref.mediaGenerationId}`);
        } else {
          console.warn('Reference image has no filePath or imageData — cannot re-upload');
        }
      } catch (err) {
        console.error('Failed to re-upload reference image:', err.message);
      }
    }
  }
  const refs = (referenceImages || []).filter(r => r.mediaGenerationId).slice(0, 10);
  refs.forEach((ref, i) => { body[`reference_${i + 1}`] = ref.mediaGenerationId; });
  const response = await fetch('https://api.useapi.net/v1/google-flow/images', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + useApiToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return response;
}

async function saveImageFromBuffer(buffer) {
  const filename = `img-${uuidv4()}.jpg`;
  const imgPath = path.join(IMAGES_DIR, filename);
  fs.writeFileSync(imgPath, buffer);
  return { filename, imgPath };
}

// -- useapi.net asset upload (returns mediaGenerationId) ----------------------

async function uploadAssetToUseApi(useApiToken, imageBuffer, mimeType) {
  const fetch = (await import('node-fetch')).default;
  const response = await fetch('https://api.useapi.net/v1/google-flow/assets', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + useApiToken,
      'Content-Type': mimeType,
    },
    body: imageBuffer,
    signal: AbortSignal.timeout(30000),
  });
  return response;
}

// -- useapi.net Google Flow video generation ----------------------------------

async function generateVideoViaUseApi(useApiToken, prompt, startImage, referenceImages = []) {
  const fetch = (await import('node-fetch')).default;
  const body = {
    prompt,
    model: 'veo-3.1-fast',
    aspectRatio: 'landscape',
    startImage,
  };
  // Re-upload any refs missing mediaGenerationId
  for (const ref of referenceImages) {
    if (!ref.mediaGenerationId) {
      try {
        let imgBuffer = null;
        if (ref.filePath) {
          try { imgBuffer = require('fs').readFileSync(ref.filePath); } catch (_) {}
        }
        if (!imgBuffer && ref.imageData) {
          imgBuffer = Buffer.from(ref.imageData, 'base64');
        }
        if (imgBuffer) {
          const uploadData = await uploadAssetToUseApi(useApiToken, imgBuffer, 'image/jpeg');
          const uploadJson = await uploadData.json();
          ref.mediaGenerationId = uploadJson?.mediaGenerationId?.mediaGenerationId || uploadJson?.mediaGenerationId || uploadJson?.id;
          console.log(`Re-uploaded reference image, got mediaGenerationId: ${ref.mediaGenerationId}`);
        } else {
          console.warn('Reference image has no filePath or imageData — cannot re-upload');
        }
      } catch (err) {
        console.error('Failed to re-upload reference image:', err.message);
      }
    }
  }
  const refs = (referenceImages || []).filter(r => r.mediaGenerationId).slice(0, 3);
  refs.forEach((ref, i) => { body[`referenceImage_${i + 1}`] = ref.mediaGenerationId; });
  const response = await fetch('https://api.useapi.net/v1/google-flow/videos', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + useApiToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return response;
}

async function pollVideoJob(useApiToken, jobId, maxAttempts = 60) {
  const fetch = (await import('node-fetch')).default;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const res = await fetch(`https://api.useapi.net/v1/google-flow/videos/${jobId}`, {
      headers: { 'Authorization': 'Bearer ' + useApiToken },
    });
    if (!res.ok) throw new Error(`Poll failed: ${res.status}`);
    const data = await res.json();
    const status = (data.status || '').toLowerCase();
    if (status === 'completed' || status === 'succeeded' || status === 'success') return data;
    if (status === 'failed' || status === 'error') {
      throw new Error(`Video generation failed: ${data.error || data.message || status}`);
    }
  }
  throw new Error('Video generation timed out after 5 minutes');
}

function extractVideoUrl(result) {
  if (result?.media?.[0]?.video?.uri) return result.media[0].video.uri;
  if (result?.media?.[0]?.video?.url) return result.media[0].video.url;
  if (result?.media?.[0]?.videoUrl) return result.media[0].videoUrl;
  if (result?.videoUrl) return result.videoUrl;
  if (result?.url) return result.url;
  return null;
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

  // Append niche style_prompt if set
  if (project.niche_id) {
    const niche = db.prepare('SELECT * FROM niches WHERE id = ?').get(project.niche_id);
    if (niche?.style_prompt) {
      rawPrompt = `${rawPrompt}. Style: ${niche.style_prompt}`;
    }
  }

  const prompt = rawPrompt;

  // Get reference images from the project's niche
  let referenceImages = [];
  if (project.niche_id) {
    const niche = db.prepare('SELECT * FROM niches WHERE id = ?').get(project.niche_id);
    if (niche?.reference_images) {
      try { referenceImages = JSON.parse(niche.reference_images) || []; } catch {}
    }
  }

  let apiRes;
  try {
    apiRes = await generateViaUseApi(useApiToken, prompt, referenceImages);
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

// POST /api/generate/scene/:sceneId/animate (image-to-video)
router.post('/scene/:sceneId/animate', authMiddleware, async (req, res) => {
  const db = getDb();
  const scene = db.prepare('SELECT * FROM scenes WHERE id = ?').get(req.params.sceneId);
  if (!scene) return res.status(404).json({ error: 'Scene not found' });
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(scene.project_id);
  if (req.user.role !== 'admin' && project.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

  if (!scene.image_path || !fs.existsSync(scene.image_path)) {
    return res.status(400).json({ error: 'Scene has no generated image. Generate an image first.' });
  }

  const settings = getSettings(db);
  const useApiToken = settings.useapi_token?.trim();
  if (!useApiToken) {
    return res.status(400).json({ error: 'No useapi.net token configured — add one in Settings.' });
  }

  // Upload scene image to useapi.net to get a mediaGenerationId (startImage)
  let startImage;
  try {
    const imageBuffer = fs.readFileSync(scene.image_path);
    const mimeType = scene.image_path.endsWith('.png') ? 'image/png' : 'image/jpeg';
    const uploadRes = await uploadAssetToUseApi(useApiToken, imageBuffer, mimeType);
    if (!uploadRes.ok) {
      const text = await uploadRes.text();
      console.error('[animate] Asset upload failed:', uploadRes.status, text);
      return res.status(500).json({ error: `Failed to upload scene image to useapi.net: ${uploadRes.status} — ${text.slice(0, 300)}` });
    }
    const uploadData = await uploadRes.json();
    startImage = (uploadData.mediaGenerationId && uploadData.mediaGenerationId.mediaGenerationId) || uploadData.mediaGenerationId || uploadData.id;
    if (!startImage) {
      console.error('[animate] No mediaGenerationId in asset upload response:', JSON.stringify(uploadData).slice(0, 300));
      return res.status(500).json({ error: 'Asset upload succeeded but no mediaGenerationId returned.' });
    }
  } catch (err) {
    console.error('[animate] Asset upload error:', err.message);
    return res.status(500).json({ error: `Asset upload failed: ${err.message}` });
  }

  // Get reference images from the project's niche
  let referenceImages = [];
  if (project.niche_id) {
    const niche = db.prepare('SELECT * FROM niches WHERE id = ?').get(project.niche_id);
    if (niche?.reference_images) {
      try { referenceImages = JSON.parse(niche.reference_images) || []; } catch {}
    }
  }

  const prompt = scene.image_prompt || scene.text;

  let apiRes;
  try {
    apiRes = await generateVideoViaUseApi(useApiToken, prompt, startImage, referenceImages);
  } catch (err) {
    console.error('[animate] video request error:', err.message);
    return res.status(500).json({ error: `Video generation failed: ${err.message}` });
  }

  if (apiRes.status === 429) return res.status(429).json({ error: 'Rate limited by useapi.net — try again shortly.' });
  if (apiRes.status === 402) return res.status(402).json({ error: 'useapi.net subscription required or quota exceeded.' });
  if (!apiRes.ok) {
    const text = await apiRes.text();
    console.error('[animate] useapi.net error:', apiRes.status, text.slice(0, 500));
    return res.status(500).json({ error: `useapi.net error ${apiRes.status}: ${text.slice(0, 200)}` });
  }

  let result = await apiRes.json();
  console.log('[animate] Initial response:', JSON.stringify(result).slice(0, 500));

  let videoUrl = extractVideoUrl(result);
  if (!videoUrl) {
    const jobId = result.jobId || result.id || result.taskId;
    if (!jobId) {
      console.error('[animate] No video URL or job ID:', JSON.stringify(result).slice(0, 500));
      return res.status(500).json({ error: 'No video URL or job ID returned from useapi.net.' });
    }
    console.log(`[animate] Polling video job ${jobId}...`);
    try {
      result = await pollVideoJob(useApiToken, jobId);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
    videoUrl = extractVideoUrl(result);
    if (!videoUrl) {
      console.error('[animate] No video URL after polling:', JSON.stringify(result).slice(0, 500));
      return res.status(500).json({ error: 'Video generation completed but no URL found.' });
    }
  }

  // Download and save the video
  let videoBuffer;
  try {
    const fetch = (await import('node-fetch')).default;
    const vidRes = await fetch(videoUrl);
    if (!vidRes.ok) throw new Error(`Failed to fetch video: ${vidRes.status}`);
    videoBuffer = Buffer.from(await vidRes.arrayBuffer());
  } catch (err) {
    console.error('[animate] Download error:', err.message);
    return res.status(500).json({ error: `Failed to download video: ${err.message}` });
  }

  const filename = `vid-${uuidv4()}.mp4`;
  const vidPath = path.join(VIDEOS_DIR, filename);
  fs.writeFileSync(vidPath, videoBuffer);

  const localUrl = `/api/generate/video-file/${filename}`;
  db.prepare('UPDATE scenes SET video_url = ?, video_path = ? WHERE id = ?').run(localUrl, vidPath, scene.id);
  res.json({ video_url: localUrl, prompt });
});

// GET /api/generate/video-file/:filename
router.get('/video-file/:filename', (req, res) => {
  const vidPath = path.join(VIDEOS_DIR, path.basename(req.params.filename));
  if (!vidPath.startsWith(VIDEOS_DIR)) return res.status(404).json({ error: 'Not found' });
  if (!fs.existsSync(vidPath)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(vidPath);
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
