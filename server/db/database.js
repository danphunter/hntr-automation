const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

// Auto-detect Railway persistent volume at /data.
// DATABASE_PATH env var overrides (set this in Railway dashboard if needed).
const _dataExists = fs.existsSync('/data');
const _dataIsDir = _dataExists ? fs.statSync('/data').isDirectory() : false;
console.log(`[DB] /data exists: ${_dataExists}, isDirectory: ${_dataIsDir}`);
console.log(`[DB] DATABASE_PATH env: ${process.env.DATABASE_PATH || '(not set)'}`);
console.log(`[DB] UPLOADS_PATH env: ${process.env.UPLOADS_PATH || '(not set)'}`);
const DB_PATH = process.env.DATABASE_PATH
  || (_dataExists && _dataIsDir ? '/data/hntr-automation.db' : path.join(__dirname, '..', 'hntr-automation.db'));
let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

const DEFAULT_STYLES = [
  { id: 'style-bible', name: 'Bible Animation', description: 'Cinematic painterly scenes from scripture — epic, reverent, full of light and depth.', prompt_prefix: 'cinematic painterly biblical scene, dramatic lighting, epic composition, high detail, oil painting style,', prompt_suffix: ', golden hour light, epic scale, reverent atmosphere, 16:9 widescreen', color: '#7C3AED', icon: '✝️', scene_pattern: '["image"]' },
  { id: 'style-finance', name: 'Finance Explainer', description: 'Clean minimal infographics for financial and business content.', prompt_prefix: 'clean minimalist infographic illustration, flat design, professional business style,', prompt_suffix: ', white background, clear typography, data visualization, corporate style', color: '#059669', icon: '📈', scene_pattern: '["image","video"]' },
  { id: 'style-history', name: 'History Documentary', description: 'Dramatic realistic historical scenes — like a high-budget documentary.', prompt_prefix: 'dramatic realistic historical scene, photorealistic painting, documentary style, detailed period accuracy,', prompt_suffix: ', cinematic composition, dramatic lighting, museum quality art', color: '#B45309', icon: '🏛️', scene_pattern: '["image"]' },
  { id: 'style-whiteboard', name: 'Whiteboard / Stickman', description: 'Simple whiteboard animation style with stick figures and hand-drawn elements.', prompt_prefix: 'whiteboard animation style, hand-drawn stick figures, simple black marker on white background,', prompt_suffix: ', clean simple illustration, educational style, minimalist sketch', color: '#0369A1', icon: '✏️', scene_pattern: '["video"]' },
  { id: 'style-science', name: 'Science Explainer', description: '3D renders and scientific visualizations for science and tech content.', prompt_prefix: 'highly detailed 3D render, scientific visualization, photorealistic CGI, educational science illustration,', prompt_suffix: ', studio lighting, sharp detail, educational diagram style', color: '#0891B2', icon: '🔬', scene_pattern: '["image","image","video"]' },
];

function initDb() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'editor',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS styles (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      prompt_prefix TEXT DEFAULT '',
      prompt_suffix TEXT DEFAULT '',
      color TEXT DEFAULT '#6366F1',
      icon TEXT DEFAULT '🎬',
      is_default INTEGER DEFAULT 0,
      scene_pattern TEXT DEFAULT '["image"]',
      created_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS style_references (
      id TEXT PRIMARY KEY,
      style_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT,
      file_path TEXT NOT NULL,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (style_id) REFERENCES styles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS whisk_tokens (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      token TEXT NOT NULL,
      usage_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      last_used DATETIME,
      last_error TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      script TEXT,
      style_id TEXT,
      status TEXT DEFAULT 'draft',
      audio_path TEXT,
      audio_filename TEXT,
      render_path TEXT,
      duration_estimate INTEGER DEFAULT 0,
      assigned_to TEXT,
      notes TEXT,
      started_at DATETIME,
      completed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (style_id) REFERENCES styles(id)
    );

    CREATE TABLE IF NOT EXISTS scenes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      scene_order INTEGER NOT NULL,
      text TEXT NOT NULL,
      start_time REAL DEFAULT 0,
      end_time REAL DEFAULT 5,
      duration REAL DEFAULT 5,
      image_prompt TEXT,
      image_url TEXT,
      image_path TEXT,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);
    CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
    CREATE INDEX IF NOT EXISTS idx_projects_created_at ON projects(created_at);
    CREATE INDEX IF NOT EXISTS idx_scenes_project_id ON scenes(project_id, scene_order);
    CREATE INDEX IF NOT EXISTS idx_style_refs_style_id ON style_references(style_id);
    CREATE INDEX IF NOT EXISTS idx_whisk_tokens_status ON whisk_tokens(status);
  `);

  // Migrations for existing databases (add columns if missing)
  const migrations = [
    "ALTER TABLE projects ADD COLUMN started_at DATETIME",
    "ALTER TABLE projects ADD COLUMN completed_at DATETIME",
    "ALTER TABLE projects ADD COLUMN style TEXT DEFAULT ''",
    "ALTER TABLE projects ADD COLUMN script TEXT DEFAULT ''",
    "ALTER TABLE projects ADD COLUMN notes TEXT DEFAULT ''",
    "ALTER TABLE projects ADD COLUMN audio_path TEXT",
    "ALTER TABLE projects ADD COLUMN audio_filename TEXT",
    "ALTER TABLE styles ADD COLUMN scene_pattern TEXT DEFAULT '[\"image\"]'",
    "ALTER TABLE style_references ADD COLUMN reference_type TEXT DEFAULT 'subject'",
    "ALTER TABLE scenes ADD COLUMN image_url TEXT DEFAULT ''",
    "ALTER TABLE scenes ADD COLUMN start_time REAL DEFAULT 0",
    "ALTER TABLE scenes ADD COLUMN end_time REAL DEFAULT 5",
    "ALTER TABLE scenes ADD COLUMN duration REAL DEFAULT 5",
    "ALTER TABLE projects ADD COLUMN transcribe_job_id TEXT",
    "ALTER TABLE projects ADD COLUMN transcribe_status TEXT DEFAULT ''",
    "ALTER TABLE whisk_tokens ADD COLUMN rate_limited_until DATETIME",
    "ALTER TABLE style_references ADD COLUMN flow_media_id TEXT",
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch {}
  }

  // Seed users
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (userCount.count === 0) {
    const insert = db.prepare('INSERT INTO users (id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)');
    for (const u of [
      { id: 'user-dan', username: 'dan', password: 'dan123', name: 'Dan (Admin)', role: 'admin' },
      { id: 'user-john', username: 'john', password: 'john123', name: 'John', role: 'editor' },
      { id: 'user-christian', username: 'christian', password: 'christian123', name: 'Christian', role: 'editor' },
    ]) {
      insert.run(u.id, u.username, bcrypt.hashSync(u.password, 10), u.name, u.role);
    }
    console.log('✅ Seeded users: dan/dan123, john/john123, christian/christian123');
  }

  // Seed styles
  const styleCount = db.prepare('SELECT COUNT(*) as count FROM styles').get();
  if (styleCount.count === 0) {
    const insert = db.prepare(`INSERT INTO styles (id, name, description, prompt_prefix, prompt_suffix, color, icon, scene_pattern, is_default, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'user-dan')`);
    for (const s of DEFAULT_STYLES) insert.run(s.id, s.name, s.description, s.prompt_prefix, s.prompt_suffix, s.color, s.icon, s.scene_pattern);
    console.log('✅ Seeded default styles');
  } else {
    // Update existing default styles with scene_pattern if not set
    const updatePattern = db.prepare("UPDATE styles SET scene_pattern = ? WHERE id = ? AND (scene_pattern IS NULL OR scene_pattern = '[\"image\"]' OR scene_pattern = '')");
    for (const s of DEFAULT_STYLES) {
      updatePattern.run(s.scene_pattern, s.id);
    }
  }

  console.log(`✅ Database ready at ${DB_PATH}`);
}

module.exports = { getDb, initDb };
