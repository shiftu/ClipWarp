// 测试公共工具：临时 HOME + port 0 启动、登录取 cookie、JSON fetch。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../index.js';

export async function startServer() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clipwarp-test-'));
  const srv = await createServer({ home, port: 0, host: '127.0.0.1' });
  const { port } = await srv.listen();
  const base = `http://127.0.0.1:${port}`;
  return {
    srv,
    home,
    port,
    base,
    adminPassword: fs.readFileSync(path.join(home, 'initial-admin-password.txt'), 'utf8').trim(),
    async cleanup() {
      await srv.close();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

/** 登录并返回 Cookie 头（cw_session=...）。 */
export async function login(base, username, password, deviceLabel) {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, deviceLabel }),
  });
  if (res.status !== 200) {
    throw new Error(`login failed: ${res.status} ${await res.text()}`);
  }
  const setCookies = res.headers.getSetCookie();
  const raw = setCookies.find((c) => c.startsWith('cw_session='));
  if (!raw) throw new Error('no cw_session cookie');
  return { cookie: raw.split(';')[0], body: await res.json(), setCookie: raw };
}

export function jfetch(base, cookie, url, { method = 'GET', body } = {}) {
  return fetch(`${base}${url}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
