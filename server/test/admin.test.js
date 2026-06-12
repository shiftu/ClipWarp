import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, login, jfetch } from './helpers.js';

test('Admin 账号管理', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.cleanup());
  const admin = await login(ctx.base, 'admin', ctx.adminPassword);

  // 准备一个普通账号
  let res = await jfetch(ctx.base, admin.cookie, '/api/accounts', {
    method: 'POST',
    body: { username: 'alice', password: 'alice123' },
  });
  assert.equal(res.status, 201);
  const aliceAccount = (await res.json()).account;
  assert.deepEqual(aliceAccount, { id: aliceAccount.id, username: 'alice', role: 'user' });
  const alice = await login(ctx.base, 'alice', 'alice123');

  await t.test('非 admin 访问 admin 路由 → 403 forbidden', async () => {
    for (const [method, url, body] of [
      ['GET', '/api/accounts', undefined],
      ['POST', '/api/accounts', { username: 'x2', password: 'xx12345' }],
      ['DELETE', '/api/accounts/1', undefined],
      ['POST', '/api/accounts/1/password', { password: 'newpass1' }],
    ]) {
      const r = await jfetch(ctx.base, alice.cookie, url, { method, body });
      assert.equal(r.status, 403, `${method} ${url}`);
      assert.equal((await r.json()).error, 'forbidden');
    }
  });

  await t.test('列账号含 clipCount', async () => {
    await jfetch(ctx.base, alice.cookie, '/api/clips', {
      method: 'POST',
      body: { content: 'alice clip' },
    });
    const r = await jfetch(ctx.base, admin.cookie, '/api/accounts');
    assert.equal(r.status, 200);
    const { accounts } = await r.json();
    const a = accounts.find((x) => x.username === 'alice');
    assert.equal(a.role, 'user');
    assert.equal(a.clipCount, 1);
    assert.equal(typeof a.createdAt, 'number');
    assert.ok(accounts.find((x) => x.username === 'admin'));
  });

  await t.test('建号校验：invalid_username / weak_password / 重名 409', async () => {
    let r = await jfetch(ctx.base, admin.cookie, '/api/accounts', {
      method: 'POST',
      body: { username: 'a', password: 'abcdefg' }, // 太短
    });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'invalid_username');

    r = await jfetch(ctx.base, admin.cookie, '/api/accounts', {
      method: 'POST',
      body: { username: 'has space', password: 'abcdefg' },
    });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'invalid_username');

    r = await jfetch(ctx.base, admin.cookie, '/api/accounts', {
      method: 'POST',
      body: { username: 'goodname', password: '12345' }, // <6 位
    });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'weak_password');

    r = await jfetch(ctx.base, admin.cookie, '/api/accounts', {
      method: 'POST',
      body: { username: 'alice', password: 'whatever123' },
    });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).error, 'username_taken');
  });

  await t.test('不能删自己 / admin 角色 → 400 cannot_delete；不存在 → 404', async () => {
    let r = await jfetch(ctx.base, admin.cookie, '/api/accounts/1', { method: 'DELETE' });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'cannot_delete');

    r = await jfetch(ctx.base, admin.cookie, '/api/accounts/424242', { method: 'DELETE' });
    assert.equal(r.status, 404);
    assert.equal((await r.json()).error, 'not_found');
  });

  await t.test('重置密码：吊销该账号全部 session', async () => {
    const r = await jfetch(ctx.base, admin.cookie, `/api/accounts/${aliceAccount.id}/password`, {
      method: 'POST',
      body: { password: 'newpass789' },
    });
    assert.equal(r.status, 204);
    // 旧 session 失效
    const me = await jfetch(ctx.base, alice.cookie, '/api/me');
    assert.equal(me.status, 401);
    // 旧密码不能登录，新密码可以
    const bad = await jfetch(ctx.base, null, '/api/login', {
      method: 'POST',
      body: { username: 'alice', password: 'alice123' },
    });
    assert.equal(bad.status, 401);
    await login(ctx.base, 'alice', 'newpass789');
  });

  await t.test('重置密码弱密码 → 400 weak_password', async () => {
    const r = await jfetch(ctx.base, admin.cookie, `/api/accounts/${aliceAccount.id}/password`, {
      method: 'POST',
      body: { password: '123' },
    });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'weak_password');
  });

  await t.test('删号级联删除 sessions + clips', async () => {
    const alice2 = await login(ctx.base, 'alice', 'newpass789');
    await jfetch(ctx.base, alice2.cookie, '/api/clips', {
      method: 'POST',
      body: { content: 'to be cascaded' },
    });

    const r = await jfetch(ctx.base, admin.cookie, `/api/accounts/${aliceAccount.id}`, {
      method: 'DELETE',
    });
    assert.equal(r.status, 204);

    // session 级联：旧 cookie 失效
    assert.equal((await jfetch(ctx.base, alice2.cookie, '/api/me')).status, 401);
    // DB 级联：sessions/clips 均无残留
    const db = ctx.srv.db;
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM clips WHERE account_id = ?').get(aliceAccount.id).n,
      0
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE account_id = ?').get(aliceAccount.id).n,
      0
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE id = ?').get(aliceAccount.id).n,
      0
    );
    // 不能再登录
    const bad = await jfetch(ctx.base, null, '/api/login', {
      method: 'POST',
      body: { username: 'alice', password: 'newpass789' },
    });
    assert.equal(bad.status, 401);
  });
});
