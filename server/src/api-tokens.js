// 个人访问令牌（PAT）：给 MCP / 脚本以非 cookie 方式认证。
// 明文形如 cw_pat_<40hex>，仅在创建时返回一次；库里只存 sha256(token)，无法反推。
import crypto from 'node:crypto';

export const TOKEN_PREFIX = 'cw_pat_';
const LAST_USED_THROTTLE_MS = 60_000; // last_used_at 最多每分钟落库一次，避免每请求一次写放大

export function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 生成并落库一个新 PAT，返回明文（仅此一次可见）与行。 */
export function createApiToken(db, accountId, label) {
  const token = TOKEN_PREFIX + crypto.randomBytes(20).toString('hex');
  const token_hash = hashToken(token);
  const now = Date.now();
  const cleanLabel = typeof label === 'string' && label.trim() ? label.trim().slice(0, 64) : null;
  const info = db
    .prepare(
      'INSERT INTO api_tokens (account_id, token_hash, label, created_at) VALUES (?, ?, ?, ?)'
    )
    .run(accountId, token_hash, cleanLabel, now);
  return {
    token, // 明文，仅返回一次
    row: { id: Number(info.lastInsertRowid), label: cleanLabel, createdAt: now, lastUsedAt: null },
  };
}

/** 用明文 token 解析出账号；命中则（限流地）更新 last_used_at。无效返回 null。 */
export function resolveApiToken(db, token) {
  if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) return null;
  const row = db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?').get(hashToken(token));
  if (!row) return null;
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(row.account_id);
  if (!account) return null;
  const now = Date.now();
  if (!row.last_used_at || now - row.last_used_at > LAST_USED_THROTTLE_MS) {
    db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now, row.id);
  }
  return { account, tokenRow: row };
}

export function listApiTokens(db, accountId) {
  return db
    .prepare(
      'SELECT id, label, created_at, last_used_at FROM api_tokens WHERE account_id = ? ORDER BY id DESC'
    )
    .all(accountId)
    .map((r) => ({
      id: r.id,
      label: r.label,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at ?? null,
    }));
}

/** 删除自己名下的某个 token；跨账号无效（changes=0）。 */
export function deleteApiToken(db, accountId, id) {
  const info = db
    .prepare('DELETE FROM api_tokens WHERE id = ? AND account_id = ?')
    .run(id, accountId);
  return info.changes > 0;
}

export function deleteApiTokensForAccount(db, accountId) {
  db.prepare('DELETE FROM api_tokens WHERE account_id = ?').run(accountId);
}
