// M2 集成测试：secret 检测 / 阅后即焚 / TTL 过期 / sweeper 广播 / 旧库迁移。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { openDb } from '../src/db.js';
import { startServer, login, jfetch } from './helpers.js';

const postClip = async (base, cookie, body) =>
  (await jfetch(base, cookie, '/api/clips', { method: 'POST', body })).json();

test('secret 检测：含密钥的 clip 标记 isSensitive，普通文本不标记', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.cleanup());
  const a = await login(ctx.base, 'admin', ctx.adminPassword);

  const secret = await postClip(ctx.base, a.cookie, { content: 'AKIAIOSFODNN7EXAMPLE' });
  assert.equal(secret.clip.isSensitive, true);

  const plain = await postClip(ctx.base, a.cookie, { content: '今天的会议记录，没有任何密钥' });
  assert.equal(plain.clip.isSensitive, false);
});

test('阅后即焚：burnAfterRead 字段持久化并出现在列表', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.cleanup());
  const a = await login(ctx.base, 'admin', ctx.adminPassword);

  const { clip } = await postClip(ctx.base, a.cookie, { content: 'one-time-token', burnAfterRead: true });
  assert.equal(clip.burnAfterRead, true);

  const list = await (await jfetch(ctx.base, a.cookie, '/api/clips')).json();
  assert.equal(list.clips[0].burnAfterRead, true);
});

test('TTL：expiresAt 正确，已过期项不出现在列表与游标分页', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.cleanup());
  const a = await login(ctx.base, 'admin', ctx.adminPassword);

  const lo = Date.now();
  const { clip } = await postClip(ctx.base, a.cookie, { content: 'ttl-clip', ttlSeconds: 3600 });
  const hi = Date.now();
  assert.ok(
    clip.expiresAt >= lo + 3600 * 1000 && clip.expiresAt <= hi + 3600 * 1000,
    'expiresAt 应约等于 now + ttl'
  );

  // 强制过期后，列表应剔除
  ctx.srv.db.prepare('UPDATE clips SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, clip.id);
  const list = await (await jfetch(ctx.base, a.cookie, '/api/clips')).json();
  assert.equal(list.clips.find((c) => c.id === clip.id), undefined, '过期 clip 不应返回');
});

test('非法 TTL 返回 400 invalid_ttl', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.cleanup());
  const a = await login(ctx.base, 'admin', ctx.adminPassword);

  for (const bad of [-5, 0, 'abc']) {
    const res = await jfetch(ctx.base, a.cookie, '/api/clips', {
      method: 'POST',
      body: { content: 'x', ttlSeconds: bad },
    });
    assert.equal(res.status, 400, `ttlSeconds=${bad} 应 400`);
    assert.equal((await res.json()).error, 'invalid_ttl');
  }
});

test('sweeper 删除过期 clip 并向账号广播 clip:deleted', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.cleanup());
  const a = await login(ctx.base, 'admin', ctx.adminPassword, 'Dev');

  const { clip } = await postClip(ctx.base, a.cookie, { content: 'expire-me' });
  ctx.srv.db.prepare('UPDATE clips SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, clip.id);

  const url = ctx.base.replace('http://', 'ws://') + '/ws';
  const ws = new WebSocket(url, { headers: { cookie: a.cookie } });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  // 谓词式等待：只认 id 匹配的 clip:deleted（hello/presence 等其它帧忽略）
  const deleted = new Promise((resolve) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'clip:deleted' && msg.id === clip.id) resolve(msg.id);
    });
  });

  const n = ctx.srv.sweeper.sweep();
  assert.ok(n >= 1, 'sweep 应清除至少 1 条');

  const gotId = await Promise.race([
    deleted,
    new Promise((r) => setTimeout(() => r('timeout'), 2000)),
  ]);
  assert.equal(gotId, clip.id, '应收到该 clip 的 clip:deleted 广播');

  const row = ctx.srv.db.prepare('SELECT * FROM clips WHERE id = ?').get(clip.id);
  assert.equal(row, undefined, '过期 clip 应从 DB 删除');
  ws.close();
});

test('未过期 clip 不被 sweeper 误删', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.cleanup());
  const a = await login(ctx.base, 'admin', ctx.adminPassword);

  await postClip(ctx.base, a.cookie, { content: 'keep-forever' });
  await postClip(ctx.base, a.cookie, { content: 'keep-1h', ttlSeconds: 3600 });
  const n = ctx.srv.sweeper.sweep();
  assert.equal(n, 0, '没有已过期项，sweep 应清 0 条');
  const list = await (await jfetch(ctx.base, a.cookie, '/api/clips')).json();
  assert.equal(list.clips.length, 2);
});

test('迁移：M1 旧库（无 burn_after_read 列）打开后自动补列且保留旧数据', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipwarp-mig-'));
  const file = path.join(dir, 'old.db');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // 建库后删掉列，模拟 M1 旧库结构，并写入一条旧数据
  const db1 = await openDb(file);
  db1.exec('ALTER TABLE clips DROP COLUMN burn_after_read');
  db1
    .prepare('INSERT INTO clips (account_id, content, content_type, created_at) VALUES (?, ?, ?, ?)')
    .run(1, 'legacy-row', 'text', Date.now());
  db1.close();

  // 重新打开 → migrate 应补回列
  const db2 = await openDb(file);
  const cols = db2
    .prepare('PRAGMA table_info(clips)')
    .all()
    .map((c) => c.name);
  assert.ok(cols.includes('burn_after_read'), '应补回 burn_after_read 列');
  const row = db2.prepare('SELECT * FROM clips WHERE content = ?').get('legacy-row');
  assert.equal(row.burn_after_read, 0, '旧行 burn_after_read 默认 0');
  db2.close();
});
