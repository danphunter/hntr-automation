const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
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
        (SELECT COUNT(*) FROM scenes s WHERE s.project_id = p.id AND s.image_url != '' AND s.image_url IS NOT NULL) as image_count,
        (SELECT COUNT(*) FROM scenes s WHERE s.project_id = p.id) as scene_count
      FROM projects p
      LEFT JOIN users u ON p.user_id = u.id
      ORDER BY p.created_at DESC
    `).all();
  } else {
    projects = db.prepare(`
      SELECT p.*, u.display_name as editor_name,
        (SELECT COUNT(*) FROM scenes s WHERE s.project_id = p.id AND s.image_url != '' AND s.image_url IS NOT NULL) as image_count,
        (SELECT COUNT(*) FROM scenes s WHERE s.project_id = p.id) as scene_count
      FROM projects p
      LEFT JOIN users u ON p.user_id = u.id
      WHERE p.user_id = ?
      ORDER BY p.created_at DESC
    `).all(req.user.id);
  }
  res.json(projects);
});

// POST /api/projects
router.post('/', authMiddleware, (req, res) => {
  const { title, script, style, notes } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });

  const db = getDb();
  const id = uuidv4();
  db.prepare(`
    INSERT INTO projects (id, user_id, title, script, style, notes, status)
    VALUES (?, ?, ?, ?, ?, ?, 'draft')
  `).run(id, req.user.id, title, script || '', style || 'Bible Animation', notes || '');

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  res.status(201).json(project);
});

// GET /api/projects/:id
router.get('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  const project = db.prepare(`
    SELECT p.*, u.display_name as editor_name, u.username as editor_username
    FROM projects p LEFT JOIN users u ON p.user_id = u.id
    WHERE p.id = ?
  `).get(req.params.id);

  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (req.user.role !== 'admin' && project.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const scenes = db.prepare('SELECT * FROM scenes WHERE project_id = ? ORDER BY scene_order').all(req.params.id);
  res.json({ ...project, scenes });
});

// PUT /api/projects/:id
router.put('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && project.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const { title, script, style, status, notes, assigned_to } = req.body;
  db.prepare(`
    UPDATE projects SET
      title = COALESCE(?, title),
      script = COALESCE(?, script),
      style = COALESCE(?, style),
      status = COALESCE(?, status),
      notes = COALESCE(?, notes),
      assigned_to = COALESCE(?, assigned_to),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(title, script, style, status, notes, assigned_to, req.params.id);

  const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// DELETE /api/projects/:id
router.delete('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && project.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// POST /api/projects/:id/upload-audio
router.post('/:id/upload-audio', authMiddleware, upload.single('audio'), (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && project.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (project.audio_path && fs.existsSync(project.audio_path)) {
    fs.unlinkSync(project.audio_path);
  }

  db.prepare(`
    UPDATE projects SET audio_path = ?, audio_filename = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(req.file.path, req.file.originalname, req.params.id);

  res.json({ success: true, filename: req.file.originalname, path: req.file.filename });
});

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
    INSERT INTO scenes (id, project_id, scene_order, text, start_time, end_time, duration, image_prompt, image_url, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((scenes) => {
    for (const [i, s] of scenes.entries()) {
      insert.run(
        s.id || uuidv4(), req.params.id, i,
        s.text, s.start_time || 0, s.end_time || 5, s.duration || 5,
        s.image_prompt || '', s.image_url || '', s.status || 'pending'
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
