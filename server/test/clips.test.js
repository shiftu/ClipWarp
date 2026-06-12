import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, login, jfetch } from './helpers.js';

test('Clips', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.cleanup());
  const { cookie } = await login(ctx.base, 'admin', ctx.adminPassword, 'TestMac');

  await t.test('POST 创建并返回完整 Clip 对象', async () => {
    const res = await jfetch(ctx.base, cookie, '/api/clips', {
      method: 'POST',
      body: { content: 'hello clipwarp' },
    });
    assert.equal(res.status, 201);
    const { clip } = await res.json();
    assert.equal(clip.content, 'hello clipwarp');
    assert.equal(clip.contentType, 'text');
    assert.equal(clip.title, null);
    assert.equal(clip.isPinned, false);
    assert.equal(clip.isSensitive, false);
    assert.equal(clip.deviceLabel, 'TestMac');
    assert.equal(typeof clip.id, 'number');
    assert.equal(typeof clip.createdAt, 'number');
  });

  await t.test('类型识别：json / url / code / text', async () => {
    const cases = [
      ['  {"a": 1}', 'json'],
      ['[1,2,3]', 'json'],
      ['{not json', 'text'],
      ['https://example.com/path?q=1', 'url'],
      ['http://a.b', 'url'],
      ['https://example.com x', 'text'], // 含空格不是纯 URL
      ['function foo() {\n  return 1;\n}', 'code'],
      ['import fs from "fs"\nconsole.log(fs)', 'code'],
      ['just a line', 'text'],
      ['两行\n纯文本而已', 'text'],
    ];
    for (const [content, expected] of cases) {
      const res = await jfetch(ctx.base, cookie, '/api/clips', {
        method: 'POST',
        body: { content },
      });
      assert.equal(res.status, 201);
      const { clip } = await res.json();
      assert.equal(clip.contentType, expected, `content=${JSON.stringify(content)}`);
    }
  });

  await t.test('空内容 → 400 empty_content', async () => {
    for (const body of [{ content: '' }, {}]) {
      const res = await jfetch(ctx.base, cookie, '/api/clips', { method: 'POST', body });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error, 'empty_content');
    }
  });

  await t.test('超过 1MB UTF-8 字节 → 400 content_too_large', async () => {
    const res = await jfetch(ctx.base, cookie, '/api/clips', {
      method: 'POST',
      body: { content: 'a'.repeat(1_048_577) },
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'content_too_large');
    // 恰好 1MB 应该成功
    const ok = await jfetch(ctx.base, cookie, '/api/clips', {
      method: 'POST',
      body: { content: 'a'.repeat(1_048_576) },
    });
    assert.equal(ok.status, 201);
  });

  await t.test('DELETE 与 404', async () => {
    const created = await (
      await jfetch(ctx.base, cookie, '/api/clips', { method: 'POST', body: { content: 'x' } })
    ).json();
    let res = await jfetch(ctx.base, cookie, `/api/clips/${created.clip.id}`, {
      method: 'DELETE',
    });
    assert.equal(res.status, 204);
    res = await jfetch(ctx.base, cookie, `/api/clips/${created.clip.id}`, { method: 'DELETE' });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, 'not_found');
  });

  await t.test('pin / unpin', async () => {
    const created = await (
      await jfetch(ctx.base, cookie, '/api/clips', { method: 'POST', body: { content: 'pin me' } })
    ).json();
    let res = await jfetch(ctx.base, cookie, `/api/clips/${created.clip.id}/pin`, {
      method: 'POST',
      body: { pinned: true },
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).clip.isPinned, true);
    res = await jfetch(ctx.base, cookie, `/api/clips/${created.clip.id}/pin`, {
      method: 'POST',
      body: { pinned: false },
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).clip.isPinned, false);
    res = await jfetch(ctx.base, cookie, '/api/clips/999999/pin', {
      method: 'POST',
      body: { pinned: true },
    });
    assert.equal(res.status, 404);
  });
});

test('Clips 分页', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.cleanup());
  const { cookie } = await login(ctx.base, 'admin', ctx.adminPassword);

  await t.test('默认 limit 50、before 游标、hasMore、limit 上限 200', async () => {
    const insert = ctx.srv.db.prepare(
      'INSERT INTO clips (account_id, content, content_type, created_at) VALUES (?, ?, ?, ?)'
    );
    for (let i = 1; i <= 230; i++) insert.run(1, `clip-${i}`, 'text', Date.now());

    // 默认 limit=50，倒序最新在前
    let res = await jfetch(ctx.base, cookie, '/api/clips');
    let body = await res.json();
    assert.equal(body.clips.length, 50);
    assert.equal(body.hasMore, true);
    assert.equal(body.clips[0].content, 'clip-230');
    assert.ok(body.clips[0].id > body.clips[1].id);

    // before 游标：返回 id < before
    const lastId = body.clips.at(-1).id;
    res = await jfetch(ctx.base, cookie, `/api/clips?limit=100&before=${lastId}`);
    body = await res.json();
    assert.equal(body.clips.length, 100);
    assert.ok(body.clips.every((c) => c.id < lastId));

    // limit 超过 200 被钳到 200
    res = await jfetch(ctx.base, cookie, '/api/clips?limit=999');
    body = await res.json();
    assert.equal(body.clips.length, 200);
    assert.equal(body.hasMore, true);

    // 翻到底 hasMore=false
    res = await jfetch(ctx.base, cookie, `/api/clips?limit=200&before=${body.clips.at(-1).id}`);
    body = await res.json();
    assert.equal(body.hasMore, false);
  });
});

test('插入后裁剪：未 pin 只留最新 500，pinned 永久保留', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.cleanup());
  const { cookie } = await login(ctx.base, 'admin', ctx.adminPassword);

  const insert = ctx.srv.db.prepare(
    'INSERT INTO clips (account_id, content, content_type, is_pinned, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  // 2 条 pinned（最老）+ 520 条未 pin
  insert.run(1, 'pinned-old-1', 'text', 1, Date.now());
  insert.run(1, 'pinned-old-2', 'text', 1, Date.now());
  for (let i = 1; i <= 520; i++) insert.run(1, `bulk-${i}`, 'text', 0, Date.now());

  // 通过 API 插入触发裁剪
  const res = await jfetch(ctx.base, cookie, '/api/clips', {
    method: 'POST',
    body: { content: 'trigger-trim' },
  });
  assert.equal(res.status, 201);

  const rows = ctx.srv.db
    .prepare('SELECT content, is_pinned FROM clips WHERE account_id = 1 ORDER BY id ASC')
    .all();
  const unpinned = rows.filter((r) => !r.is_pinned);
  const pinned = rows.filter((r) => r.is_pinned);
  assert.equal(unpinned.length, 500, '未 pin 的只留最新 500 条');
  assert.equal(pinned.length, 2, 'pinned 永久保留');
  assert.equal(unpinned.at(-1).content, 'trigger-trim');
  // 最老的未 pin 已被裁掉（bulk-1..bulk-21 共 21 条被裁）
  assert.ok(!unpinned.some((r) => r.content === 'bulk-1'));
  assert.ok(unpinned.some((r) => r.content === 'bulk-22'));
});

test('账号隔离', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.cleanup());
  const admin = await login(ctx.base, 'admin', ctx.adminPassword);

  // 建子账号 B
  let res = await jfetch(ctx.base, admin.cookie, '/api/accounts', {
    method: 'POST',
    body: { username: 'bob', password: 'bob123456' },
  });
  assert.equal(res.status, 201);
  const bob = await login(ctx.base, 'bob', 'bob123456');

  // A（admin）创建 clip
  const created = await (
    await jfetch(ctx.base, admin.cookie, '/api/clips', {
      method: 'POST',
      body: { content: 'admin secret clip' },
    })
  ).json();
  const clipId = created.clip.id;

  await t.test('B 的列表看不到 A 的 clip', async () => {
    const body = await (await jfetch(ctx.base, bob.cookie, '/api/clips')).json();
    assert.equal(body.clips.length, 0);
    assert.equal(body.hasMore, false);
  });

  await t.test('B DELETE A 的 clip → 404', async () => {
    const r = await jfetch(ctx.base, bob.cookie, `/api/clips/${clipId}`, { method: 'DELETE' });
    assert.equal(r.status, 404);
    assert.equal((await r.json()).error, 'not_found');
  });

  await t.test('B pin A 的 clip → 404，且 A 的 clip 原样', async () => {
    const r = await jfetch(ctx.base, bob.cookie, `/api/clips/${clipId}/pin`, {
      method: 'POST',
      body: { pinned: true },
    });
    assert.equal(r.status, 404);
    const list = await (await jfetch(ctx.base, admin.cookie, '/api/clips')).json();
    assert.equal(list.clips[0].id, clipId);
    assert.equal(list.clips[0].isPinned, false);
  });
});
