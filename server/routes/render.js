const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const RENDERS_DIR = path.join(__dirname, '..', 'renders');
const UPLOADS_BASE = process.env.UPLOADS_PATH || path.join(__dirname, '..', 'uploads');
const IMAGES_DIR = path.join(UPLOADS_BASE, 'images');
if (!fs.existsSync(RENDERS_DIR)) fs.mkdirSync(RENDERS_DIR, { recursive: true });

// Track active render jobs
const renderJobs = new Map();

// POST /api/render/:projectId — start rendering
router.post('/:projectId', authMiddleware, async (req, res) => {
  const db = getDb();
  const project = db.prepare(`
    SELECT p.*, s.prompt_prefix, s.prompt_suffix, s.name as style_name
    FROM projects p LEFT JOIN styles s ON s.id = p.style_id
    WHERE p.id = ?
  `).get(req.params.projectId);

  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (req.user.role !== 'admin' && project.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const scenes = db.prepare('SELECT * FROM scenes WHERE project_id = ? ORDER BY scene_order').all(req.params.projectId);
  if (!scenes.length) return res.status(400).json({ error: 'No scenes found' });

  // Require at least 1 scene with a generated image before starting FFmpeg
  const scenesWithImages = scenes.filter(s => s.image_url);
  if (scenesWithImages.length === 0) {
    return res.status(400).json({ error: 'No images generated yet — generate images for your scenes before rendering' });
  }

  const audioPath = project.audio_path;
  if (!audioPath || !fs.existsSync(audioPath)) {
    return res.status(400).json({ error: 'No audio file uploaded' });
  }

  // Check all scenes have images (demo or real)
  const missingScenesCount = scenes.filter(s => !s.image_url && !s.image_path).length;
  if (missingScenesCount > 0 && !req.body.usePlaceholders) {
    return res.status(400).json({
      error: `${missingScenesCount} scene(s) have no image. Generate images first or set usePlaceholders=true.`,
    });
  }

  const jobId = uuidv4();
  const outputFilename = `render-${project.id}-${Date.now()}.mp4`;
  const outputPath = path.join(RENDERS_DIR, outputFilename);

  db.prepare('UPDATE projects SET status = ?, render_path = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run('rendering', req.params.projectId);

  renderJobs.set(jobId, { status: 'processing', progress: 0, projectId: req.params.projectId });

  res.json({ jobId, message: 'Render started' });

  // Run render async
  runRender(jobId, project, scenes, audioPath, outputPath, outputFilename, db).catch(err => {
    console.error('Render failed:', err);
    renderJobs.set(jobId, { status: 'error', error: err.message, projectId: req.params.projectId });
    db.prepare("UPDATE projects SET status = 'error', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(req.params.projectId);
  });
});

async function runRender(jobId, project, scenes, audioPath, outputPath, outputFilename, db) {
  const tmpDir = path.join(RENDERS_DIR, `tmp-${jobId}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // Phase 1: Prepare local image paths
    const scenePaths = [];
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      let imgPath = null;

      // Resolve image path: extract filename from image_url or image_path and re-resolve
      // against IMAGES_DIR. This handles cases where the stored absolute path is stale
      // (e.g. after a container restart on Railway).
      const rawPath = scene.image_path || '';
      const rawUrl = scene.image_url || '';
      let filename = null;
      if (rawUrl) {
        // image_url = /api/generate/image-file/img-xxx.jpg
        filename = path.basename(rawUrl);
      } else if (rawPath) {
        filename = path.basename(rawPath);
      }

      if (filename) {
        const resolvedPath = path.join(IMAGES_DIR, filename);
        const resolvedExists = fs.existsSync(resolvedPath);
        console.log(`[render] Scene ${i + 1}: image_url="${rawUrl}" image_path="${rawPath}" resolved="${resolvedPath}" exists=${resolvedExists}`);
        if (resolvedExists) {
          imgPath = resolvedPath;
        }
      } else {
        console.log(`[render] Scene ${i + 1}: no image_url or image_path set — using placeholder`);
      }

      // Fallback: try stored absolute path directly (backward compat)
      if (!imgPath && rawPath && fs.existsSync(rawPath)) {
        console.log(`[render] Scene ${i + 1}: resolved path missing, falling back to stored image_path`);
        imgPath = rawPath;
      }

      if (!imgPath) {
        console.log(`[render] Scene ${i + 1}: image not found, using placeholder`);
        imgPath = await createPlaceholderImage(tmpDir, i, scene.text);
      }

      if (!imgPath || !fs.existsSync(imgPath)) {
        // Genuine fallback — no image available
        imgPath = await createPlaceholderImage(tmpDir, i, scene.text);
      }
      scenePaths.push({ path: imgPath, duration: Math.max(scene.duration || 5, 1) });
      renderJobs.get(jobId).progress = Math.round((i / scenes.length) * 10);
    }

    // Phase 2: Encode each scene into its own clip (one at a time to stay within memory limits)
    const FPS = 25;
    const clipPaths = [];

    for (let i = 0; i < scenePaths.length; i++) {
      const { path: imgPath, duration: dur } = scenePaths[i];
      const clipPath = path.join(tmpDir, `scene_${i + 1}.mp4`);

      // Static: scale to 1920x1080 and hold for scene duration
      const filter =
        `scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,` +
        `fps=${FPS},trim=duration=${dur},setpts=PTS-STARTPTS`;

      console.log(`[render ${jobId}] Scene ${i + 1}/${scenePaths.length}: encoding (${dur}s, ${frames} frames)...`);

      try {
        await renderSceneClip(imgPath, clipPath, filter, dur);
        clipPaths.push(clipPath);
        console.log(`[render ${jobId}] Scene ${i + 1} complete.`);
      } catch (err) {
        console.error(`[render ${jobId}] Scene ${i + 1} failed, skipping:`, err.message);
      }

      renderJobs.get(jobId).progress = Math.round(10 + ((i + 1) / scenePaths.length) * 70);
    }

    if (clipPaths.length === 0) {
      throw new Error('All scenes failed to encode — no clips to assemble');
    }

    // Phase 3: Write concat list and join clips (stream copy — nearly instant, no memory spike)
    const concatFile = path.join(tmpDir, 'concat.txt');
    fs.writeFileSync(
      concatFile,
      clipPaths.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n')
    );

    console.log(`[render ${jobId}] Concatenating ${clipPaths.length} clips via concat demuxer...`);
    renderJobs.get(jobId).progress = 85;

    const videoOnlyPath = path.join(tmpDir, 'video_only.mp4');
    await concatClips(concatFile, videoOnlyPath);

    // Phase 4: Mux audio into final output
    console.log(`[render ${jobId}] Muxing audio...`);
    renderJobs.get(jobId).progress = 93;

    await muxAudio(videoOnlyPath, audioPath, outputPath);

    console.log(`[render ${jobId}] Render complete -> ${outputPath}`);
    renderJobs.set(jobId, { status: 'complete', progress: 100, projectId: project.id, outputFilename });
    db.prepare(
      'UPDATE projects SET status = ?, render_path = ?, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run('complete', outputPath, project.id);

  } finally {
    // Clean up tmp dir (includes individual scene clips)
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// Encode a single image into a static video clip
function renderSceneClip(imgPath, clipPath, filter, duration) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(imgPath)
      .inputOptions(['-loop 1'])
      .videoFilter(filter)
      .outputOptions([
        '-t', String(duration),
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '26',
        '-threads', '1',
        '-bufsize', '2M',
        '-maxrate', '4M',
        '-pix_fmt', 'yuv420p',
        '-an',
      ])
      .output(clipPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// Join clip files using concat demuxer (stream copy — no re-encode, minimal memory)
function concatClips(concatFile, videoOnlyPath) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(concatFile)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions(['-c', 'copy', '-threads', '1'])
      .output(videoOnlyPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// Mux video + audio into the final output file
function muxAudio(videoOnlyPath, audioPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoOnlyPath)
      .input(audioPath)
      .outputOptions([
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-shortest',
        '-movflags', '+faststart',
        '-threads', '1',
      ])
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

async function createPlaceholderImage(tmpDir, index, text) {
  const sharp = require('sharp');
  const colors = ['#1e1b4b', '#14532d', '#7c2d12', '#0c4a6e', '#4a1d96'];
  const color = colors[index % colors.length];

  const svg = `
    <svg width="1920" height="1080" xmlns="http://www.w3.org/2000/svg">
      <rect width="1920" height="1080" fill="${color}"/>
      <text x="960" y="500" font-family="Arial" font-size="48" fill="white"
        text-anchor="middle" dy="0">Scene ${index + 1}</text>
      <text x="960" y="580" font-family="Arial" font-size="32" fill="#aaa"
        text-anchor="middle" dy="0">${text.slice(0, 80).replace(/[<>&'"]/g, '')}</text>
    </svg>`;

  const outPath = path.join(tmpDir, `placeholder-${index}.jpg`);
  await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toFile(outPath);
  return outPath;
}

// GET /api/render/status/:jobId
router.get('/status/:jobId', authMiddleware, (req, res) => {
  const job = renderJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// GET /api/render/download/:projectId
router.get('/download/:projectId', authMiddleware, (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && project.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (!project.render_path || !fs.existsSync(project.render_path)) {
    return res.status(404).json({ error: 'No render available' });
  }

  const filename = `${project.title.replace(/[^a-z0-9]/gi, '_')}_rough_cut.mp4`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'video/mp4');
  res.sendFile(project.render_path);
});

module.exports = router;
