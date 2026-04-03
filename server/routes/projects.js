const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { authMiddleware, adminOnly } = require('../middleware/auth');

const router = express.Router();

// Use UPLOADS_PATH set by server/index.js (persistent on Railway), fallback local
const UPLOADS_DIR = process.env.UPLOADS_PATH || path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `audio-${uuidv4()}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

// GET /api/projects
router.get('/', authMiddleware, (req, res) => {
  const db = getDb();
  let projects;
  if (req.user.role === 'admin') {
    projects = db.prepare(`
      SELECT p.*, u.display_name as editor_name, u.username as editor_username,
        n.name as niche_name, n.style_type, n.style_config,
        (SELECT COUNT(*) FROM scenes s WHERE s.project_id = p.id AND s.image_url != '' AND s.image_url IS NOT NULL) as image_count,
        (SELECT COUNT(*) FROM scenes s WHERE s.project_id = p.id) as scene_count
      FROM projects p
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN niches n ON p.niche_id = n.id
      WHERE p.deleted_at IS NULL
      ORDER BY p.created_at DESC
    `).all();
  } else {
    projects = db.prepare(`
      SELECT p.*, u.display_name as editor_name,
        n.name as niche_name, n.style_type, n.style_config,
        (SELECT COUNT(*) FROM scenes s WHERE s.project_id = p.id AND s.image_url != '' AND s.image_url IS NOT NULL) as image_count,
        (SELECT COUNT(*) FROM scenes s WHERE s.project_id = p.id) as scene_count
      FROM projects p
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN niches n ON p.niche_id = n.id
      WHERE p.user_id = ? AND p.deleted_at IS NULL
      ORDER BY p.created_at DESC
    `).all(req.user.id);
  }
  res.json(projects.map(p => ({
    ...p,
    style_config: p.style_config ? JSON.parse(p.style_config) : null,
  })));
});

// POST /api/projects
router.post('/', authMiddleware, (req, res) => {
  const { title, script, style, notes, niche_id } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });

  const db = getDb();
  const id = uuidv4();
  db.prepare(`
    INSERT INTO projects (id, user_id, title, script, style, notes, niche_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')
  `).run(id, req.user.id, title, script || '', style || 'Bible Animation', notes || '', niche_id || null);

  const project = db.prepare(`
    SELECT p.*, n.name as niche_name, n.style_type, n.style_config
    FROM projects p LEFT JOIN niches n ON p.niche_id = n.id
    WHERE p.id = ?
  `).get(id);
  res.status(201).json({
    ...project,
    style_config: project.style_config ? JSON.parse(project.style_config) : null,
  });
});

// GET /api/projects/deleted — admin-only, lists soft-deleted projects
router.get('/deleted', authMiddleware, adminOnly, (req, res) => {
  const db = getDb();
  const projects = db.prepare(`
    SELECT p.*, u.display_name as editor_name, u.username as editor_username
    FROM projects p
    LEFT JOIN users u ON p.user_id = u.id
    WHERE p.deleted_at IS NOT NULL
    ORDER BY p.deleted_at DESC
  `).all();
  res.json(projects);
});

// GET /api/projects/:id
router.get('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  const project = db.prepare(`
    SELECT p.*, u.display_name as editor_name, u.username as editor_username,
      n.name as niche_name, n.style_type, n.style_config
    FROM projects p
    LEFT JOIN users u ON p.user_id = u.id
    LEFT JOIN niches n ON p.niche_id = n.id
    WHERE p.id = ? AND p.deleted_at IS NULL
  `).get(req.params.id);

  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (req.user.role !== 'admin' && project.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const scenes = db.prepare('SELECT * FROM scenes WHERE project_id = ? ORDER BY scene_order').all(req.params.id);
  res.json({
    ...project,
    style_config: project.style_config ? JSON.parse(project.style_config) : null,
    scenes,
  });
});

// PUT /api/projects/:id
router.put('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && project.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const { title, script, style, style_id, status, notes, assigned_to, niche_id } = req.body;
  db.prepare(`
    UPDATE projects SET
      title = COALESCE(?, title),
      script = COALESCE(?, script),
      style = COALESCE(?, style),
      style_id = COALESCE(?, style_id),
      niche_id = CASE WHEN ? IS NOT NULL THEN ? ELSE niche_id END,
      status = COALESCE(?, status),
      notes = COALESCE(?, notes),
      assigned_to = COALESCE(?, assigned_to),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(title, script, style, style_id || null, niche_id || null, niche_id || null, status, notes, assigned_to, req.params.id);

  const updated = db.prepare(`
    SELECT p.*, n.name as niche_name, n.style_type, n.style_config
    FROM projects p LEFT JOIN niches n ON p.niche_id = n.id
    WHERE p.id = ?
  `).get(req.params.id);
  res.json({
    ...updated,
    style_config: updated.style_config ? JSON.parse(updated.style_config) : null,
  });
});

// DELETE /api/projects/:id — soft delete
router.delete('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && project.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  db.prepare('UPDATE projects SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// POST /api/projects/:id/restore — admin-only, clears deleted_at
router.post('/:id/restore', authMiddleware, adminOnly, (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ? AND deleted_at IS NOT NULL').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found or not deleted' });

  db.prepare('UPDATE projects SET deleted_at = NULL WHERE id = ?').run(req.params.id);
  const restored = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  res.json(restored);
});

// POST /api/projects/:id/upload-audio
router.post('/:id/upload-audio', authMiddleware, (req, res) => {
  upload.single('audio')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }
    if (!req.file) return res.status(400).json({ error: 'No audio file received' });

    try {
      const db = getDb();
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
      if (!project) return res.status(404).json({ error: 'Not found' });
      if (req.user.role !== 'admin' && project.user_id !== req.user.id) {
        return res.status(403).json({ error: 'Access denied' });
      }

      if (project.audio_path && fs.existsSync(project.audio_path)) {
        try { fs.unlinkSync(project.audio_path); } catch {}
      }

      db.prepare(`
        UPDATE projects SET audio_path = ?, audio_filename = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(req.file.path, req.file.originalname, req.params.id);

      res.json({ success: true, filename: req.file.originalname, path: req.file.filename });
    } catch (e) {
      console.error('Upload handler error:', e);
      res.status(500).json({ error: e.message || 'Server error' });
    }
  });
});

// POST /api/projects/:id/transcribe — upload audio to AssemblyAI and start job (async)
router.post('/:id/transcribe', authMiddleware, async (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && project.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (!project.audio_path || !fs.existsSync(project.audio_path)) {
    return res.status(400).json({ error: 'No audio file uploaded yet' });
  }

  const settings = db.prepare('SELECT key, value FROM settings').all();
  const settingsMap = Object.fromEntries(settings.map(r => [r.key, r.value]));
  const apiKey = settingsMap.assemblyai_api_key?.trim();
  if (!apiKey) return res.status(400).json({ error: 'AssemblyAI API key not configured in Settings' });

  try {
    const fetch = (await import('node-fetch')).default;

    // 1. Upload audio file to AssemblyAI
    const audioBuffer = fs.readFileSync(project.audio_path);
    const uploadRes = await fetch('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: { authorization: apiKey },
      body: audioBuffer,
    });
    if (!uploadRes.ok) {
      const t = await uploadRes.text();
      throw new Error(`AssemblyAI upload failed (${uploadRes.status}): ${t.slice(0, 200)}`);
    }
    const { upload_url } = await uploadRes.json();

    // 2. Start transcription job (do NOT wait for completion)
    const jobRes = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: { authorization: apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ audio_url: upload_url, speech_models: ['universal-2'] }),
    });
    if (!jobRes.ok) {
      const t = await jobRes.text();
      throw new Error(`AssemblyAI job start failed (${jobRes.status}): ${t.slice(0, 200)}`);
    }
    const { id: jobId } = await jobRes.json();

    // 3. Save job ID and mark as processing — return immediately
    db.prepare(`UPDATE projects SET transcribe_job_id = ?, transcribe_status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(jobId, req.params.id);

    res.json({ status: 'processing', jobId });
  } catch (err) {
    console.error('Transcription start error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/projects/:id/transcribe-status — check transcription progress
router.get('/:id/transcribe-status', authMiddleware, async (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && project.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (!project.transcribe_job_id) {
    return res.status(400).json({ error: 'No transcription job started' });
  }
  if (project.transcribe_status === 'completed') {
    // Already processed — return saved scenes
    const savedScenes = db.prepare('SELECT * FROM scenes WHERE project_id = ? ORDER BY scene_order').all(req.params.id);
    return res.json({ status: 'completed', scenes: savedScenes });
  }

  const settings = db.prepare('SELECT key, value FROM settings').all();
  const apiKey = Object.fromEntries(settings.map(r => [r.key, r.value])).assemblyai_api_key?.trim();
  if (!apiKey) return res.status(400).json({ error: 'AssemblyAI API key not configured' });

  try {
    const fetch = (await import('node-fetch')).default;
    const statusRes = await fetch(`https://api.assemblyai.com/v2/transcript/${project.transcribe_job_id}`, {
      headers: { authorization: apiKey },
    });
    const data = await statusRes.json();

    if (data.status === 'error') {
      db.prepare(`UPDATE projects SET transcribe_status = 'error', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(req.params.id);
      return res.json({ status: 'error', message: data.error });
    }

    if (data.status !== 'completed') {
      return res.json({ status: 'processing' });
    }

    // Completed — process into scenes and save
    const scenes = buildScenesFromTranscript(data);

    const overrideScript = req.body.overrideScript !== false;
    if (overrideScript || !project.script?.trim()) {
      db.prepare('UPDATE projects SET script = ? WHERE id = ?').run(data.text, req.params.id);
    }

    db.prepare('DELETE FROM scenes WHERE project_id = ?').run(req.params.id);
    const insert = db.prepare(`
      INSERT INTO scenes (id, project_id, scene_order, text, start_time, end_time, duration, image_prompt, image_url, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, '', '', 'pending')
    `);
    db.transaction(sceneList => {
      sceneList.forEach((s, i) => insert.run(uuidv4(), req.params.id, i, s.text, s.start_time, s.end_time, s.duration));
    })(scenes);

    db.prepare(`UPDATE projects SET transcribe_status = 'completed', status = 'in_progress', updated_at = CURRENT_TIMESTAMP,
      started_at = CASE WHEN started_at IS NULL THEN CURRENT_TIMESTAMP ELSE started_at END
      WHERE id = ?`).run(req.params.id);

    const savedScenes = db.prepare('SELECT * FROM scenes WHERE project_id = ? ORDER BY scene_order').all(req.params.id);
    res.json({ status: 'completed', scenes: savedScenes });
  } catch (err) {
    console.error('Transcription status error:', err);
    res.status(500).json({ error: err.message });
  }
});

function buildScenesFromTranscript(transcript) {
  const words = transcript.words || [];
  if (!words.length) {
    const dur = Math.max(Math.round((transcript.audio_duration || 5000) / 1000), 1);
    return [{ text: transcript.text || '', start_time: 0, end_time: dur, duration: dur }];
  }

  const scenes = [];
  let current = [];

  const flush = () => {
    if (!current.length) return;
    const text = current.map(w => w.text).join(' ');
    const start_time = Math.round(current[0].start / 10) / 100;
    const end_time = Math.round(current[current.length - 1].end / 10) / 100;
    const duration = Math.max(Math.round((end_time - start_time) * 100) / 100, 0.5);
    scenes.push({ text, start_time, end_time, duration });
    current = [];
  };

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    current.push(w);
    const endsWithPunct = /[.!?]$/.test(w.text);
    const longPause = i < words.length - 1 && (words[i + 1].start - w.end) > 1500;
    // Flush at sentence boundary (with at least 5 words to avoid tiny scenes)
    if ((endsWithPunct || longPause) && current.length >= 5) flush();
  }
  flush();

  return scenes.length ? scenes : [{ text: transcript.text, start_time: 0, end_time: 5, duration: 5 }];
}

// GET /api/projects/:id/audio
router.get('/:id/audio', authMiddleware, (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project || !project.audio_path) return res.status(404).json({ error: 'No audio' });
  if (req.user.role !== 'admin' && project.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }
  res.sendFile(project.audio_path);
});

// POST /api/projects/:id/scenes - Save all scenes
router.post('/:id/scenes', authMiddleware, (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && project.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const { scenes } = req.body;
  db.prepare('DELETE FROM scenes WHERE project_id = ?').run(req.params.id);

  const insert = db.prepare(`
    INSERT INTO scenes (id, project_id, scene_order, text, start_time, end_time, duration, image_prompt, image_url, status, video_url, video_path, video_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((scenes) => {
    for (const [i, s] of scenes.entries()) {
      insert.run(
        s.id || uuidv4(), req.params.id, i,
        s.text, s.start_time || 0, s.end_time || 5, s.duration || 5,
        s.image_prompt || '', s.image_url || '', s.status || 'pending',
        s.video_url || null, s.video_path || null, s.video_status || null
      );
    }
  });

  insertMany(scenes);

  // Set started_at only the first time (when it's still null)
  db.prepare(`UPDATE projects SET status = 'in_progress', updated_at = CURRENT_TIMESTAMP,
    started_at = CASE WHEN started_at IS NULL THEN CURRENT_TIMESTAMP ELSE started_at END
    WHERE id = ?`).run(req.params.id);

  const saved = db.prepare('SELECT * FROM scenes WHERE project_id = ? ORDER BY scene_order').all(req.params.id);
  res.json(saved);
});

// PUT /api/projects/:id/scenes/:sceneId
router.put('/:id/scenes/:sceneId', authMiddleware, (req, res) => {
  const db = getDb();
  const { text, start_time, end_time, duration, image_prompt, image_url, status } = req.body;
  db.prepare(`
    UPDATE scenes SET
      text = COALESCE(?, text),
      start_time = COALESCE(?, start_time),
      end_time = COALESCE(?, end_time),
      duration = COALESCE(?, duration),
      image_prompt = COALESCE(?, image_prompt),
      image_url = COALESCE(?, image_url),
      status = COALESCE(?, status)
    WHERE id = ? AND project_id = ?
  `).run(text, start_time, end_time, duration, image_prompt, image_url, status, req.params.sceneId, req.params.id);

  const scene = db.prepare('SELECT * FROM scenes WHERE id = ?').get(req.params.sceneId);
  res.json(scene);
});

module.exports = router;
