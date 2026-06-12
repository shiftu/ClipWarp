// 认证路由：login / logout / me。登录失败限速：同 IP 1 分钟窗口失败 ≥5 次 → 429。
import {
  COOKIE_NAME,
  makeCookieOpts,
  createSession,
  deleteSession,
  sweepExpired,
} from './sessions.js';
import { findByUsername, hashPassword, publicAccount, verifyPassword } from './accounts.js';

const WINDOW_MS = 60_000;
const MAX_FAILURES = 5;

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

export default function registerAuthRoutes(app, { db, authHook, secureCookie = false }) {
  const cookieOpts = makeCookieOpts(secureCookie);
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
}
