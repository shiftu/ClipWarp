import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer, login, jfetch } from './helpers.js';

/** 打开 WS 并收集消息；nextMessage(pred) 等待匹配消息（默认 2s 超时）。 */
function openWs(base, cookie) {
  const url = base.replace('http://', 'ws://') + '/ws';
  const ws = new WebSocket(url, cookie ? { headers: { cookie } } : {});
  const messages = [];
  const waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    messages.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) {
        const [w] = waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    }
  });
  return {
    ws,
    messages,
    opened: new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    }),
    closed: new Promise((resolve) => ws.once('close', (code) => resolve(code))),
    nextMessage(pred, timeoutMs = 2000) {
      const hit = messages.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('等待 WS 消息超时')), timeoutMs);
        waiters.push({ pred, resolve, timer });
      });
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('WebSocket', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.cleanup());

  const a = await login(ctx.base, 'admin', ctx.adminPassword, 'DevA');
  const b = await login(ctx.base, 'admin', ctx.adminPassword, 'DevB');

  await t.test('未认证连接 → close 4401', async () => {
    const conn = openWs(ctx.base, null);
    const code = await conn.closed;
    assert.equal(code, 4401);
  });

  await t.test('hello 含 devices；第二连接触发 presence', async (t2) => {
    const connA = openWs(ctx.base, a.cookie);
    const helloA = await connA.nextMessage((m) => m.type === 'hello');
    assert.equal(helloA.devices.length, 1);
    assert.equal(helloA.devices[0].deviceLabel, 'DevA');
    assert.equal(typeof helloA.devices[0].since, 'number');

    const connB = openWs(ctx.base, b.cookie);
    const helloB = await connB.nextMessage((m) => m.type === 'hello');
    assert.equal(helloB.devices.length, 2);

    // A 收到 presence（2 个设备）
    const presence = await connA.nextMessage(
      (m) => m.type === 'presence' && m.devices.length === 2
    );
    assert.deepEqual(
      presence.devices.map((d) => d.deviceLabel).sort(),
      ['DevA', 'DevB']
    );

    await t2.test('同账号两个连接都收到 clip:new', async () => {
      const res = await jfetch(ctx.base, a.cookie, '/api/clips', {
        method: 'POST',
        body: { content: 'broadcast me' },
      });
      assert.equal(res.status, 201);
      const { clip } = await res.json();
      const [msgA, msgB] = await Promise.all([
        connA.nextMessage((m) => m.type === 'clip:new'),
        connB.nextMessage((m) => m.type === 'clip:new'),
      ]);
      assert.equal(msgA.clip.id, clip.id);
      assert.equal(msgA.clip.content, 'broadcast me');
      assert.equal(msgB.clip.id, clip.id);
    });

    await t2.test('clip:pinned 与 clip:deleted 广播', async () => {
      const { clip } = await (
        await jfetch(ctx.base, a.cookie, '/api/clips', {
          method: 'POST',
          body: { content: 'lifecycle' },
        })
      ).json();
      await jfetch(ctx.base, a.cookie, `/api/clips/${clip.id}/pin`, {
        method: 'POST',
        body: { pinned: true },
      });
      const pinnedMsg = await connB.nextMessage(
        (m) => m.type === 'clip:pinned' && m.id === clip.id
      );
      assert.equal(pinnedMsg.pinned, true);

      await jfetch(ctx.base, a.cookie, `/api/clips/${clip.id}`, { method: 'DELETE' });
      await connB.nextMessage((m) => m.type === 'clip:deleted' && m.id === clip.id);
    });

    await t2.test('异账号收不到广播', async () => {
      await jfetch(ctx.base, a.cookie, '/api/accounts', {
        method: 'POST',
        body: { username: 'carol', password: 'carol123' },
      });
      const carol = await login(ctx.base, 'carol', 'carol123', 'DevC');
      const connC = openWs(ctx.base, carol.cookie);
      const helloC = await connC.nextMessage((m) => m.type === 'hello');
      assert.equal(helloC.devices.length, 1, 'carol 房间只有自己');

      const beforeA = connA.messages.length;
      const { clip } = await (
        await jfetch(ctx.base, carol.cookie, '/api/clips', {
          method: 'POST',
          body: { content: 'carol private' },
        })
      ).json();
      // carol 自己收到
      await connC.nextMessage((m) => m.type === 'clip:new' && m.clip.id === clip.id);
      await sleep(300);
      // admin 房间没有任何关于 carol clip 的消息
      const leaked = connA.messages
        .slice(beforeA)
        .some(
          (m) =>
            (m.type === 'clip:new' && m.clip?.content === 'carol private') ||
            m.devices?.some((d) => d.deviceLabel === 'DevC')
        );
      assert.equal(leaked, false);
      connC.ws.close();
    });

    await t2.test('应用层 ping → pong', async () => {
      connA.ws.send(JSON.stringify({ type: 'ping' }));
      await connA.nextMessage((m) => m.type === 'pong');
    });

    await t2.test('断开后另一连接收到 presence', async () => {
      connB.ws.close();
      const presenceAfter = await connA.nextMessage(
        (m) => m.type === 'presence' && m.devices.length === 1
      );
      assert.equal(presenceAfter.devices[0].deviceLabel, 'DevA');
    });

    connA.ws.close();
  });
});
