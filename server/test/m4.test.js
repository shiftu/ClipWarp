// M4 端到端：静态加密落盘、读取解密、自动标题加密、错密钥 fail-fast、损坏行隔离。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, login, jfetch } from './helpers.js';

const KEY = 'e'.repeat(64);

async function waitForTitle(base, cookie, id, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { clips } = await (await jfetch(base, cookie, '/api/clips?limit=50')).json();
    const c = clips.find((x) => x.id === id);
    if (c && c.title) return c.title;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

test('落盘为密文、读取返回明文', async () => {
  const ctx = await startServer({ cryptoKey: KEY });
  try {
    const { cookie } = await login(ctx.base, 'admin', ctx.adminPassword);
    const secret = 'super-secret-plaintext-12345';
    const { clip } = await (
      await jfetch(ctx.base, cookie, '/api/clips', { method: 'POST', body: { content: secret } })
    ).json();
    // 直接读 DB 原始列：是 enc:v1: 密文且不含明文子串
    const raw = ctx.srv.db.prepare('SELECT content FROM clips WHERE id = ?').get(clip.id);
    assert.ok(raw.content.startsWith('enc:v1:'));
    assert.ok(!raw.content.includes(secret));
    // API 读取返回明文
    const { clips } = await (await jfetch(ctx.base, cookie, '/api/clips')).json();
    assert.equal(clips.find((c) => c.id === clip.id).content, secret);
  } finally {
    await ctx.cleanup();
  }
});

test('自动标题：title 落库密文、API 返回明文', async () => {
  const fakeLlm = { enabled: true, async generateTitle() { return '会议纪要'; } };
  const ctx = await startServer({ cryptoKey: KEY, llm: fakeLlm });
  try {
    const { cookie } = await login(ctx.base, 'admin', ctx.adminPassword);
    const { clip } = await (
      await jfetch(ctx.base, cookie, '/api/clips', { method: 'POST', body: { content: '今天的会议内容' } })
    ).json();
    const title = await waitForTitle(ctx.base, cookie, clip.id);
    assert.equal(title, '会议纪要');
    const raw = ctx.srv.db.prepare('SELECT title FROM clips WHERE id = ?').get(clip.id);
    assert.ok(raw.title.startsWith('enc:v1:'));
  } finally {
    await ctx.cleanup();
  }
});

test('损坏行隔离：一条坏密文不影响其余列表', async () => {
  const ctx = await startServer({ cryptoKey: KEY });
  try {
    const { cookie } = await login(ctx.base, 'admin', ctx.adminPassword);
    const { clip: ok } = await (
      await jfetch(ctx.base, cookie, '/api/clips', { method: 'POST', body: { content: 'good clip' } })
    ).json();
    // 手动注入一条像密文但解不开的行（绕过迁移自检，直接写 DB）
    ctx.srv.db
      .prepare('INSERT INTO clips (account_id, content, content_type, created_at) VALUES (?,?,?,?)')
      .run(1, 'enc:v1:' + Buffer.alloc(40, 9).toString('base64'), 'text', Date.now());
    const res = await jfetch(ctx.base, cookie, '/api/clips');
    assert.equal(res.status, 200); // 不 500
    const { clips } = await res.json();
    assert.ok(clips.some((c) => c.id === ok.id && c.content === 'good clip'));
  } finally {
    await ctx.cleanup();
  }
});

test('错密钥 fail-fast：旧库用错 CLIPWARP_KEY 启动直接拒绝', async () => {
  const { openDb } = await import('../src/db.js');
  const { createCrypto } = await import('../src/crypto.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-m4-'));
  const dbFile = path.join(home, 'data', 'clipwarp.db');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = await openDb(dbFile);
  const cryptoA = createCrypto({ home, env: { CLIPWARP_KEY: KEY } });
  db.prepare('INSERT INTO clips (account_id, content, content_type, created_at) VALUES (?,?,?,?)')
    .run(1, cryptoA.encrypt('A data'), 'text', Date.now());
  db.close();
  // 用错密钥启动同一 home → createServer 应抛错（迁移自检）
  const { createServer } = await import('../index.js');
  await assert.rejects(
    createServer({ home, port: 0, host: '127.0.0.1', cryptoKey: 'f'.repeat(64),
      llm: { enabled: false, generateTitle: async () => null } }),
    /不匹配/
  );
  fs.rmSync(home, { recursive: true, force: true });
});

test('搜索：命中密文内容、Unicode 大小写不敏感、account 隔离', async () => {
  const ctx = await startServer({ cryptoKey: KEY });
  try {
    const { cookie } = await login(ctx.base, 'admin', ctx.adminPassword);
    const post = (content) => jfetch(ctx.base, cookie, '/api/clips', { method: 'POST', body: { content } });
    await post('hello Alpha world');
    await post('Café RÉSUMÉ');
    // 子串命中（密文内容）
    const { clips: c1 } = await (await jfetch(ctx.base, cookie, '/api/clips/search?q=alpha')).json();
    assert.equal(c1.length, 1);
    assert.match(c1[0].content, /Alpha/);
    // Unicode 大小写不敏感：é 配 É
    const { clips: c2 } = await (
      await jfetch(ctx.base, cookie, '/api/clips/search?q=' + encodeURIComponent('résumé'))
    ).json();
    assert.equal(c2.length, 1);
    // 空词 400
    assert.equal((await jfetch(ctx.base, cookie, '/api/clips/search?q=')).status, 400);
    // account 隔离：bob 看不到 admin 的 clip
    await jfetch(ctx.base, cookie, '/api/accounts', { method: 'POST', body: { username: 'bob', password: 'bobpw123' } });
    const bob = await login(ctx.base, 'bob', 'bobpw123');
    const { clips: c3 } = await (await jfetch(ctx.base, bob.cookie, '/api/clips/search?q=alpha')).json();
    assert.equal(c3.length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('搜索：pinned 永远可搜（不被普通量裁剪挤掉）', async () => {
  const ctx = await startServer({ cryptoKey: KEY });
  try {
    const { cookie } = await login(ctx.base, 'admin', ctx.adminPassword);
    // 先建一条并 pin
    const { clip } = await (
      await jfetch(ctx.base, cookie, '/api/clips', { method: 'POST', body: { content: 'PINNED-marker-xyz' } })
    ).json();
    await jfetch(ctx.base, cookie, `/api/clips/${clip.id}/pin`, { method: 'POST', body: { pinned: true } });
    // 再灌一批普通 clip（触发未 pin 裁剪逻辑，但不影响 pinned）
    for (let i = 0; i < 30; i++) {
      await jfetch(ctx.base, cookie, '/api/clips', { method: 'POST', body: { content: `bulk ${i}` } });
    }
    const { clips } = await (await jfetch(ctx.base, cookie, '/api/clips/search?q=PINNED-marker')).json();
    assert.ok(clips.some((c) => c.id === clip.id));
  } finally {
    await ctx.cleanup();
  }
});
