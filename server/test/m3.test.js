// M3 测试：个人访问令牌（PAT）认证 + 关键词搜索 + LLM 自动标题（注入假 llm）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, login, jfetch } from './helpers.js';

function bfetch(base, token, url, { method = 'GET', body } = {}) {
  return fetch(`${base}${url}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function waitForTitle(base, cookie, id, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await jfetch(base, cookie, '/api/clips?limit=50');
    const { clips } = await res.json();
    const c = clips.find((x) => x.id === id);
    if (c && c.title) return c.title;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

test('PAT：创建后可用 Bearer 读写 clips，列表不含明文', async () => {
  const ctx = await startServer();
  try {
    const { cookie } = await login(ctx.base, 'admin', ctx.adminPassword);

    const createRes = await jfetch(ctx.base, cookie, '/api/tokens', {
      method: 'POST',
      body: { label: 'mcp' },
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    assert.match(created.token, /^cw_pat_[0-9a-f]{40}$/);
    assert.equal(created.label, 'mcp');
    const token = created.token;

    // 用 Bearer（无 cookie）写入
    const post = await bfetch(ctx.base, token, '/api/clips', {
      method: 'POST',
      body: { content: 'via mcp token' },
    });
    assert.equal(post.status, 201);
    const { clip } = await post.json();
    assert.equal(clip.deviceLabel, 'mcp'); // 设备名取 token 标签

    // 用 Bearer 读取
    const list = await bfetch(ctx.base, token, '/api/clips');
    assert.equal(list.status, 200);
    const { clips } = await list.json();
    assert.ok(clips.some((c) => c.id === clip.id));

    // 列表令牌：不含明文 token
    const tlist = await jfetch(ctx.base, cookie, '/api/tokens');
    const { tokens } = await tlist.json();
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].token, undefined);
    assert.equal(tokens[0].label, 'mcp');
    assert.ok(tokens[0].lastUsedAt); // 用过一次，已记录
  } finally {
    await ctx.cleanup();
  }
});

test('PAT：无效 Bearer → 401；账号隔离', async () => {
  const ctx = await startServer();
  try {
    const { cookie } = await login(ctx.base, 'admin', ctx.adminPassword);
    // 管理员建子账号 bob 并以其身份写 clip
    await jfetch(ctx.base, cookie, '/api/accounts', {
      method: 'POST',
      body: { username: 'bob', password: 'bobpw123' },
    });
    const bob = await login(ctx.base, 'bob', 'bobpw123');
    await jfetch(ctx.base, bob.cookie, '/api/clips', { method: 'POST', body: { content: 'bob-secret-note' } });

    // admin 的 PAT
    const t = await (
      await jfetch(ctx.base, cookie, '/api/tokens', { method: 'POST', body: {} })
    ).json();

    // 无效 token → 401
    const bad = await bfetch(ctx.base, 'cw_pat_deadbeef', '/api/clips');
    assert.equal(bad.status, 401);

    // admin token 读不到 bob 的 clip（账号隔离）
    const list = await bfetch(ctx.base, t.token, '/api/clips');
    const { clips } = await list.json();
    assert.ok(!clips.some((c) => c.content === 'bob-secret-note'));
  } finally {
    await ctx.cleanup();
  }
});

test('PAT：令牌管理需 cookie（用 PAT 签发/吊销 → 403），吊销后 token 失效', async () => {
  const ctx = await startServer();
  try {
    const { cookie } = await login(ctx.base, 'admin', ctx.adminPassword);
    const created = await (
      await jfetch(ctx.base, cookie, '/api/tokens', { method: 'POST', body: { label: 'a' } })
    ).json();

    // 用 PAT 再签发 token → 403 forbidden（防令牌自我增殖）
    const viaToken = await bfetch(ctx.base, created.token, '/api/tokens', {
      method: 'POST',
      body: { label: 'b' },
    });
    assert.equal(viaToken.status, 403);

    // 用 PAT 列出令牌 → 同样 403（令牌元数据不经 PAT 泄露）
    const listViaToken = await bfetch(ctx.base, created.token, '/api/tokens');
    assert.equal(listViaToken.status, 403);

    // cookie 吊销该 token
    const del = await jfetch(ctx.base, cookie, `/api/tokens/${created.id}`, { method: 'DELETE' });
    assert.equal(del.status, 204);

    // 吊销后 token 失效
    const after = await bfetch(ctx.base, created.token, '/api/clips');
    assert.equal(after.status, 401);
  } finally {
    await ctx.cleanup();
  }
});

test('搜索：关键词命中（content/title），空词 400，LIKE 元字符按字面匹配', async () => {
  const ctx = await startServer();
  try {
    const { cookie } = await login(ctx.base, 'admin', ctx.adminPassword);
    const post = (content) => jfetch(ctx.base, cookie, '/api/clips', { method: 'POST', body: { content } });
    await post('hello alpha world');
    await post('beta gamma');
    await post('contains a%b literal percent');
    await post('plain text no special');

    const r1 = await jfetch(ctx.base, cookie, '/api/clips/search?q=alpha');
    assert.equal(r1.status, 200);
    const { clips: c1 } = await r1.json();
    assert.equal(c1.length, 1);
    assert.match(c1[0].content, /alpha/);

    // 空搜索词 → 400
    const r2 = await jfetch(ctx.base, cookie, '/api/clips/search?q=');
    assert.equal(r2.status, 400);
    assert.equal((await r2.json()).error, 'empty_query');

    // '%' 应按字面匹配，只命中含 'a%b' 的那条，而不是全部
    const r3 = await jfetch(ctx.base, cookie, '/api/clips/search?q=' + encodeURIComponent('a%b'));
    const { clips: c3 } = await r3.json();
    assert.equal(c3.length, 1);
    assert.match(c3[0].content, /a%b/);
  } finally {
    await ctx.cleanup();
  }
});

test('自动标题：非敏感内容异步起标题并落库；敏感内容绝不外发 LLM', async () => {
  const calls = [];
  const fakeLlm = {
    enabled: true,
    async generateTitle(content) {
      calls.push(content);
      return '自动标题示例';
    },
  };
  const ctx = await startServer({ llm: fakeLlm });
  try {
    const { cookie } = await login(ctx.base, 'admin', ctx.adminPassword);

    // 普通内容 → 起标题
    const res = await jfetch(ctx.base, cookie, '/api/clips', {
      method: 'POST',
      body: { content: '今天开会讨论了下个季度的产品路线图' },
    });
    const { clip } = await res.json();
    assert.equal(clip.title, null); // 同步返回时还没有标题
    const title = await waitForTitle(ctx.base, cookie, clip.id);
    assert.equal(title, '自动标题示例');

    // 敏感内容（AWS Key）→ 不调用 LLM
    const before = calls.length;
    const sres = await jfetch(ctx.base, cookie, '/api/clips', {
      method: 'POST',
      body: { content: 'AKIAIOSFODNN7EXAMPLE' },
    });
    const { clip: sclip } = await sres.json();
    assert.equal(sclip.isSensitive, true);
    await new Promise((r) => setTimeout(r, 300)); // 给异步留出时间
    assert.equal(calls.length, before); // 敏感内容未触发任何 generateTitle 调用
    assert.ok(!calls.includes('AKIAIOSFODNN7EXAMPLE'));
  } finally {
    await ctx.cleanup();
  }
});

test('自动标题：clip:updated 广播携带新标题', async () => {
  const fakeLlm = { enabled: true, async generateTitle() { return 'WS标题'; } };
  const ctx = await startServer({ llm: fakeLlm });
  const { WebSocket } = await import('ws');
  try {
    const { cookie } = await login(ctx.base, 'admin', ctx.adminPassword);
    const wsUrl = ctx.base.replace('http', 'ws') + '/ws';
    const ws = new WebSocket(wsUrl, { headers: { cookie } });
    const updated = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting clip:updated')), 4000);
      ws.on('message', (buf) => {
        const msg = JSON.parse(buf.toString());
        if (msg.type === 'clip:updated' && msg.clip?.title === 'WS标题') {
          clearTimeout(timer);
          resolve(msg);
        }
      });
      ws.on('error', reject);
    });
    await new Promise((res, rej) => {
      ws.on('open', res);
      ws.on('error', rej);
    });
    await jfetch(ctx.base, cookie, '/api/clips', { method: 'POST', body: { content: '需要起标题的内容' } });
    const msg = await updated;
    assert.equal(msg.clip.title, 'WS标题');
    ws.close();
  } finally {
    await ctx.cleanup();
  }
});
