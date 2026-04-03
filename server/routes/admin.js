const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { authMiddleware, adminOnly } = require('../middleware/auth');

const router = express.Router();

// GET /api/admin/stats
router.get('/stats', authMiddleware, adminOnly, (req, res) => {
  const db = getDb();

  const totalProjects = db.prepare("SELECT COUNT(*) as count FROM projects WHERE deleted_at IS NULL").get().count;
  const thisWeek = db.prepare(`
    SELECT COUNT(*) as count FROM projects
    WHERE deleted_at IS NULL AND created_at >= datetime('now', '-7 days')
  `).get().count;
  const thisMonth = db.prepare(`
    SELECT COUNT(*) as count FROM projects
    WHERE deleted_at IS NULL AND created_at >= datetime('now', '-30 days')
  `).get().count;
  const completed = db.prepare("SELECT COUNT(*) as count FROM projects WHERE deleted_at IS NULL AND status = 'complete'").get().count;
  const rendering = db.prepare("SELECT COUNT(*) as count FROM projects WHERE deleted_at IS NULL AND status = 'rendering'").get().count;

  const perEditor = db.prepare(`
    SELECT u.display_name, u.username, COUNT(p.id) as total,
      SUM(CASE WHEN p.created_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) as this_week,
      SUM(CASE WHEN p.status = 'complete' THEN 1 ELSE 0 END) as completed
    FROM users u
    LEFT JOIN projects p ON p.user_id = u.id AND p.deleted_at IS NULL
    WHERE u.role = 'editor'
    GROUP BY u.id
    ORDER BY total DESC
  `).all();

  const recentProjects = db.prepare(`
    SELECT p.*, u.display_name as editor_name
    FROM projects p LEFT JOIN users u ON p.user_id = u.id
    WHERE p.deleted_at IS NULL
    ORDER BY p.created_at DESC LIMIT 10
  `).all();

  res.json({ totalProjects, thisWeek, thisMonth, completed, rendering, perEditor, recentProjects });
});

// GET /api/admin/users
router.get('/users', authMiddleware, adminOnly, (req, res) => {
  const db = getDb();
  const users = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.role, u.avatar, u.created_at,
      COUNT(p.id) as project_count
    FROM users u
    LEFT JOIN projects p ON p.user_id = u.id AND p.deleted_at IS NULL
    GROUP BY u.id
    ORDER BY u.created_at ASC
  `).all();
  res.json(users);
});

// POST /api/admin/users
router.post('/users', authMiddleware, adminOnly, (req, res) => {
  const { username, password, displayName, role } = req.body;
  if (!username || !password || !displayName) {
    return res.status(400).json({ error: 'username, password, and displayName required' });
  }

  const db = getDb();
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username.toLowerCase());
  if (exists) return res.status(400).json({ error: 'Username already taken' });

  const id = uuidv4();
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)').run(
    id, username.toLowerCase(), hash, displayName, role || 'editor'
  );

  res.status(201).json({ id, username: username.toLowerCase(), displayName, role: role || 'editor' });
});

// DELETE /api/admin/users/:id
router.delete('/users/:id', authMiddleware, adminOnly, (req, res) => {
  const db = getDb();
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete yourself' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// POST /api/admin/assign
router.post('/assign', authMiddleware, adminOnly, (req, res) => {
  const { projectId, editorId } = req.body;
  const db = getDb();
  db.prepare('UPDATE projects SET assigned_to = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(editorId, projectId);
  res.json({ success: true });
});

module.exports = router;
