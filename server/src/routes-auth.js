// 认证路由：login / logout / me + 跨设备登录（设备授权码 / 扫码快速登录）。
// 登录失败限速：同 IP 1 分钟窗口失败 ≥5 次 → 429。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  COOKIE_NAME,
  makeCookieOpts,
  createSession,
  deleteSession,
  sweepExpired,
} from './sessions.js';
import { findById, findByUsername, hashPassword, publicAccount, verifyPassword } from './accounts.js';

const WINDOW_MS = 60_000;
const MAX_FAILURES = 5;

// —— 设备授权码（Device Authorization）——
// 短的人类可读码用无歧义字母表（去掉 0/O/1/I），格式 CW-XXXX，便于在屏幕间手动核对。
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const DEVICE_CODE_TTL_MS = 5 * 60 * 1000; // 5 分钟过期
export const DEVICE_POLL_INTERVAL = 5; // 新设备建议轮询间隔（秒）

function genUserCode() {
  let s = '';
  const bytes = crypto.randomBytes(4);
  for (let i = 0; i < 4; i++) s += USER_CODE_ALPHABET[bytes[i] % USER_CODE_ALPHABET.length];
  return 'CW-' + s;
}

// 创建设备授权码：device_code（新设备私有、长随机）+ user_code（展示/核对用、短）。
// user_code 唯一冲突极少，撞了就重试几次。
export function createDeviceCode(db, ttlMs = DEVICE_CODE_TTL_MS) {
  const deviceCode = crypto.randomUUID() + crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  let userCode = genUserCode();
  for (let i = 0; i < 5; i++) {
    if (!db.prepare('SELECT 1 FROM device_codes WHERE user_code = ?').get(userCode)) break;
    userCode = genUserCode();
  }
  db.prepare(
    `INSERT INTO device_codes (device_code, user_code, status, user_id, created_at, expires_at)
     VALUES (?, ?, 'pending', NULL, ?, ?)`
  ).run(deviceCode, userCode, now, now + ttlMs);
  return { deviceCode, userCode };
}

// 取设备码行（按 user_code 或 device_code）；顺带做过期判定（过期则标记 expired）。
function loadDevice(db, where, value) {
  const row = db.prepare(`SELECT * FROM device_codes WHERE ${where} = ?`).get(value);
  if (!row) return null;
  if (row.status !== 'expired' && row.expires_at <= Date.now()) {
    try {
      db.prepare('UPDATE device_codes SET status = ? WHERE device_code = ?').run('expired', row.device_code);
    } catch {
      /* 标记失败不影响「判定为过期」 */
    }
    row.status = 'expired';
  }
  return row;
}

export function getDeviceByUserCode(db, userCode) {
  return loadDevice(db, 'user_code', userCode);
}

// 已登录用户在信任设备上确认授权：标记 approved 并记下授权人。
// 返回 'ok' | 'not_found' | 'expired' | 'already'（已处理过）。
export function approveDevice(db, userCode, accountId) {
  const row = getDeviceByUserCode(db, userCode);
  if (!row) return 'not_found';
  if (row.status === 'expired') return 'expired';
  if (row.status === 'approved') return 'already';
  db.prepare('UPDATE device_codes SET status = ?, user_id = ? WHERE device_code = ?').run(
    'approved',
    accountId,
    row.device_code
  );
  return 'ok';
}

// 新设备轮询：返回 { status, account?, token? }。
// approved 时一次性消费：创建会话、删除设备码行（防重放），返回 token + account。
export function pollDeviceToken(db, deviceCode, deviceLabel) {
  const row = loadDevice(db, 'device_code', deviceCode);
  if (!row) return { status: 'not_found' };
  if (row.status === 'expired') return { status: 'expired' };
  if (row.status !== 'approved') return { status: 'pending' };
  const token = createSession(db, row.user_id, deviceLabel);
  const account = findById(db, row.user_id);
  try {
    db.prepare('DELETE FROM device_codes WHERE device_code = ?').run(deviceCode);
  } catch {
    /* 删除失败无碍：会话已签发，行也会随过期清理 */
  }
  return { status: 'approved', token, account };
}

// —— 快速登录 QR 的签名 ——
// 持久化一个进程外稳定的密钥到配置目录，用于给二维码载荷签名（防篡改）。
// 二维码本身只承载「服务器地址 + 用户名 + nonce」用于在手机端预填，真正登录仍走密码。
let _quickSecret = null;
function quickSecret(homeDir) {
  if (_quickSecret) return _quickSecret;
  const file = path.join(homeDir, 'quick-login-secret');
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    if (s) {
      _quickSecret = s;
      return _quickSecret;
    }
  } catch {
    /* 不存在则下面创建 */
  }
  _quickSecret = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(file, _quickSecret, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  } catch {
    /* 写盘失败也能用（仅本进程内有效，重启后换新密钥） */
  }
  return _quickSecret;
}

export function signQuick(homeDir, payload) {
  return crypto.createHmac('sha256', quickSecret(homeDir)).update(payload).digest('hex').slice(0, 32);
}

// 用户名不存在时，仍对一份固定假哈希跑一次 bcrypt，使响应耗时与"用户名存在但密码错"一致，
// 消除靠响应时间枚举有效用户名的侧信道。
const DUMMY_HASH = hashPassword('clipwarp-timing-equalizer');

/** 从 User-Agent 推断设备名（deviceLabel 缺省时）。 */
export function deviceLabelFromUA(ua) {
  if (!ua) return 'Unknown';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Unknown';
}

export default function registerAuthRoutes(app, { db, authHook, secureCookie = false, home }) {
  const cookieOpts = makeCookieOpts(secureCookie);

  // 从请求推断对外可访问的服务器基址（供二维码 / verification_uri 拼绝对 URL）。
  // 反代场景信任 X-Forwarded-*；否则用 Host 头与连接协议。
  function serverBase(req) {
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
    return `${proto}://${host}`;
  }
  /** Map<ip, number[]> 失败时间戳（内存限速器，窗口外惰性清理）。 */
  const failures = new Map();

  function pruned(ip) {
    const now = Date.now();
    const list = (failures.get(ip) || []).filter((t) => now - t < WINDOW_MS);
    if (list.length === 0) failures.delete(ip);
    else failures.set(ip, list);
    return list;
  }

  app.post('/api/login', async (req, reply) => {
    const ip = req.ip;
    if (pruned(ip).length >= MAX_FAILURES) {
      return reply.code(429).send({ error: 'rate_limited', message: '尝试过于频繁，请 1 分钟后再试' });
    }

    const body = req.body || {};
    const { username, password } = body;
    const account =
      typeof username === 'string' && typeof password === 'string'
        ? findByUsername(db, username)
        : null;

    // 始终跑一次 bcrypt（账号不存在时比对假哈希），让耗时不暴露用户名是否存在。
    const ok =
      typeof password === 'string' &&
      verifyPassword(password, account ? account.password_hash : DUMMY_HASH);
    if (!account || !ok) {
      const list = failures.get(ip) || [];
      list.push(Date.now());
      failures.set(ip, list);
      return reply.code(401).send({ error: 'invalid_credentials', message: '用户名或密码错误' });
    }

    failures.delete(ip);
    sweepExpired(db);

    const deviceLabel =
      typeof body.deviceLabel === 'string' && body.deviceLabel.trim()
        ? body.deviceLabel.trim().slice(0, 64)
        : deviceLabelFromUA(req.headers['user-agent']);

    const token = createSession(db, account.id, deviceLabel);
    reply.setCookie(COOKIE_NAME, token, cookieOpts);
    return reply.code(200).send({ account: publicAccount(account) });
  });

  app.post('/api/logout', async (req, reply) => {
    const token = req.cookies?.[COOKIE_NAME];
    if (token) deleteSession(db, token);
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return reply.code(204).send();
  });

  app.get('/api/me', { preHandler: authHook }, async (req) => {
    return {
      account: publicAccount(req.account),
      deviceLabel: req.session.device_label,
    };
  });

  // —— 扫码快速登录（需登录）——
  // 返回二维码要承载的信息：服务器地址 + 当前用户名 + 一次性 nonce + 签名 + 预填 URL。
  // 安全说明：二维码只用于在手机端「预填服务器与用户名」，真正登录仍需输入密码；
  // nonce 带 HMAC 签名以便防篡改（5 分钟过期）。
  app.get('/api/auth/quick-login-qr', { preHandler: authHook }, async (req) => {
    const base = serverBase(req);
    const username = req.account.username;
    const nonce = crypto.randomBytes(12).toString('hex');
    const expiresAt = Date.now() + 5 * 60 * 1000;
    const sig = home ? signQuick(home, `${username}.${nonce}.${expiresAt}`) : '';
    // 预填 URL：手机扫码后打开它，登录页据 ?username= 自动填用户名。
    const url = `${base}/?username=${encodeURIComponent(username)}&ql=${nonce}`;
    return { server: base, username, nonce, expires_at: expiresAt, sig, url };
  });

  // POST /api/auth/device/code —— 新设备申请授权码（无需登录）。
  app.post('/api/auth/device/code', async (req) => {
    const { deviceCode, userCode } = createDeviceCode(db);
    const base = serverBase(req);
    return {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `${base}/#/device-auth?code=${encodeURIComponent(userCode)}`,
      expires_in: Math.floor(DEVICE_CODE_TTL_MS / 1000),
      interval: DEVICE_POLL_INTERVAL,
    };
  });

  // GET /api/auth/device/check?user_code=XXX —— 查询某 user_code 状态（无需登录）。
  // 供确认页展示「你正在授权 CW-XXXX」；只回状态，不含敏感信息。
  app.get('/api/auth/device/check', async (req, reply) => {
    const userCode = (req.query?.user_code || '').toString().trim().toUpperCase();
    const row = userCode ? getDeviceByUserCode(db, userCode) : null;
    if (!row) return reply.code(404).send({ error: 'not_found', message: '授权码不存在或已失效' });
    return { user_code: row.user_code, status: row.status };
  });

  // POST /api/auth/device/approve —— 已登录用户在信任设备上确认授权（需登录）。
  app.post('/api/auth/device/approve', { preHandler: authHook }, async (req, reply) => {
    const userCode = (req.body?.user_code || '').toString().trim().toUpperCase();
    if (!userCode) {
      return reply.code(400).send({ error: 'bad_request', message: '缺少 user_code' });
    }
    const r = approveDevice(db, userCode, req.account.id);
    if (r === 'not_found') return reply.code(404).send({ error: 'not_found', message: '授权码不存在' });
    if (r === 'expired') return reply.code(410).send({ error: 'expired', message: '授权码已过期' });
    if (r === 'already') return reply.code(409).send({ error: 'already_approved', message: '该授权码已被确认' });
    return { ok: true };
  });

  // POST /api/auth/device/token —— 新设备轮询取 token（无需登录）。
  // approved 时一次性消费：下发会话 cookie + 返回 token/account，新设备即登录态。
  app.post('/api/auth/device/token', async (req, reply) => {
    const deviceCode = (req.body?.device_code || '').toString();
    if (!deviceCode) {
      return reply.code(400).send({ error: 'bad_request', message: '缺少 device_code' });
    }
    const deviceLabel = deviceLabelFromUA(req.headers['user-agent']);
    const r = pollDeviceToken(db, deviceCode, deviceLabel);
    if (r.status === 'not_found') {
      return reply.code(404).send({ error: 'not_found', message: '授权码不存在' });
    }
    if (r.status === 'expired') {
      return reply.code(410).send({ error: 'expired', message: '授权码已过期，请刷新重试' });
    }
    if (r.status === 'pending') {
      // 仍在等待确认：用 200 + status 让前端继续轮询（而非错误码）。
      return { status: 'pending' };
    }
    // approved：写会话 cookie，新设备后续请求即带登录态。
    reply.setCookie(COOKIE_NAME, r.token, cookieOpts);
    return { status: 'approved', account: publicAccount(r.account), token: r.token };
  });
}
