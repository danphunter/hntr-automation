const express = require('express');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// GET /api/niches
router.get('/', authMiddleware, (req, res) => {
  const db = getDb();
  const niches = db.prepare('SELECT * FROM niches ORDER BY name ASC').all();
  res.json(niches.map(n => ({ ...n, style_config: JSON.parse(n.style_config || '{}') })));
});

// POST /api/niches
router.post('/', authMiddleware, (req, res) => {
  const { name, style_type, style_config } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  if (!style_type) return res.status(400).json({ error: 'style_type is required' });

  const db = getDb();
  const result = db.prepare(
    'INSERT INTO niches (name, style_type, style_config) VALUES (?, ?, ?)'
  ).run(name.trim(), style_type, JSON.stringify(style_config || {}));

  const niche = db.prepare('SELECT * FROM niches WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ ...niche, style_config: JSON.parse(niche.style_config || '{}') });
});

// PUT /api/niches/:id
router.put('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  const niche = db.prepare('SELECT * FROM niches WHERE id = ?').get(req.params.id);
  if (!niche) return res.status(404).json({ error: 'Niche not found' });

  const { name, style_type, style_config } = req.body;
  db.prepare(`
    UPDATE niches SET
      name = COALESCE(?, name),
      style_type = COALESCE(?, style_type),
      style_config = COALESCE(?, style_config)
    WHERE id = ?
  `).run(
    name?.trim() || null,
    style_type || null,
    style_config !== undefined ? JSON.stringify(style_config) : null,
    req.params.id
  );

  const updated = db.prepare('SELECT * FROM niches WHERE id = ?').get(req.params.id);
  res.json({ ...updated, style_config: JSON.parse(updated.style_config || '{}') });
});

// DELETE /api/niches/:id
router.delete('/:id', authMiddleware, (req, res) => {
  const db = getDb();
  const niche = db.prepare('SELECT * FROM niches WHERE id = ?').get(req.params.id);
  if (!niche) return res.status(404).json({ error: 'Niche not found' });

  // Unlink projects using this niche before deleting
  db.prepare('UPDATE projects SET niche_id = NULL WHERE niche_id = ?').run(req.params.id);
  db.prepare('DELETE FROM niches WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
