require('express-async-errors');
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { initDb } = require('./db/database');

const app = express();
const PORT = process.env.PORT || 3001;

// Log Railway env vars for debugging volume mount issues
const railwayEnvKeys = Object.keys(process.env).filter(k => k.startsWith('RAILWAY_'));
if (railwayEnvKeys.length) {
  console.log('[Server] Railway env vars:', railwayEnvKeys.map(k => `${k}=${process.env[k]}`).join(', '));
} else {
  console.log('[Server] No RAILWAY_ env vars found');
}

// Use UPLOADS_PATH env var if set, auto-detect /data volume, else local server/uploads.
// If /data doesn't exist but RAILWAY_VOLUME_MOUNT_PATH is set, use that as the data dir.
let _dataPath = '/data';
if (!fs.existsSync(_dataPath) && process.env.RAILWAY_VOLUME_MOUNT_PATH) {
  _dataPath = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  console.log(`[Server] /data not found, using RAILWAY_VOLUME_MOUNT_PATH: ${_dataPath}`);
}
// Try to create the data directory if it doesn't exist (no-op if read-only)
if (!fs.existsSync(_dataPath)) {
  try { fs.mkdirSync(_dataPath, { recursive: true }); console.log(`[Server] Created ${_dataPath}`); } catch (e) { console.log(`[Server] Could not create ${_dataPath}: ${e.message}`); }
}
const _dataExists = fs.existsSync(_dataPath);
const _dataIsDir = _dataExists ? fs.statSync(_dataPath).isDirectory() : false;
console.log(`[Server] ${_dataPath} exists: ${_dataExists}, isDirectory: ${_dataIsDir}`);
console.log(`[Server] DATABASE_PATH env: ${process.env.DATABASE_PATH || '(not set)'}`);
console.log(`[Server] UPLOADS_PATH env: ${process.env.UPLOADS_PATH || '(not set)'}`);
const UPLOADS_BASE = process.env.UPLOADS_PATH
  || (_dataExists && _dataIsDir ? path.join(_dataPath, 'uploads') : path.join(__dirname, 'uploads'));
process.env.UPLOADS_PATH = UPLOADS_BASE; // expose to route files
for (const sub of ['', 'images', 'references', 'videos']) {
  const dir = path.join(UPLOADS_BASE, sub);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Init DB
initDb();

// Middleware
app.use(cors({
  origin: process.env.CLIENT_URL || ['http://localhost:5173', 'http://localhost:3001'],
  credentials: true,
}));
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/styles', require('./routes/styles'));
app.use('/api/generate', require('./routes/generate'));
app.use('/api/render', require('./routes/render'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/niches', require('./routes/niches'));

// Health check
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Serve React frontend in production
const clientDist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  const dbPath = process.env.DATABASE_PATH
    || (_dataExists ? path.join(_dataPath, 'hntr-automation.db') : path.join(__dirname, 'hntr-automation.db'));
  console.log(`\n🚀 HNTR Automation Server running on http://localhost:${PORT}`);
  console.log(`   API: http://localhost:${PORT}/api/health`);
  console.log(`   Mode: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   /data exists: ${_dataExists}`);
  console.log(`   DB path: ${dbPath} (DATABASE_PATH env: ${process.env.DATABASE_PATH || '(not set)'})`);
  console.log(`   Uploads: ${UPLOADS_BASE} (UPLOADS_PATH env: ${process.env.UPLOADS_PATH || '(not set)'})`);
  console.log(`   Railway env: ${process.env.RAILWAY_ENVIRONMENT || 'not set'}\n`);
});
