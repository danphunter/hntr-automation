const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { authMiddleware, adminOnly } = require('../middleware/auth');

const router = express.Router();

const UPLOADS_BASE = process.env.UPLOADS_PATH || path.join(__dirname, '..', 'uploads');
const REFS_DIR = path.join(UPLOADS_BASE, 'references');
if (!fs.existsSync(REFS_DIR)) fs.mkdirSync(REFS_DIR, { recursive: true });

const refStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, REFS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `niche-ref-${uuidv4()}${ext}`);
  },
});
const uploadRef = multer({ storage: refStorage, limits: { fileSize: 10 * 1024 * 1024 } });

function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

function parseNiche(n) {
  return {
    ...n,
    style_config: JSON.parse(n.style_config || '{}'),
    reference_images: JSON.parse(n.reference_images || '[]'),
  };
}

async function uploadAssetToUseApi(useApiToken, imageBuffer, mimeType) {
  const fetch = (await import('node-fetch')).default;
  const base64 = imageBuffer.toString('base64');
  const response = await fetch('https://api.useapi.net/v1/assets/email', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + useApiToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url: `data:${mimeType};base64,${base64}` }),
  });
  return response;
}

// GET /api/niches
router.get('/', authMiddleware, (req, res) => {
  const db = getDb();
  const niches = db.prepare('SELECT * FROM niches ORDER BY name ASC').all();
  res.json(niches.map(parseNiche));
});

// POST /api/niches
router.post('/', authMiddleware, adminOnly, (req, res) => {
  const { name, style_type, style_config, reference_images } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  if (!style_type) return res.status(400).json({ error: 'style_type is required' });

  const db = getDb();
  const result = db.prepare(
    'INSERT INTO niches (name, style_type, style_config, reference_images) VALUES (?, ?, ?, ?)'
  ).run(
    name.trim(),
    style_type,
    JSON.stringify(style_config || {}),
    JSON.stringify(reference_images || []),
  );

  const niche = db.prepare('SELECT * FROM niches WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(parseNiche(niche));
});

// PUT /api/niches/:id
router.put('/:id', authMiddleware, adminOnly, (req, res) => {
  const db = getDb();
  const niche = db.prepare('SELECT * FROM niches WHERE id = ?').get(req.params.id);
  if (!niche) return res.status(404).json({ error: 'Niche not found' });

  const { name, style_type, style_config, reference_images } = req.body;
  db.prepare(`
    UPDATE niches SET
      name = COALESCE(?, name),
      style_type = COALESCE(?, style_type),
      style_config = COALESCE(?, style_config),
      reference_images = COALESCE(?, reference_images)
    WHERE id = ?
  `).run(
    name?.trim() || null,
    style_type || null,
    style_config !== undefined ? JSON.stringify(style_config) : null,
    reference_images !== undefined ? JSON.stringify(reference_images) : null,
    req.params.id,
  );

  const updated = db.prepare('SELECT * FROM niches WHERE id = ?').get(req.params.id);
  res.json(parseNiche(updated));
});

// DELETE /api/niches/:id
router.delete('/:id', authMiddleware, adminOnly, (req, res) => {
  const db = getDb();
  const niche = db.prepare('SELECT * FROM niches WHERE id = ?').get(req.params.id);
  if (!niche) return res.status(404).json({ error: 'Niche not found' });

  // Unlink projects using this niche before deleting
  db.prepare('UPDATE projects SET niche_id = NULL WHERE niche_id = ?').run(req.params.id);
  db.prepare('DELETE FROM niches WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// POST /api/niches/:id/reference-image — upload a reference image and register with useapi.net
router.post('/:id/reference-image', authMiddleware, uploadRef.single('image'), async (req, res) => {
  const db = getDb();
  const niche = db.prepare('SELECT * FROM niches WHERE id = ?').get(req.params.id);
  if (!niche) return res.status(404).json({ error: 'Niche not found' });

  const currentRefs = JSON.parse(niche.reference_images || '[]');
  if (currentRefs.length >= 3) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Maximum 3 reference images allowed' });
  }

  const settings = getSettings(db);
  const useApiToken = settings.useapi_token?.trim();

  let mediaGenerationId = null;
  if (useApiToken) {
    try {
      const imageBuffer = fs.readFileSync(req.file.path);
      const mimeType = req.file.mimetype || 'image/jpeg';
      const apiRes = await uploadAssetToUseApi(useApiToken, imageBuffer, mimeType);
      if (apiRes.ok) {
        const data = await apiRes.json();
        mediaGenerationId = data.mediaGenerationId || data.id || null;
        console.log('[niche-ref] useapi.net asset upload response:', JSON.stringify(data).slice(0, 300));
      } else {
        console.warn('[niche-ref] useapi.net upload failed:', apiRes.status, await apiRes.text().catch(() => ''));
      }
    } catch (err) {
      console.warn('[niche-ref] useapi.net upload error:', err.message);
    }
  }

  const refUrl = `/api/niches/reference-image/${req.file.filename}`;
  const newRef = { url: refUrl, filename: req.file.filename, filePath: req.file.path, mediaGenerationId };
  const updatedRefs = [...currentRefs, newRef];

  db.prepare('UPDATE niches SET reference_images = ? WHERE id = ?').run(JSON.stringify(updatedRefs), niche.id);
  const updated = db.prepare('SELECT * FROM niches WHERE id = ?').get(niche.id);
  res.status(201).json(parseNiche(updated));
});

// DELETE /api/niches/:id/reference-image/:index
router.delete('/:id/reference-image/:index', authMiddleware, (req, res) => {
  const db = getDb();
  const niche = db.prepare('SELECT * FROM niches WHERE id = ?').get(req.params.id);
  if (!niche) return res.status(404).json({ error: 'Niche not found' });

  const refs = JSON.parse(niche.reference_images || '[]');
  const idx = parseInt(req.params.index, 10);
  if (isNaN(idx) || idx < 0 || idx >= refs.length) {
    return res.status(400).json({ error: 'Invalid index' });
  }

  const [removed] = refs.splice(idx, 1);
  if (removed.filePath && fs.existsSync(removed.filePath)) {
    try { fs.unlinkSync(removed.filePath); } catch {}
  }

  db.prepare('UPDATE niches SET reference_images = ? WHERE id = ?').run(JSON.stringify(refs), niche.id);
  const updated = db.prepare('SELECT * FROM niches WHERE id = ?').get(niche.id);
  res.json(parseNiche(updated));
});

// GET /api/niches/reference-image/:filename — serve reference image files
router.get('/reference-image/:filename', authMiddleware, (req, res) => {
  const filePath = path.join(REFS_DIR, path.basename(req.params.filename));
  if (!filePath.startsWith(REFS_DIR)) return res.status(404).json({ error: 'Not found' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(filePath);
});

module.exports = router;
