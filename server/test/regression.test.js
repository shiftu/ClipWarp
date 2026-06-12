// 回归测试：锁定审查阶段确认并已修复的问题。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createServer } from '../index.js';
import { startServer, login, jfetch } from './helpers.js';

test('WS upgrade 收到畸形 Cookie 不会打崩进程（未认证远程 DoS 修复）', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.cleanup());

  const url = ctx.base.replace('http://', 'ws://') + '/ws';
  // cw_session=% 会让 decodeURIComponent 抛 URIError；修复前未捕获，直接 crash 整个进程。
  for (const bad of ['cw_session=%', 'cw_session=%zz; other=%E0%A4', 'a=%C0%80; cw_session=%']) {
    const ws = new WebSocket(url, { headers: { cookie: bad } });
    const code = await new Promise((resolve) => {
      ws.once('close', (c) => resolve(c));
      ws.once('error', () => resolve(-1));
    });
    // 视为未认证：4401 关闭（绝不是进程崩溃）
    assert.equal(code, 4401, `畸形 cookie「${bad}」应以 4401 关闭`);
  }

  // 进程仍存活：健康检查与正常登录照常工作
  const health = await fetch(`${ctx.base}/api/health`);
  assert.equal(health.status, 200);
  const a = await login(ctx.base, 'admin', ctx.adminPassword, 'Dev');
  assert.ok(a.cookie);
});

test('登出后 WS 连接被主动断开（session 吊销不再收广播）', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clipwarp-rev-'));
  // 100ms 心跳：让 session 复验快速触发，便于断言
  const srv = await createServer({ home, port: 0, host: '127.0.0.1', wsHeartbeatMs: 100 });
  const { port } = await srv.listen();
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await srv.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const password = fs
    .readFileSync(path.join(home, 'initial-admin-password.txt'), 'utf8')
    .trim();
  const a = await login(base, 'admin', password, 'Dev');

  const url = base.replace('http://', 'ws://') + '/ws';
  const ws = new WebSocket(url, { headers: { cookie: a.cookie } });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const closed = new Promise((resolve) => ws.once('close', (c) => resolve(c)));

  // 登出 → session 行删除 → 下一次心跳复验失败 → 服务端 close(4401)
  const out = await jfetch(base, a.cookie, '/api/logout', { method: 'POST' });
  assert.equal(out.status, 204);

  const code = await Promise.race([
    closed,
    new Promise((r) => setTimeout(() => r('timeout'), 2000)),
  ]);
  assert.equal(code, 4401, '登出后心跳应在 2s 内以 4401 断开旧连接');
});

test('超过 bodyLimit 的请求体返回契约化错误 {error:"content_too_large"}', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.cleanup());
  const a = await login(ctx.base, 'admin', ctx.adminPassword);

  // 2MB bodyLimit 之上：框架层 413，经 setErrorHandler 归一为业务错误码
  const huge = 'x'.repeat(2 * 1024 * 1024 + 1024);
  const res = await jfetch(ctx.base, a.cookie, '/api/clips', {
    method: 'POST',
    body: { content: huge },
  });
  assert.equal(res.status, 413);
  const json = await res.json();
  assert.equal(json.error, 'content_too_large');
  assert.ok(typeof json.message === 'string');
});

test('COOKIE_SECURE 开启时会话 cookie 带 Secure 标志', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clipwarp-sec-'));
  const srv = await createServer({ home, port: 0, host: '127.0.0.1', secureCookie: true });
  const { port } = await srv.listen();
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await srv.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const password = fs
    .readFileSync(path.join(home, 'initial-admin-password.txt'), 'utf8')
    .trim();
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password }),
  });
  assert.equal(res.status, 200);
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('cw_session='));
  assert.match(setCookie, /;\s*Secure/i, 'secureCookie=true 时应带 Secure 标志');
  assert.match(setCookie, /HttpOnly/i);
});

test('默认（未开启 Secure）会话 cookie 不带 Secure，本地 http 可用', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.cleanup());
  const a = await login(ctx.base, 'admin', ctx.adminPassword);
  assert.doesNotMatch(a.setCookie, /;\s*Secure/i);
  assert.match(a.setCookie, /HttpOnly/i);
  assert.match(a.setCookie, /SameSite=Lax/i);
});
