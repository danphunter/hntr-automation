const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const RENDERS_DIR = path.join(__dirname, '..', 'renders');
const IMAGES_DIR = path.join(__dirname, '..', 'uploads', 'images');
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
    // Download/copy images for each scene, prepare local paths
    const scenePaths = [];
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      let imgPath = scene.image_path;

      if (!imgPath || !fs.existsSync(imgPath)) {
        // Use placeholder image (colored rectangle with text for demo)
        imgPath = await createPlaceholderImage(tmpDir, i, scene.text);
      }

      scenePaths.push({ path: imgPath, duration: Math.max(scene.duration || 5, 1) });
      renderJobs.get(jobId).progress = Math.round((i / scenes.length) * 30);
    }

    // Build ffmpeg command
    await buildVideo(jobId, scenePaths, audioPath, outputPath, db, project.id, outputFilename);
  } finally {
    // Cleanup tmp
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

function buildVideo(jobId, scenePaths, audioPath, outputPath, db, projectId, outputFilename) {
  return new Promise((resolve, reject) => {
    // Build filter complex for Ken Burns + concat
    const filterParts = [];
    const concatInputs = [];
    const FPS = 25;

    let cmd = ffmpeg();

    // Add all image inputs
    for (let i = 0; i < scenePaths.length; i++) {
      cmd = cmd.input(scenePaths[i].path);
    }

    // Add audio
    cmd = cmd.input(audioPath);

    // Build filter complex
    for (let i = 0; i < scenePaths.length; i++) {
      const dur = scenePaths[i].duration;
      const frames = Math.ceil(dur * FPS);
      const zoomDir = i % 2 === 0 ? 'in' : 'out';
      const startZoom = zoomDir === 'in' ? 1.0 : 1.3;
      const endZoom = zoomDir === 'in' ? 1.3 : 1.0;
      const zoomStep = (endZoom - startZoom) / frames;
      const zoomExpr = zoomDir === 'in'
        ? `min(zoom+${zoomStep.toFixed(6)},${endZoom})`
        : `max(zoom-${Math.abs(zoomStep).toFixed(6)},${endZoom})`;

      filterParts.push(
        `[${i}:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,` +
        `zoompan=z='${zoomExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1920x1080:fps=${FPS},` +
        `setpts=PTS-STARTPTS[v${i}]`
      );
      concatInputs.push(`[v${i}]`);
    }

    const filterComplex =
      filterParts.join('; ') +
      `; ${concatInputs.join('')}concat=n=${scenePaths.length}:v=1:a=0[outv]`;

    renderJobs.get(jobId).progress = 40;

    cmd
      .complexFilter(filterComplex)
      .outputOptions([
        '-map [outv]',
        `-map ${scenePaths.length}:a`,
        '-c:v libx264',
        '-preset fast',
        '-crf 22',
        '-c:a aac',
        '-b:a 192k',
        '-shortest',
        '-movflags +faststart',
        '-pix_fmt yuv420p',
      ])
      .output(outputPath)
      .on('progress', (progress) => {
        const pct = Math.min(90, 40 + Math.round((progress.percent || 0) * 0.5));
        if (renderJobs.has(jobId)) renderJobs.get(jobId).progress = pct;
      })
      .on('end', () => {
        renderJobs.set(jobId, { status: 'complete', progress: 100, projectId, outputFilename });
        db.prepare(
          'UPDATE projects SET status = ?, render_path = ?, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        ).run('complete', outputPath, projectId);
        resolve();
      })
      .on('error', (err) => {
        reject(err);
      })
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

  const sanitized = project.title.replace(/[\\/:*?"<>|]/g, '-').trim();
  const filename = `${sanitized}.mp4`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'video/mp4');
  res.sendFile(project.render_path);
});

module.exports = router;
