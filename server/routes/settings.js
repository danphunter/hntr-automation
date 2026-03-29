const express = require('express');
const { getDb } = require('../db/database');
const { authMiddleware, adminOnly } = require('../middleware/auth');

const router = express.Router();

const PUBLIC_KEYS = ['assemblyai_api_key', 'gemini_api_key', 'video_width', 'video_height', 'video_fps', 'flow_project_id'];

// GET /api/settings — admin only (returns full values; input type=password handles visual masking)
router.get('/', authMiddleware, adminOnly, (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
  res.json(settings);
});

// PUT /api/settings — admin only
router.put('/', authMiddleware, adminOnly, (req, res) => {
  const db = getDb();
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)');
  const upsertMany = db.transaction((updates) => {
    for (const [key, value] of Object.entries(updates)) {
      if (PUBLIC_KEYS.includes(key)) {
        upsert.run(key, typeof value === 'string' ? value.trim() : value);
      }
    }
  });
  upsertMany(req.body);
  res.json({ success: true });
});

// GET /api/settings/has-keys — any authenticated user can check if keys are set
router.get('/has-keys', authMiddleware, (req, res) => {
  const db = getDb();
  const gemini = db.prepare("SELECT value FROM settings WHERE key = 'gemini_api_key'").get();
  const assemblyai = db.prepare("SELECT value FROM settings WHERE key = 'assemblyai_api_key'").get();
  res.json({
    gemini: !!(gemini?.value),
    assemblyai: !!(assemblyai?.value),
  });
});

module.exports = router;
