// 账号：bootstrap admin、查询/创建/删除、密码哈希。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';

export const USERNAME_RE = /^[a-zA-Z0-9_-]{2,32}$/;
const BCRYPT_ROUNDS = 10;

export function hashPassword(password) {
  return bcrypt.hashSync(password, BCRYPT_ROUNDS);
}

export function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

export function findByUsername(db, username) {
  return db.prepare('SELECT * FROM accounts WHERE username = ?').get(username);
}

export function findById(db, id) {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
}

export function createAccount(db, { username, password, role = 'user' }) {
  const info = db
    .prepare('INSERT INTO accounts (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
    .run(username, hashPassword(password), role, Date.now());
  return findById(db, Number(info.lastInsertRowid));
}

export function publicAccount(row) {
  return { id: row.id, username: row.username, role: row.role };
}

/**
 * 首次启动若无任何账号：自动创建 admin，随机 16 字符密码，
 * 打印到 stdout 并写入 $CLIPWARP_HOME/initial-admin-password.txt（chmod 600）。
 */
export function bootstrapAdmin(db, homeDir) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM accounts').get();
  if (row.n > 0) return null;

  // 12 字节 base64url 恰好 16 个字符
  const password = crypto.randomBytes(12).toString('base64url');
  createAccount(db, { username: 'admin', password, role: 'admin' });

  const file = path.join(homeDir, 'initial-admin-password.txt');
  fs.writeFileSync(file, password + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* 非关键 */
  }
  // 引导信息按设计要求打印到 stdout（仅首次启动出现一次）
  console.log('[clipwarp] 首次启动：已创建 admin 账号');
  console.log(`[clipwarp] 初始密码: ${password}`);
  console.log(`[clipwarp] 已写入: ${file}`);
  return password;
}
