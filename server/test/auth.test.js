import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, login, jfetch } from './helpers.js';

test('认证', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.cleanup());

  await t.test('health 无需认证', async () => {
    const res = await fetch(`${ctx.base}/api/health`);
    assert.equal(res.status, 200);
    // 不与具体版本号耦合（避免每次 bump 都改测试）
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.version, 'string');
  });

  await t.test('首启自动创建 admin，密码文件 chmod 600', async () => {
    const file = path.join(ctx.home, 'initial-admin-password.txt');
    assert.ok(fs.existsSync(file));
    assert.equal(ctx.adminPassword.length, 16);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(ctx.home).mode & 0o777, 0o700);
  });

  await t.test('登录成功返回 account + cookie 属性正确', async () => {
    const { body, setCookie } = await login(ctx.base, 'admin', ctx.adminPassword, 'TestDev');
    assert.deepEqual(body, { account: { id: 1, username: 'admin', role: 'admin' } });
    const lower = setCookie.toLowerCase();
    assert.ok(lower.includes('httponly'));
    assert.ok(lower.includes('samesite=lax'));
    assert.ok(lower.includes('path=/'));
    assert.ok(!lower.includes('secure'), 'cookie 不应硬编码 Secure');
    // 32 字节随机 hex = 64 个 hex 字符
    const token = setCookie.split(';')[0].split('=')[1];
    assert.match(token, /^[0-9a-f]{64}$/);
  });

  await t.test('GET /api/me 返回 account 与 deviceLabel', async () => {
    const { cookie } = await login(ctx.base, 'admin', ctx.adminPassword, 'iPhone 15');
    const res = await jfetch(ctx.base, cookie, '/api/me');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.account, { id: 1, username: 'admin', role: 'admin' });
    assert.equal(body.deviceLabel, 'iPhone 15');
  });

  await t.test('未登录访问受保护接口 → 401 unauthorized', async () => {
    const res = await jfetch(ctx.base, null, '/api/me');
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'unauthorized');
  });

  await t.test('错误密码 → 401 invalid_credentials', async () => {
    const res = await jfetch(ctx.base, null, '/api/login', {
      method: 'POST',
      body: { username: 'admin', password: 'wrong-password' },
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'invalid_credentials');
  });

  await t.test('logout 后 session 失效', async () => {
    const { cookie } = await login(ctx.base, 'admin', ctx.adminPassword);
    let res = await jfetch(ctx.base, cookie, '/api/logout', { method: 'POST' });
    assert.equal(res.status, 204);
    res = await jfetch(ctx.base, cookie, '/api/me');
    assert.equal(res.status, 401);
  });

  await t.test('deviceLabel 缺省时从 User-Agent 推断', async () => {
    const res = await fetch(`${ctx.base}/api/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      },
      body: JSON.stringify({ username: 'admin', password: ctx.adminPassword }),
    });
    assert.equal(res.status, 200);
    const cookie = res.headers.getSetCookie()[0].split(';')[0];
    const me = await (await jfetch(ctx.base, cookie, '/api/me')).json();
    assert.equal(me.deviceLabel, 'iPhone');
  });
});

test('登录限速：同 IP 1 分钟失败 5 次 → 429 rate_limited', async (t) => {
  const ctx = await startServer(); // 独立实例，避免污染其他用例
  t.after(() => ctx.cleanup());

  for (let i = 0; i < 5; i++) {
    const res = await jfetch(ctx.base, null, '/api/login', {
      method: 'POST',
      body: { username: 'admin', password: 'bad' },
    });
    assert.equal(res.status, 401, `第 ${i + 1} 次失败应为 401`);
  }
  // 第 6 次（即使密码正确）→ 429
  const res = await jfetch(ctx.base, null, '/api/login', {
    method: 'POST',
    body: { username: 'admin', password: ctx.adminPassword },
  });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, 'rate_limited');
});
