const express = require('express');
const { getDb } = require('../db/database');
const { authMiddleware, adminOnly } = require('../middleware/auth');

const router = express.Router();

const PUBLIC_KEYS = ['assemblyai_api_key', 'openai_api_key', 'video_width', 'video_height', 'video_fps', 'useapi_token', 'anticaptcha_api_key', 'flow_image_batch_size', 'flow_image_wait_time', 'flow_video_batch_size'];

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

  // Auto-register AntiCaptcha with useapi.net when both keys are present
  const rows = db.prepare('SELECT key, value FROM settings WHERE key IN (?, ?)').all('useapi_token', 'anticaptcha_api_key');
  const saved = Object.fromEntries(rows.map(r => [r.key, r.value]));
  if (saved.useapi_token && saved.anticaptcha_api_key) {
    (async () => {
      try {
        const fetch = (await import('node-fetch')).default;
        const r = await fetch('https://api.useapi.net/v1/google-flow/accounts/captcha-providers', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + saved.useapi_token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ anticaptcha: saved.anticaptcha_api_key }),
        });
        if (!r.ok) {
          const text = await r.text();
          console.warn('[settings] AntiCaptcha registration failed:', r.status, text.slice(0, 200));
        } else {
          console.log('[settings] AntiCaptcha registered with useapi.net');
        }
      } catch (err) {
        console.warn('[settings] AntiCaptcha registration error:', err.message);
      }
    })();
  }

  res.json({ success: true });
});

// GET /api/settings/has-keys — any authenticated user can check if keys are set
router.get('/has-keys', authMiddleware, (req, res) => {
  const db = getDb();
  const openai = db.prepare("SELECT value FROM settings WHERE key = 'openai_api_key'").get();
  const assemblyai = db.prepare("SELECT value FROM settings WHERE key = 'assemblyai_api_key'").get();
  res.json({
    openai: !!(openai?.value),
    assemblyai: !!(assemblyai?.value),
  });
});

module.exports = router;
