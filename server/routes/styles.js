const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { authMiddleware, adminOnly } = require('../middleware/auth');

const router = express.Router();

const REFS_DIR = path.join(__dirname, '..', 'uploads', 'references');
if (!fs.existsSync(REFS_DIR)) fs.mkdirSync(REFS_DIR, { recursive: true });

const refStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, REFS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `ref-${uuidv4()}${ext}`);
  },
});
const uploadRef = multer({ storage: refStorage, limits: { fileSize: 10 * 1024 * 1024 } });

// GET /api/styles — all users can read styles
router.get('/', authMiddleware, (req, res) => {
  const db = getDb();
  const styles = db.prepare('SELECT * FROM styles ORDER BY is_default DESC, name ASC').all();
  const refs = db.prepare('SELECT * FROM style_references ORDER BY created_at ASC').all();

  const stylesWithRefs = styles.map(s => ({
    ...s,
    references: refs.filter(r => r.style_id === s.id).map(r => ({
      ...r,
      url: `/api/styles/references/${r.id}/image`,
    })),
  }));

  res.json(stylesWithRefs);
});

// GET /api/styles/:id
router.get('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  const style = db.prepare('SELECT * FROM styles WHERE id = ?').get(req.params.id);
  if (!style) return res.status(404).json({ error: 'Style not found' });
  const refs = db.prepare('SELECT * FROM style_references WHERE style_id = ?').all(req.params.id);
  res.json({ ...style, references: refs.map(r => ({ ...r, url: `/api/styles/references/${r.id}/image` })) });
});

// POST /api/styles — admin only
router.post('/', authMiddleware, adminOnly, (req, res) => {
  const { name, description, prompt_prefix, prompt_suffix, color, icon, scene_pattern } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });

  const db = getDb();
  const id = uuidv4();
  const patternStr = Array.isArray(scene_pattern) ? JSON.stringify(scene_pattern) : (scene_pattern || '["image"]');
  db.prepare(`
    INSERT INTO styles (id, name, description, prompt_prefix, prompt_suffix, color, icon, scene_pattern, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, description || '', prompt_prefix || '', prompt_suffix || '', color || '#6366F1', icon || '🎬', patternStr, req.user.id);

  const style = db.prepare('SELECT * FROM styles WHERE id = ?').get(id);
  res.status(201).json({ ...style, references: [] });
});

// PUT /api/styles/:id — admin only
router.put('/:id', authMiddleware, adminOnly, (req, res) => {
  const db = getDb();
  const { name, description, prompt_prefix, prompt_suffix, color, icon, scene_pattern } = req.body;
  const patternStr = scene_pattern
    ? (Array.isArray(scene_pattern) ? JSON.stringify(scene_pattern) : scene_pattern)
    : null;
  db.prepare(`
    UPDATE styles SET
      name = COALESCE(?, name),
      description = COALESCE(?, description),
      prompt_prefix = COALESCE(?, prompt_prefix),
      prompt_suffix = COALESCE(?, prompt_suffix),
      color = COALESCE(?, color),
      icon = COALESCE(?, icon),
      scene_pattern = COALESCE(?, scene_pattern)
    WHERE id = ?
  `).run(name, description, prompt_prefix, prompt_suffix, color, icon, patternStr, req.params.id);

  const style = db.prepare('SELECT * FROM styles WHERE id = ?').get(req.params.id);
  const refs = db.prepare('SELECT * FROM style_references WHERE style_id = ?').all(req.params.id);
  res.json({ ...style, references: refs });
});

// DELETE /api/styles/:id — admin only (can't delete defaults)
router.delete('/:id', authMiddleware, adminOnly, (req, res) => {
  const db = getDb();
  const style = db.prepare('SELECT * FROM styles WHERE id = ?').get(req.params.id);
  if (!style) return res.status(404).json({ error: 'Not found' });
  if (style.is_default) return res.status(400).json({ error: 'Cannot delete default styles' });
  db.prepare('DELETE FROM styles WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// POST /api/styles/:id/references — upload subject or style reference image (admin only)
router.post('/:id/references', authMiddleware, adminOnly, uploadRef.single('image'), (req, res) => {
  const db = getDb();
  const style = db.prepare('SELECT id FROM styles WHERE id = ?').get(req.params.id);
  if (!style) return res.status(404).json({ error: 'Style not found' });

  const id = uuidv4();
  const refType = ['subject', 'style'].includes(req.body.reference_type) ? req.body.reference_type : 'subject';
  db.prepare(`
    INSERT INTO style_references (id, style_id, filename, original_name, file_path, description, reference_type)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.params.id, req.file.filename, req.file.originalname, req.file.path, req.body.description || '', refType);

  res.status(201).json({
    id, style_id: req.params.id, filename: req.file.filename,
    original_name: req.file.originalname, url: `/api/styles/references/${id}/image`,
    description: req.body.description || '', reference_type: refType,
  });
});

// GET /api/styles/references/:refId/image
router.get('/references/:refId/image', authMiddleware, (req, res) => {
  const db = getDb();
  const ref = db.prepare('SELECT * FROM style_references WHERE id = ?').get(req.params.refId);
  if (!ref) return res.status(404).json({ error: 'Not found' });
  res.sendFile(ref.file_path);
});

// DELETE /api/styles/references/:refId — admin only
router.delete('/references/:refId', authMiddleware, adminOnly, (req, res) => {
  const db = getDb();
  const ref = db.prepare('SELECT * FROM style_references WHERE id = ?').get(req.params.refId);
  if (!ref) return res.status(404).json({ error: 'Not found' });
  if (fs.existsSync(ref.file_path)) fs.unlinkSync(ref.file_path);
  db.prepare('DELETE FROM style_references WHERE id = ?').run(req.params.refId);
  res.json({ success: true });
});

module.exports = router;
