// 跨设备登录（设备授权码 + 扫码快速登录）回归测试。
// 覆盖：申请授权码、状态查询、信任设备确认、新设备轮询取 token、一次性消费、
//       过期处理、未授权拦截，以及快速登录 QR 的签名载荷。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, login } from './helpers.js';
import { createDeviceCode } from '../src/routes-auth.js';

const J = (r) => r.json();
const post = (base, url, body, cookie) =>
  fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body ?? {}),
  });

test('跨设备登录：设备授权码全流程', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.cleanup());

  await t.test('反代场景：无 body / 未知 content-type 的 POST 不再 415（线上 Cloudflare 回归）', async () => {
    // 浏览器 fetch(POST, 无 body) 不带 content-type，经 Cloudflare 转发会触发 Fastify 默认 415。
    // 兜底解析器须把这类请求当作空体放行。
    const noCt = await post(ctx.base, '/api/auth/device/code'); // helper 仍带 json 头，单独再测裸 POST：
    assert.equal(noCt.status, 200);
    const bare = await fetch(`${ctx.base}/api/auth/device/code`, { method: 'POST' }); // 无 content-type
    assert.equal(bare.status, 200);
    const unknownCt = await fetch(`${ctx.base}/api/auth/device/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
    });
    assert.equal(unknownCt.status, 200);
  });

  await t.test('新设备申请授权码：返回 device_code/user_code/verification_uri', async () => {
    const res = await post(ctx.base, '/api/auth/device/code');
    assert.equal(res.status, 200);
    const b = await J(res);
    assert.equal(typeof b.device_code, 'string');
    assert.match(b.user_code, /^CW-[A-Z2-9]{4}$/); // 无歧义字母表
    assert.ok(b.verification_uri.includes(encodeURIComponent(b.user_code)));
    assert.equal(b.expires_in, 300);
    assert.ok(b.interval >= 1);
  });

  await t.test('未确认时：check 为 pending，poll 为 pending', async () => {
    const { user_code, device_code } = await J(await post(ctx.base, '/api/auth/device/code'));
    const chk = await J(await fetch(`${ctx.base}/api/auth/device/check?user_code=${user_code}`));
    assert.deepEqual(chk, { user_code, status: 'pending' });
    const poll = await post(ctx.base, '/api/auth/device/token', { device_code });
    assert.equal(poll.status, 200);
    assert.deepEqual(await J(poll), { status: 'pending' });
  });

  await t.test('确认授权需登录态：未登录 → 401', async () => {
    const { user_code } = await J(await post(ctx.base, '/api/auth/device/code'));
    const res = await post(ctx.base, '/api/auth/device/approve', { user_code });
    assert.equal(res.status, 401);
  });

  await t.test('信任设备确认 → 新设备轮询拿到 token 且写 cookie，一次性消费', async () => {
    const { cookie } = await login(ctx.base, 'admin', ctx.adminPassword);
    const { user_code, device_code } = await J(await post(ctx.base, '/api/auth/device/code'));

    // 信任设备确认
    const ap = await post(ctx.base, '/api/auth/device/approve', { user_code }, cookie);
    assert.equal(ap.status, 200);
    assert.deepEqual(await J(ap), { ok: true });

    // check 现在为 approved
    const chk = await J(await fetch(`${ctx.base}/api/auth/device/check?user_code=${user_code}`));
    assert.equal(chk.status, 'approved');

    // 新设备轮询：approved + token + account + Set-Cookie
    const poll = await post(ctx.base, '/api/auth/device/token', { device_code });
    assert.equal(poll.status, 200);
    const body = await J(poll);
    assert.equal(body.status, 'approved');
    assert.equal(typeof body.token, 'string');
    assert.deepEqual(body.account, { id: 1, username: 'admin', role: 'admin' });
    assert.ok((poll.headers.getSetCookie() || []).some((c) => c.startsWith('cw_session=')));

    // 该 token 可直接访问受保护接口
    const me = await fetch(`${ctx.base}/api/me`, { headers: { cookie: `cw_session=${body.token}` } });
    assert.equal(me.status, 200);

    // 二次轮询：行已被消费 → 404（防重放）
    const again = await post(ctx.base, '/api/auth/device/token', { device_code });
    assert.equal(again.status, 404);
  });

  await t.test('approve 不存在的码 → 404；重复 approve → 409', async () => {
    const { cookie } = await login(ctx.base, 'admin', ctx.adminPassword);
    const notFound = await post(ctx.base, '/api/auth/device/approve', { user_code: 'CW-ZZZZ' }, cookie);
    assert.equal(notFound.status, 404);

    const { user_code } = await J(await post(ctx.base, '/api/auth/device/code'));
    assert.equal((await post(ctx.base, '/api/auth/device/approve', { user_code }, cookie)).status, 200);
    const dup = await post(ctx.base, '/api/auth/device/approve', { user_code }, cookie);
    assert.equal(dup.status, 409);
  });

  await t.test('过期码：poll → 410，approve → 410（注入 ttl<0 制造过期）', async () => {
    const { cookie } = await login(ctx.base, 'admin', ctx.adminPassword);
    // 直接用导出的工厂以负 TTL 写入一条「已过期」的码
    const { deviceCode, userCode } = createDeviceCode(ctx.srv.db, -1);
    const poll = await post(ctx.base, '/api/auth/device/token', { device_code: deviceCode });
    assert.equal(poll.status, 410);
    const ap = await post(ctx.base, '/api/auth/device/approve', { user_code: userCode }, cookie);
    assert.equal(ap.status, 410);
  });

  await t.test('缺参数 → 400', async () => {
    assert.equal((await post(ctx.base, '/api/auth/device/token', {})).status, 400);
    const { cookie } = await login(ctx.base, 'admin', ctx.adminPassword);
    assert.equal((await post(ctx.base, '/api/auth/device/approve', {}, cookie)).status, 400);
  });

  await t.test('sweeper 回收过期授权码（防止 device_codes 无界增长）', async () => {
    const db = ctx.srv.db;
    createDeviceCode(db, -1); // 已过期
    const { deviceCode: live } = createDeviceCode(db); // 未过期
    ctx.srv.sweeper.sweep();
    const rows = db.prepare('SELECT device_code FROM device_codes').all().map((r) => r.device_code);
    assert.ok(rows.includes(live)); // 未过期行保留
    // 过期行已被删除：库内不再有任何 expires_at <= now 的码
    assert.equal(db.prepare('SELECT COUNT(*) c FROM device_codes WHERE expires_at <= ?').get(Date.now()).c, 0);
  });
});

test('跨设备登录：扫码快速登录 QR', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.cleanup());

  await t.test('未登录 → 401', async () => {
    assert.equal((await fetch(`${ctx.base}/api/auth/quick-login-qr`)).status, 401);
  });

  await t.test('登录后返回带签名的预填载荷', async () => {
    const { cookie } = await login(ctx.base, 'admin', ctx.adminPassword);
    const res = await fetch(`${ctx.base}/api/auth/quick-login-qr`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const b = await J(res);
    assert.equal(b.username, 'admin');
    assert.equal(typeof b.nonce, 'string');
    assert.equal(b.sig.length, 32); // HMAC 截断到 32 hex
    assert.ok(b.url.includes('username=admin'));
    assert.ok(b.url.includes(`ql=${b.nonce}`));
  });
});
