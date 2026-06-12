// Session：cw_session cookie，32 字节随机 hex，30 天过期，存 DB 可吊销，过期惰性清理。
import crypto from 'node:crypto';

export const COOKIE_NAME = 'cw_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

// 注意：Secure 标志可配（开发是 http 默认关；生产 HTTPS 由 COOKIE_SECURE=1 开启）。
export function makeCookieOpts(secure = false) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: !!secure,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

// 默认（不带 Secure）选项，供登出 clearCookie 等无状态场景使用。
export const COOKIE_OPTS = makeCookieOpts(false);

export function createSession(db, accountId, deviceLabel) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare(
    'INSERT INTO sessions (token, account_id, device_label, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).run(token, accountId, deviceLabel ?? null, now, now + SESSION_TTL_MS);
  return token;
}

/** 取有效 session；过期则惰性删除并返回 null。 */
export function getValidSession(db, token) {
  if (!token || typeof token !== 'string') return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return row;
}

export function deleteSession(db, token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function deleteSessionsForAccount(db, accountId) {
  db.prepare('DELETE FROM sessions WHERE account_id = ?').run(accountId);
}

/** 顺手清理所有已过期 session（登录时调用一次即可）。 */
export function sweepExpired(db) {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
}

/** 解析原始 Cookie 头（WS upgrade 走不了 fastify 插件，需要手动解析）。 */
export function parseCookieHeader(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    // decodeURIComponent 会对畸形百分号编码（如 "%"、"%zz"）抛 URIError；
    // WS upgrade 路径在认证前调用此函数，未捕获的异常会直接打崩进程（未认证远程 DoS）。
    // 解码失败时回退为原始值，绝不抛出。
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/**
 * fastify preHandler：校验 cw_session，挂 req.account / req.session。
 * 未认证 → 401 {"error":"unauthorized"}。
 */
export function makeAuthHook(db) {
  return async function authHook(req, reply) {
    const token = req.cookies?.[COOKIE_NAME];
    const session = getValidSession(db, token);
    if (!session) {
      return reply.code(401).send({ error: 'unauthorized', message: '未登录或会话已过期' });
    }
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(session.account_id);
    if (!account) {
      deleteSession(db, token);
      return reply.code(401).send({ error: 'unauthorized', message: '未登录或会话已过期' });
    }
    req.session = session;
    req.account = account;
  };
}
