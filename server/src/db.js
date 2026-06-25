// SQLite 封装：优先 better-sqlite3，原生模块不可用时回退 node:sqlite（DatabaseSync）。
// 两者对外暴露一致的最小接口：prepare().get/.all/.run、exec()、close()。
import fs from 'node:fs';

let driverName = null;

async function loadDriver() {
  try {
    const mod = await import('better-sqlite3');
    driverName = 'better-sqlite3';
    return (file) => new mod.default(file);
  } catch {
    const { DatabaseSync } = await import('node:sqlite');
    driverName = 'node:sqlite';
    return (file) => new DatabaseSync(file);
  }
}

export function getDriverName() {
  return driverName;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  device_label TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS clips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'text',
  title TEXT,
  is_pinned INTEGER NOT NULL DEFAULT 0,
  is_sensitive INTEGER NOT NULL DEFAULT 0,
  burn_after_read INTEGER NOT NULL DEFAULT 0,
  device_label TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS device_codes (
  device_code TEXT PRIMARY KEY,
  user_code TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  user_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clips_account_id ON clips(account_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
CREATE INDEX IF NOT EXISTS idx_api_tokens_account ON api_tokens(account_id);
`;

// 增量迁移：CREATE TABLE IF NOT EXISTS 不会给已存在的旧表补列，
// 故对 M1 旧库（无 burn_after_read 列）做幂等 ALTER。两种驱动都支持 PRAGMA table_info。
function migrate(db) {
  const cols = db
    .prepare('PRAGMA table_info(clips)')
    .all()
    .map((c) => c.name);
  if (!cols.includes('burn_after_read')) {
    db.exec('ALTER TABLE clips ADD COLUMN burn_after_read INTEGER NOT NULL DEFAULT 0');
  }
}

export async function openDb(dbFile) {
  const open = await loadDriver();
  const db = open(dbFile);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  try {
    fs.chmodSync(dbFile, 0o600);
  } catch {
    /* 非关键 */
  }
  return db;
}
