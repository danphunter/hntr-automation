const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

// Auto-detect Railway persistent volume at /data (or RAILWAY_VOLUME_MOUNT_PATH).
// DATABASE_PATH env var overrides (set this in Railway dashboard if needed).
let _dataPath = '/data';
if (!fs.existsSync(_dataPath) && process.env.RAILWAY_VOLUME_MOUNT_PATH) {
  _dataPath = process.env.RAILWAY_VOLUME_MOUNT_PATH;
}
const _dataExists = fs.existsSync(_dataPath);
const _dataIsDir = _dataExists ? fs.statSync(_dataPath).isDirectory() : false;
console.log(`[DB] ${_dataPath} exists: ${_dataExists}, isDirectory: ${_dataIsDir}`);
console.log(`[DB] DATABASE_PATH env: ${process.env.DATABASE_PATH || '(not set)'}`);
console.log(`[DB] UPLOADS_PATH env: ${process.env.UPLOADS_PATH || '(not set)'}`);
const DB_PATH = process.env.DATABASE_PATH
  || (_dataExists && _dataIsDir ? path.join(_dataPath, 'hntr-automation.db') : path.join(__dirname, '..', 'hntr-automation.db'));
let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}


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

    CREATE TABLE IF NOT EXISTS niches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      style_type TEXT NOT NULL DEFAULT 'all_image',
      style_config TEXT NOT NULL DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
    "ALTER TABLE styles ADD COLUMN slow_pan INTEGER DEFAULT 0",
    "UPDATE projects SET style_id = NULL WHERE style_id IN ('style-bible','style-finance','style-history','style-whiteboard','style-science')",
    "DELETE FROM styles WHERE id IN ('style-bible','style-finance','style-history','style-whiteboard','style-science')",
    "UPDATE styles SET prompt_prefix = 'photorealistic modern military documentary, early 2000s warfare, post-9/11 era combat circa 2001-2010, tactical infantry, realistic war photography style,', prompt_suffix = ', no text, no words, no letters, no captions, no watermarks, no typography, no writing, gritty war photography, cinematic 16:9' WHERE name = 'War Archives'",
    "ALTER TABLE whisk_tokens ADD COLUMN project_id TEXT DEFAULT 'b998a407-4f9a-4b0c-9bc9-f2fae2a5a077'",
    "UPDATE whisk_tokens SET status = 'active', rate_limited_until = NULL, last_error = NULL WHERE status = 'rate_limited' OR status IS NULL",
    "INSERT OR IGNORE INTO settings (key, value) VALUES ('useapi_token', '')",
    "INSERT OR IGNORE INTO settings (key, value) VALUES ('flow_image_batch_size', '20')",
    "INSERT OR IGNORE INTO settings (key, value) VALUES ('flow_image_wait_time', '20')",
    "INSERT OR IGNORE INTO settings (key, value) VALUES ('flow_video_batch_size', '5')",
    "INSERT OR IGNORE INTO settings (key, value) VALUES ('capsolver_api_key', '')",
    "ALTER TABLE projects ADD COLUMN niche_id INTEGER REFERENCES niches(id)",
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

  // Seed niches
  const nicheCount = db.prepare('SELECT COUNT(*) as count FROM niches').get();
  if (nicheCount.count === 0) {
    const insertNiche = db.prepare('INSERT INTO niches (name, style_type, style_config) VALUES (?, ?, ?)');
    insertNiche.run('Documentary', 'all_image', '{}');
    insertNiche.run('Cinematic', 'all_video', '{}');
    insertNiche.run('Hybrid', 'alternating', '{"startWith":"video"}');
    console.log('✅ Seeded niches: Documentary, Cinematic, Hybrid');
  }

  console.log(`✅ Database ready at ${DB_PATH}`);
}

module.exports = { getDb, initDb };
