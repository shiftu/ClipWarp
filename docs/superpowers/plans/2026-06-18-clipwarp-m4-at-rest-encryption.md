# ClipWarp M4 (v1.0) 静态加密 + 平滑升级广播 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 ClipWarp 的 clip `content`/`title` 加 AES-256-GCM 静态加密（服务端仍读明文），启动时一次性迁移存量明文，并加平滑升级广播，发版 v1.0.0。

**Architecture:** 新增 `crypto.js`（主密钥 + encrypt/decrypt/classify，GCM 验证为「是否密文」权威判据，decrypt 全函数永不抛）与 `migrate-encrypt.js`（启动一次性逐字段加密，前置密钥自检 + 自动备份）。clip 路由是唯一明密转换点：写入前算元数据后加密，`toClip` 闭包读出时解密，搜索改内存解密过滤。wshub 加 `broadcastAll`，关停先广播「升级中」再 drain。

**Tech Stack:** Node ESM（纯 JS）、`node:crypto`（AES-256-GCM）、Fastify 5、better-sqlite3 / node:sqlite 双驱动、`ws`、React 18 + Vite、`node --test`。

**对应 spec：** `docs/superpowers/specs/2026-06-17-clipwarp-m4-at-rest-encryption-design.md`

## Global Constraints

- 纯 JS ESM，不引入 TypeScript；不新增运行时依赖（仅用 `node:crypto`）。
- 加密算法固定 `aes-256-gcm`，IV 12 字节随机，tag 16 字节，**v1.0 不设 AAD**。
- 存储串格式：`enc:v1:` + base64(`IV(12) ‖ tag(16) ‖ ciphertext`)。常量：`PREFIX='enc:v1:'`、`IV_LEN=12`、`TAG_LEN=16`、`MIN_BLOB=28`。
- 「是否密文」判据是 **GCM 验证**，不是字符串前缀；前缀仅作快速预筛。
- `decrypt` 是全函数：**永不抛错**，非 `cipher-valid` 一律原样返回存储串。
- `CLIPWARP_KEY` 解析顺序：`/^[0-9a-fA-F]{64}$/` → hex；否则 base64 且解码长度严格 `===32` 且往返一致；都不满足 → 抛错拒绝启动。
- `master.key` 路径 = `path.join(cfg.home, 'master.key')`（在 `home`，**不在** `home/data`），原子创建 `flag:'wx', mode:0o600`，EEXIST → 读已存在。
- 迁移/密钥自检失败 → **fail-fast 阻断启动**（与 sweeper 启动失败可吞掉不同）。
- 数据库驱动无关：事务用 `db.exec('BEGIN'|'COMMIT'|'ROLLBACK')`，禁用 better-sqlite3 专有 `db.transaction()`。
- 测试：`node --test 'test/*.test.js'`；固定密钥经 `startServer({ cryptoKey })` 注入，**禁止改 `process.env.CLIPWARP_KEY`**。
- 日志/错误信息**绝不**包含 clip 内容、密文串或明文。
- 提交信息中文，结尾加 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。
- 当前版本 0.3.0 → 目标 1.0.0（已核实非降级）。
- 分支：`feat/m4-at-rest-encryption`（spec 已提交于此分支 commit fc54181）。

## File Structure

**新增**
- `server/src/crypto.js` — 主密钥加载 + `encrypt`/`decrypt`/`classify` + `parseKey`（导出供测试）
- `server/src/migrate-encrypt.js` — `encryptExistingClips({ db, crypto, dbFile })`
- `server/test/crypto.test.js`、`server/test/migrate-encrypt.test.js`、`server/test/m4.test.js`

**修改**
- `server/index.js` — 装配 crypto（传 `cfg.home`、`opts.cryptoKey`）、调用迁移（fail-fast）、传 crypto 给 clip 路由、shutdown 重入守卫+broadcastAll+drain
- `server/src/routes-clips.js` — `makeToClip(crypto)` 解密闭包、POST 加密、`scheduleAutoTitle` 加 `crypto`/`toClip` 入参并加密 title、搜索改内存过滤
- `server/src/wshub.js` — 导出 `broadcastAll`
- `web/src/components/Board.jsx` — `upgrading`/`everConnected` + `onOpen(isReconnect)` + `sys` 消息 + 横幅
- `web/src/styles.css` — 横幅样式
- `scripts/deploy-launchd.sh` — 健康检查重试循环
- `server/package.json`、`web/package.json`、`mcp/package.json` — 1.0.0
- `.gitignore` — `master.key`、`*.key`
- `CHANGELOG.md`、`README.md`、`docs/design.md`、`docs/api.md`

---

## Task 1: 加密内核 crypto.js

**Files:**
- Create: `server/src/crypto.js`
- Test: `server/test/crypto.test.js`

**Interfaces:**
- Produces:
  - `parseKey(s: string) → Buffer(32)`（非法抛错）
  - `createCrypto({ home: string, env?: object }) → { encrypt(plaintext: string)→string, decrypt(stored: string)→string, classify(stored: string)→'plaintext'|'cipher-valid'|'cipher-undecryptable', keySource: 'env'|'file'|'generated' }`

- [ ] **Step 1: 写失败测试 `server/test/crypto.test.js`**

```js
// crypto.js 单测：密钥解析、加解密往返、分类三态、全函数 decrypt、密钥生成。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCrypto, parseKey } from '../src/crypto.js';

const HEX = 'a'.repeat(64); // 32 字节
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cw-crypto-'));

test('parseKey：64-hex 按 hex；32 字节 base64；非法抛错', () => {
  assert.equal(parseKey(HEX).length, 32);
  const b64 = Buffer.alloc(32, 7).toString('base64');
  assert.equal(parseKey(b64).length, 32);
  assert.throws(() => parseKey('short'));
  assert.throws(() => parseKey(Buffer.alloc(16).toString('base64'))); // 16 字节 base64
  assert.throws(() => parseKey(''));
});

test('encrypt/decrypt 往返：中文/emoji/空串/1MB', () => {
  const c = createCrypto({ home: tmpHome(), env: { CLIPWARP_KEY: HEX } });
  for (const s of ['hello', '你好世界 🚀', '', 'x'.repeat(1024 * 1024)]) {
    const enc = c.encrypt(s);
    assert.ok(enc.startsWith('enc:v1:'));
    assert.equal(c.decrypt(enc), s);
  }
});

test('随机 IV：同明文两次加密密文不同', () => {
  const c = createCrypto({ home: tmpHome(), env: { CLIPWARP_KEY: HEX } });
  assert.notEqual(c.encrypt('same'), c.encrypt('same'));
});

test('classify 三态 + decrypt 全函数永不抛', () => {
  const c = createCrypto({ home: tmpHome(), env: { CLIPWARP_KEY: HEX } });
  // 旧明文（无前缀）
  assert.equal(c.classify('plain text'), 'plaintext');
  assert.equal(c.decrypt('plain text'), 'plain text');
  // 用户粘贴的像前缀短文本（解码 < 28 字节）
  assert.equal(c.classify('enc:v1:hello'), 'plaintext');
  assert.equal(c.decrypt('enc:v1:hello'), 'enc:v1:hello');
  // 合法密文
  const enc = c.encrypt('secret');
  assert.equal(c.classify(enc), 'cipher-valid');
  // 篡改密文 → cipher-undecryptable，decrypt 原样返回不抛
  const tampered = enc.slice(0, -2) + (enc.endsWith('A') ? 'B' : 'A') + enc.slice(-1);
  assert.equal(c.classify(tampered), 'cipher-undecryptable');
  assert.equal(c.decrypt(tampered), tampered);
});

test('错误密钥：合法密文在另一密钥下为 cipher-undecryptable', () => {
  const home = tmpHome();
  const a = createCrypto({ home, env: { CLIPWARP_KEY: HEX } });
  const b = createCrypto({ home, env: { CLIPWARP_KEY: 'b'.repeat(64) } });
  const enc = a.encrypt('owned by A');
  assert.equal(b.classify(enc), 'cipher-undecryptable');
  assert.equal(b.decrypt(enc), enc); // 不抛
});

test('生成 master.key：mode 0o600 + keySource，EEXIST 走读取', () => {
  const home = tmpHome();
  const c1 = createCrypto({ home, env: {} });
  assert.equal(c1.keySource, 'generated');
  const keyPath = path.join(home, 'master.key');
  assert.ok(fs.existsSync(keyPath));
  assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
  // 再次创建 → 读已存在文件
  const c2 = createCrypto({ home, env: {} });
  assert.equal(c2.keySource, 'file');
  // 同密钥：c1 加密 c2 能解
  assert.equal(c2.decrypt(c1.encrypt('roundtrip')), 'roundtrip');
});

test('env 优先于文件；keySource=env', () => {
  const home = tmpHome();
  createCrypto({ home, env: {} }); // 先生成文件
  const c = createCrypto({ home, env: { CLIPWARP_KEY: HEX } });
  assert.equal(c.keySource, 'env');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ~/github/ClipWarp/server && node --test test/crypto.test.js`
Expected: FAIL（`Cannot find module '../src/crypto.js'`）

- [ ] **Step 3: 实现 `server/src/crypto.js`**

```js
// 静态加密内核：主密钥（master.key/CLIPWARP_KEY）+ AES-256-GCM。
// 「是否密文」以 GCM 验证为权威判据，enc:v1: 前缀仅作快速预筛。
// decrypt 是全函数：永不抛错，非合法密文一律原样返回（兼容旧明文 / 用户粘贴的像前缀文本 / 损坏行）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PREFIX = 'enc:v1:';
const IV_LEN = 12;
const TAG_LEN = 16;
const MIN_BLOB = IV_LEN + TAG_LEN; // 28

// 把 CLIPWARP_KEY / master.key 文本解析为 32 字节密钥。
// 顺序：纯 64 hex → hex（永不当 base64）；否则 base64 且解码长度严格 ===32 且往返一致；都不满足抛错。
export function parseKey(s) {
  if (typeof s !== 'string' || s.trim().length === 0) throw new Error('密钥为空');
  const str = s.trim();
  if (/^[0-9a-fA-F]{64}$/.test(str)) return Buffer.from(str, 'hex');
  const buf = Buffer.from(str, 'base64');
  if (buf.length === 32 && buf.toString('base64').replace(/=+$/, '') === str.replace(/=+$/, '')) {
    return buf;
  }
  throw new Error('CLIPWARP_KEY 必须是 64 位 hex 或 32 字节 base64');
}

function loadMasterKey({ home, env }) {
  if (env.CLIPWARP_KEY) return { key: parseKey(env.CLIPWARP_KEY), keySource: 'env' };
  const keyPath = path.join(home, 'master.key');
  let text = null;
  try {
    text = fs.readFileSync(keyPath, 'utf8').trim();
  } catch {
    /* 不存在 → 生成 */
  }
  if (text) return { key: parseKey(text), keySource: 'file' };
  const key = crypto.randomBytes(32);
  try {
    // 原子创建：wx = O_CREAT|O_EXCL，创建即 0o600，消除 write→chmod 的 TOCTOU 窗口。
    fs.writeFileSync(keyPath, key.toString('hex'), { mode: 0o600, flag: 'wx' });
    return { key, keySource: 'generated' };
  } catch (err) {
    if (err.code === 'EEXIST') {
      // 并发启动竞态：另一个进程已写入 → 读它的密钥，不覆盖。
      return { key: parseKey(fs.readFileSync(keyPath, 'utf8').trim()), keySource: 'file' };
    }
    throw err;
  }
}

export function createCrypto({ home, env = process.env }) {
  const { key, keySource } = loadMasterKey({ home, env });

  function encrypt(plaintext) {
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
  }

  // 拆 enc:v1: 串为 {iv, tag, ct}，长度不足 / 无前缀返回 null。
  function parseBlob(stored) {
    if (typeof stored !== 'string' || !stored.startsWith(PREFIX)) return null;
    const buf = Buffer.from(stored.slice(PREFIX.length), 'base64');
    if (buf.length < MIN_BLOB) return null;
    return {
      iv: buf.subarray(0, IV_LEN),
      tag: buf.subarray(IV_LEN, IV_LEN + TAG_LEN),
      ct: buf.subarray(IV_LEN + TAG_LEN),
    };
  }

  function classify(stored) {
    const blob = parseBlob(stored);
    if (!blob) return 'plaintext';
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', key, blob.iv);
      d.setAuthTag(blob.tag);
      d.update(blob.ct);
      d.final(); // 触发 GCM 认证；失败抛错
      return 'cipher-valid';
    } catch {
      return 'cipher-undecryptable';
    }
  }

  function decrypt(stored) {
    const blob = parseBlob(stored);
    if (!blob) return stored; // 旧明文 / 像前缀的短文本
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', key, blob.iv);
      d.setAuthTag(blob.tag);
      return Buffer.concat([d.update(blob.ct), d.final()]).toString('utf8');
    } catch {
      return stored; // cipher-undecryptable：原样返回，永不抛
    }
  }

  return { encrypt, decrypt, classify, keySource };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ~/github/ClipWarp/server && node --test test/crypto.test.js`
Expected: PASS（全部 7 个 test）

- [ ] **Step 5: 提交**

```bash
cd ~/github/ClipWarp && git add server/src/crypto.js server/test/crypto.test.js && git commit -m "$(cat <<'EOF'
feat(m4): 加密内核 crypto.js（AES-256-GCM，GCM 验证为权威判据，decrypt 全函数）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: 一次性加密迁移 migrate-encrypt.js

**Files:**
- Create: `server/src/migrate-encrypt.js`
- Test: `server/test/migrate-encrypt.test.js`

**Interfaces:**
- Consumes: `createCrypto`（Task 1）、`openDb`（`server/src/db.js`，已存在 `openDb(dbFile)→db`）
- Produces: `encryptExistingClips({ db, crypto, dbFile }) → { scanned: number, encrypted: number, backupPath: string|null }`（密钥自检失败时抛错）

- [ ] **Step 1: 写失败测试 `server/test/migrate-encrypt.test.js`**

```js
// migrate-encrypt 单测：明文加密、幂等、逐字段、密钥自检 fail-fast、像前缀文本、备份。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createCrypto } from '../src/crypto.js';
import { encryptExistingClips } from '../src/migrate-encrypt.js';

const HEX = 'c'.repeat(64);

async function seed() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-mig-'));
  const dbFile = path.join(home, 'clipwarp.db');
  const db = await openDb(dbFile);
  const ins = db.prepare(
    'INSERT INTO clips (account_id, content, content_type, title, created_at) VALUES (?,?,?,?,?)'
  );
  return { home, dbFile, db, ins, crypto: createCrypto({ home, env: { CLIPWARP_KEY: HEX } }) };
}

test('明文行被加密且可还原；统计正确', async () => {
  const { db, dbFile, ins, crypto } = await seed();
  ins.run(1, 'hello world', 'text', '标题A', Date.now());
  ins.run(1, 'second clip', 'text', null, Date.now());
  const r = encryptExistingClips({ db, crypto, dbFile });
  assert.equal(r.scanned, 2);
  assert.equal(r.encrypted, 2);
  const rows = db.prepare('SELECT content, title FROM clips ORDER BY id').all();
  assert.ok(rows[0].content.startsWith('enc:v1:'));
  assert.ok(rows[0].title.startsWith('enc:v1:'));
  assert.equal(crypto.decrypt(rows[0].content), 'hello world');
  assert.equal(crypto.decrypt(rows[0].title), '标题A');
  assert.equal(rows[1].title, null); // NULL 保持 NULL
  assert.ok(fs.existsSync(r.backupPath)); // 自动备份
});

test('幂等：二次运行 encrypted=0，不重复备份', async () => {
  const { db, dbFile, ins, crypto } = await seed();
  ins.run(1, 'abc', 'text', null, Date.now());
  const r1 = encryptExistingClips({ db, crypto, dbFile });
  assert.equal(r1.encrypted, 1);
  const r2 = encryptExistingClips({ db, crypto, dbFile });
  assert.equal(r2.encrypted, 0);
  assert.equal(r2.backupPath, null);
});

test('逐字段独立：content 已密 + title 明文 → content 不变、title 加密、不二次加密', async () => {
  const { db, dbFile, ins, crypto } = await seed();
  const encContent = crypto.encrypt('already encrypted');
  ins.run(1, encContent, 'text', 'plain title', Date.now());
  const r = encryptExistingClips({ db, crypto, dbFile });
  assert.equal(r.encrypted, 1);
  const row = db.prepare('SELECT content, title FROM clips').get();
  assert.equal(row.content, encContent); // 原样，未二次加密
  assert.equal(crypto.decrypt(row.content), 'already encrypted');
  assert.equal(crypto.decrypt(row.title), 'plain title');
});

test('密钥自检：存在 cipher-undecryptable 行 → 抛错中止（不损坏数据）', async () => {
  const { db, dbFile, ins, home } = await seed();
  const cryptoA = createCrypto({ home, env: { CLIPWARP_KEY: HEX } });
  ins.run(1, cryptoA.encrypt('owned by A'), 'text', null, Date.now());
  const cryptoB = createCrypto({ home, env: { CLIPWARP_KEY: 'd'.repeat(64) } });
  assert.throws(() => encryptExistingClips({ db, crypto: cryptoB, dbFile }), /不匹配/);
  // 未被改写：内容仍是 A 的密文
  const row = db.prepare('SELECT content FROM clips').get();
  assert.equal(cryptoA.decrypt(row.content), 'owned by A');
});

test('像前缀的明文 enc:v1:hello 经迁移正确还原', async () => {
  const { db, dbFile, ins, crypto } = await seed();
  ins.run(1, 'enc:v1:hello', 'text', null, Date.now());
  encryptExistingClips({ db, crypto, dbFile });
  const row = db.prepare('SELECT content FROM clips').get();
  assert.ok(row.content.startsWith('enc:v1:'));
  assert.equal(crypto.decrypt(row.content), 'enc:v1:hello');
});

test('空串 content/title 往返且与 NULL 区分', async () => {
  const { db, dbFile, ins, crypto } = await seed();
  ins.run(1, '', 'text', '', Date.now());
  encryptExistingClips({ db, crypto, dbFile });
  const row = db.prepare('SELECT content, title FROM clips').get();
  assert.equal(crypto.decrypt(row.content), '');
  assert.equal(crypto.decrypt(row.title), '');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ~/github/ClipWarp/server && node --test test/migrate-encrypt.test.js`
Expected: FAIL（`Cannot find module '../src/migrate-encrypt.js'`）

- [ ] **Step 3: 实现 `server/src/migrate-encrypt.js`**

```js
// 启动一次性加密迁移：把存量明文 content/title 就地加密回写。
// 前置密钥自检（出现 cipher-undecryptable 即 fail-fast，防错密钥二次加密）+ 加密前自动备份。
// 逐字段独立判断，绝不二次加密已是 cipher-valid 的字段。幂等。
import fs from 'node:fs';

export function encryptExistingClips({ db, crypto, dbFile }) {
  const rows = db.prepare('SELECT id, content, title FROM clips').all();

  const work = [];
  for (const row of rows) {
    const cClass = crypto.classify(row.content);
    const tClass = row.title == null ? 'plaintext' : crypto.classify(row.title);
    // 密钥自检：像真密文却解不开 = 错密钥/损坏 → 中止，绝不加密（否则会把旧密文再裹一层）。
    if (cClass === 'cipher-undecryptable' || tClass === 'cipher-undecryptable') {
      throw new Error(
        '主密钥与现有数据不匹配（请核对 CLIPWARP_KEY / master.key），已停止以避免数据损坏'
      );
    }
    const needContent = cClass === 'plaintext';
    const needTitle = row.title != null && tClass === 'plaintext';
    if (needContent || needTitle) {
      work.push({
        id: row.id,
        content: needContent ? crypto.encrypt(row.content) : row.content,
        title: row.title == null ? null : needTitle ? crypto.encrypt(row.title) : row.title,
      });
    }
  }

  let backupPath = null;
  if (work.length > 0 && dbFile) {
    backupPath = dbFile + '.pre-m4.bak';
    if (!fs.existsSync(backupPath)) fs.copyFileSync(dbFile, backupPath); // 加密前备份，迁移不可逆
  }

  if (work.length > 0) {
    db.exec('BEGIN'); // 显式事务，兼容 better-sqlite3 与 node:sqlite 两驱动
    try {
      const upd = db.prepare('UPDATE clips SET content = ?, title = ? WHERE id = ?');
      for (const w of work) upd.run(w.content, w.title, w.id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  return { scanned: rows.length, encrypted: work.length, backupPath };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ~/github/ClipWarp/server && node --test test/migrate-encrypt.test.js`
Expected: PASS（6 个 test）

- [ ] **Step 5: 提交**

```bash
cd ~/github/ClipWarp && git add server/src/migrate-encrypt.js server/test/migrate-encrypt.test.js && git commit -m "$(cat <<'EOF'
feat(m4): 一次性加密迁移 migrate-encrypt（密钥自检 + 自动备份 + 逐字段幂等）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: 装配加密到 server + clip 读写

把 crypto 接入 `createServer`（含 `opts.cryptoKey` 注入与启动迁移 fail-fast），并让 clip 路由写入加密、读出解密、自动标题加密。这是端到端「clip 静态加密」的可验收交付。

**Files:**
- Modify: `server/index.js`
- Modify: `server/src/routes-clips.js`
- Test: `server/test/m4.test.js`（本任务先建并加加解密用例；搜索/广播用例在 Task 4/5 追加）

**Interfaces:**
- Consumes: `createCrypto`（Task 1）、`encryptExistingClips`（Task 2）
- Produces:
  - `createServer(opts)` 新增 `opts.cryptoKey?: string`；返回对象不变（仍含 `db`、`hub`）
  - `registerClipRoutes(app, { db, hub, authHook, llm, crypto })`（新增 `crypto`）
  - `makeToClip(crypto) → (row) → clipObject`（content/title 解密）

- [ ] **Step 1: 写失败测试 `server/test/m4.test.js`（加解密部分）**

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ~/github/ClipWarp/server && node --test test/m4.test.js`
Expected: FAIL（落盘仍是明文 / `crypto is not defined` 等）

- [ ] **Step 3a: 改 `server/src/routes-clips.js` —— toClip 闭包 + 加密写入 + 自动标题**

把模块级 `toClip` 改为工厂 `makeToClip(crypto)`：

```js
// 替换原 function toClip(row) {...}
function makeToClip(crypto) {
  return function toClip(row) {
    return {
      id: row.id,
      content: crypto.decrypt(row.content),
      contentType: row.content_type,
      title: row.title == null ? null : crypto.decrypt(row.title),
      isPinned: !!row.is_pinned,
      isSensitive: !!row.is_sensitive,
      burnAfterRead: !!row.burn_after_read,
      deviceLabel: row.device_label,
      createdAt: row.created_at,
      expiresAt: row.expires_at ?? null,
    };
  };
}
```

`scheduleAutoTitle` 新增 `crypto`、`toClip` 入参，并加密 title：

```js
function scheduleAutoTitle({ db, hub, llm, crypto, toClip, accountId, clipId, content }) {
  (async () => {
    const title = await llm.generateTitle(content);
    if (!title) return;
    const info = db
      .prepare('UPDATE clips SET title = ? WHERE id = ? AND account_id = ? AND title IS NULL')
      .run(crypto.encrypt(title), clipId, accountId); // 加密落库
    if (!info.changes) return;
    const row = db.prepare('SELECT * FROM clips WHERE id = ? AND account_id = ?').get(clipId, accountId);
    if (row) hub.broadcast(accountId, { type: 'clip:updated', clip: toClip(row) });
  })().catch(() => {});
}
```

`registerClipRoutes` 签名加 `crypto`，函数体顶部建闭包 `toClip`：

```js
export default function registerClipRoutes(app, { db, hub, authHook, llm, crypto }) {
  const toClip = makeToClip(crypto);
  // ...（下方 list / search / post / delete / pin 路由内的 toClip 引用此闭包）
```

POST 路由：元数据在明文上算，再加密写入：

```js
    const contentType = detectContentType(content);
    const isSensitive = detectSecret(content) ? 1 : 0;
    const info = db
      .prepare(
        'INSERT INTO clips (account_id, content, content_type, is_sensitive, burn_after_read, device_label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        accountId,
        crypto.encrypt(content), // 落盘密文（元数据已在明文上算完）
        contentType,
        isSensitive,
        burnAfterRead ? 1 : 0,
        req.session.device_label ?? null,
        Date.now(),
        expiresAt
      );
```

POST 末尾自动标题调用补 `crypto`、`toClip`：

```js
    if (llm?.enabled && !isSensitive) {
      scheduleAutoTitle({ db, hub, llm, crypto, toClip, accountId, clipId: clip.id, content });
    }
```

> 注：本任务暂不动 `/api/clips/search`（Task 4 重写）；其当前 `LIKE content` 对密文失效会在 Task 4 修复并补测，先保证 list/post/pin/delete 路径加解密正确。

- [ ] **Step 3b: 改 `server/index.js` —— 装配 crypto + 启动迁移**

顶部加导入：

```js
import { createCrypto } from './src/crypto.js';
import { encryptExistingClips } from './src/migrate-encrypt.js';
```

`createServer` 内，`openDb` 之后、注册路由之前插入（在 `bootstrapAdmin` 之后即可）：

```js
  // 静态加密：装配主密钥；opts.cryptoKey（测试用）经 env 注入，绝不改 process.env。
  const cryptoBox = createCrypto({
    home: cfg.home,
    env: opts.cryptoKey ? { ...process.env, CLIPWARP_KEY: opts.cryptoKey } : process.env,
  });
  // 启动一次性加密迁移：失败（含密钥自检）即抛错阻断启动（数据完整性不可带病运行）。
  const migrateStats = encryptExistingClips({ db, crypto: cryptoBox, dbFile: cfg.dbFile });
```

clip 路由注册补 `crypto`：

```js
  registerClipRoutes(app, { db, hub, authHook, llm, crypto: cryptoBox });
```

`createServer` 返回对象补两个字段（供直接运行日志与测试断言，可选）：

```js
  return {
    app, db, hub, sweeper, config: cfg,
    keySource: cryptoBox.keySource,
    migrateStats,
    async listen() { /* 不变 */ },
    async close() { /* 不变 */ },
  };
```

直接运行分支补日志（在 `console.log data` 行后）：

```js
  console.log(`[clipwarp] 主密钥来源: ${srv.keySource}`);
  console.log(
    `[clipwarp] 加密迁移：扫描 ${srv.migrateStats.scanned}，加密 ${srv.migrateStats.encrypted}` +
      `${srv.migrateStats.backupPath ? '，备份 ' + srv.migrateStats.backupPath : ''}`
  );
```

- [ ] **Step 4: 跑 m4 + 全量回归确认通过**

Run: `cd ~/github/ClipWarp/server && node --test 'test/*.test.js'`
Expected: PASS。本任务 m4 的 4 个加解密用例通过；现有 62 个回归全绿（list/post/pin/delete/PAT/自动标题等路径加解密透明）。**搜索用例此时仍是 M3 旧版（LIKE），会因密文失配——若 m3.test.js 搜索用例失败属预期，Task 4 修复**。

> 实现者注意：若 m3 搜索用例在本任务红，先确认仅搜索相关，其余全绿，再进 Task 4；不要在本任务改搜索逻辑。

- [ ] **Step 5: 提交**

```bash
cd ~/github/ClipWarp && git add server/index.js server/src/routes-clips.js server/test/m4.test.js && git commit -m "$(cat <<'EOF'
feat(m4): clip 静态加密落盘——写入加密/读出解密/自动标题加密 + 启动迁移装配

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 搜索改内存解密过滤（覆盖全部 pinned）

**Files:**
- Modify: `server/src/routes-clips.js`（`/api/clips/search` 路由 + 删除 `escapeLike`）
- Test: `server/test/m4.test.js`（追加搜索用例）

**Interfaces:**
- Consumes: `makeToClip(crypto)`（Task 3，本路由复用闭包 `toClip`）
- Produces: `/api/clips/search?q=&limit=` 行为：account 隔离 + 过滤过期 + **全部 pinned 可搜** + Unicode 小写子串匹配

- [ ] **Step 1: 追加失败测试到 `server/test/m4.test.js`**

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ~/github/ClipWarp/server && node --test test/m4.test.js`
Expected: FAIL（搜索 `LIKE` 对密文不命中 → 命中数为 0）

- [ ] **Step 3: 重写 `/api/clips/search` 为内存过滤**

删除模块级 `escapeLike` 函数（不再需要），新增搜索上限常量（与其它常量并列）：

```js
const SEARCH_CAP = 5000; // 候选行内存解密上限（保护内存；个人量级远不及，命中则告警）
```

把整个 `app.get('/api/clips/search', ...)` 处理体替换为：

```js
  app.get('/api/clips/search', { preHandler: authHook }, async (req, reply) => {
    const accountId = req.account.id;
    const q = typeof req.query?.q === 'string' ? req.query.q.trim() : '';
    if (!q) {
      return reply.code(400).send({ error: 'empty_query', message: '搜索词不能为空' });
    }
    let limit = Number.parseInt(req.query?.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
    if (limit > MAX_LIMIT) limit = MAX_LIMIT;

    // 候选集：该账号全部未过期 clip（含全部 pinned）。content 落盘为密文，无法 SQL LIKE，
    // 故拉行后内存解密再子串匹配。未 pin 本就裁剪到 500，pinned 个人量级有限；CAP 仅内存保护。
    const rows = db
      .prepare(
        'SELECT * FROM clips WHERE account_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY id DESC LIMIT ?'
      )
      .all(accountId, Date.now(), SEARCH_CAP);
    if (rows.length === SEARCH_CAP) {
      app.log?.warn?.(`[clipwarp] 搜索候选触达上限 ${SEARCH_CAP}（account ${accountId}），超出部分未参与匹配`);
    }

    const needle = q.toLowerCase(); // Unicode 感知小写：对非 ASCII 字母大小写不敏感（M3 ASCII-only 的轻微超集）
    const hits = [];
    for (const row of rows) {
      const clip = toClip(row); // 解密 content/title（全函数，坏行原样不抛）
      const inContent = clip.content.toLowerCase().includes(needle);
      const inTitle = clip.title != null && clip.title.toLowerCase().includes(needle);
      if (inContent || inTitle) {
        hits.push(clip);
        if (hits.length >= limit) break;
      }
    }
    return { clips: hits };
  });
```

- [ ] **Step 4: 跑 m4 + 回归确认通过**

Run: `cd ~/github/ClipWarp/server && node --test 'test/*.test.js'`
Expected: PASS。新搜索用例通过；m3.test.js 的搜索用例——`'%' 按字面匹配` 仍成立（`includes` 字面匹配，`a%b` 只命中含 `a%b` 的那条）。全量回归全绿。

> 注：m3 搜索用例里 `q=alpha` 命中 1 条、`a%b` 字面命中 1 条，新实现均满足（`includes` 本就字面、不解释通配符）。

- [ ] **Step 5: 提交**

```bash
cd ~/github/ClipWarp && git add server/src/routes-clips.js server/test/m4.test.js && git commit -m "$(cat <<'EOF'
feat(m4): 搜索改内存解密过滤——覆盖全部 pinned，删 escapeLike，Unicode 大小写不敏感

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: 平滑升级广播（wshub + shutdown）

**Files:**
- Modify: `server/src/wshub.js`（导出 `broadcastAll`）
- Modify: `server/index.js`（直接运行分支 `shutdown` 加重入守卫 + broadcastAll + drain）
- Test: `server/test/m4.test.js`（追加广播用例）

**Interfaces:**
- Produces: `hub.broadcastAll(payload)` —— 向所有房间所有 OPEN 连接发同一帧

- [ ] **Step 1: 追加失败测试到 `server/test/m4.test.js`**

```js
test('broadcastAll：向所有在线连接广播 sys/upgrading', async () => {
  const ctx = await startServer({ cryptoKey: KEY });
  const { WebSocket } = await import('ws');
  try {
    const { cookie } = await login(ctx.base, 'admin', ctx.adminPassword);
    const wsUrl = ctx.base.replace('http', 'ws') + '/ws';
    const ws = new WebSocket(wsUrl, { headers: { cookie } });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    const got = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 3000);
      ws.on('message', (buf) => {
        const msg = JSON.parse(buf.toString());
        if (msg.type === 'sys' && msg.kind === 'upgrading') { clearTimeout(timer); resolve(msg); }
      });
    });
    ctx.srv.hub.broadcastAll({ type: 'sys', kind: 'upgrading' });
    const msg = await got;
    assert.equal(msg.kind, 'upgrading');
    ws.close();
  } finally {
    await ctx.cleanup();
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ~/github/ClipWarp/server && node --test test/m4.test.js`
Expected: FAIL（`hub.broadcastAll is not a function`）

- [ ] **Step 3a: 改 `server/src/wshub.js` —— 加 broadcastAll**

在 `broadcast` 函数之后新增：

```js
  // 向所有账号房间的所有 OPEN 连接广播同一帧（升级公告等全局通知）。
  function broadcastAll(payload) {
    const text = JSON.stringify(payload);
    for (const room of rooms.values()) {
      for (const ws of room) {
        if (ws.readyState === ws.OPEN) ws.send(text);
      }
    }
  }
```

返回对象补 `broadcastAll`：

```js
  return { broadcast, broadcastAll, devices, closeAccount, close };
```

- [ ] **Step 3b: 改 `server/index.js` —— shutdown 平滑广播**

把直接运行分支的 `shutdown` 替换为（含重入守卫 + 广播 + drain）：

```js
  let closing = false;
  const shutdown = async (sig) => {
    if (closing) return; // 重入守卫：二次 SIGTERM 不重复广播/关闭
    closing = true;
    console.log(`[clipwarp] ${sig}，正在退出…`);
    try {
      srv.hub.broadcastAll({ type: 'sys', kind: 'upgrading' }); // 先告知在线设备「升级中」
    } catch {
      /* 广播失败不阻断退出 */
    }
    const drainMs = Number(process.env.CLIPWARP_SHUTDOWN_DRAIN_MS) > 0
      ? Number(process.env.CLIPWARP_SHUTDOWN_DRAIN_MS)
      : 400;
    await new Promise((r) => setTimeout(r, drainMs)); // 留窗口让帧发出
    await srv.close(); // 触发 onClose：sweeper.stop + hub.close + db.close
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
```

- [ ] **Step 4: 跑 m4 + 回归确认通过**

Run: `cd ~/github/ClipWarp/server && node --test 'test/*.test.js'`
Expected: PASS（broadcastAll 用例通过；现有 ws.test.js 等全绿）

- [ ] **Step 5: 提交**

```bash
cd ~/github/ClipWarp && git add server/src/wshub.js server/index.js server/test/m4.test.js && git commit -m "$(cat <<'EOF'
feat(m4): 平滑升级广播——wshub.broadcastAll + 关停先播 upgrading 再 drain（重入守卫）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: 前端升级横幅（Board.jsx）

**Files:**
- Modify: `web/src/components/Board.jsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes: `WSClient`（`web/src/ws.js`，已透传 `onOpen(isReconnect)` 与 `sys` 消息，**ws.js 不改**）

- [ ] **Step 1: 改 `web/src/components/Board.jsx` —— 升级/重连状态**

在 `const [wsOnline, setWsOnline] = useState(false);` 附近新增状态与 ref（`useRef` 已在第 1 行 import）：

```js
  const [upgrading, setUpgrading] = useState(false);
  const everConnected = useRef(false);
```

`onMessage` 的 `switch` 增 `sys` 分支（在 `default` 前）：

```js
          case 'sys':
            if (msg.kind === 'upgrading') setUpgrading(true);
            break;
```

`onOpen` 改为接收 `isReconnect` 并清 `upgrading`：

```js
      onOpen: (isReconnect) => {
        everConnected.current = true;
        setWsOnline(true);
        setUpgrading(false); // 重连成功，撤掉升级/断连横幅
        loadClips();
        void isReconnect; // 当前无需区分首连/重连，保留参数语义
      },
```

在 `return (<div className="board">` 之后、`<header>` 之前插入横幅：

```jsx
      {(upgrading || (everConnected.current && !wsOnline)) && (
        <div className="conn-banner">
          {upgrading ? '服务升级中，稍候自动重连…' : '连接已断开，正在重连…'}
        </div>
      )}
```

- [ ] **Step 2: 改 `web/src/styles.css` —— 横幅样式**

追加：

```css
/* 升级/重连提示：顶部琥珀细横幅，不盖遮罩、不阻断浏览。 */
.conn-banner {
  position: sticky;
  top: 0;
  z-index: 50;
  padding: 6px 12px;
  font-size: 13px;
  text-align: center;
  color: #7a4f01;
  background: rgba(255, 196, 0, 0.92);
  border-bottom: 1px solid rgba(122, 79, 1, 0.25);
}
```

- [ ] **Step 3: 构建验证**

Run: `cd ~/github/ClipWarp/web && npm run build`
Expected: 构建成功，无报错（本项目 web 无单测，以构建通过为门槛）。

> 手动验收（部署后）：服务重启时在线页面顶部出现琥珀「服务升级中…」横幅，重连成功后消失；纯断网时显示「连接已断开，正在重连…」。

- [ ] **Step 4: 提交**

```bash
cd ~/github/ClipWarp && git add web/src/components/Board.jsx web/src/styles.css && git commit -m "$(cat <<'EOF'
feat(m4): 前端升级/重连横幅（Board.jsx，收 sys/upgrading + onOpen isReconnect）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: 运维加固 + 发版 v1.0.0

**Files:**
- Modify: `.gitignore`、`scripts/deploy-launchd.sh`
- Modify: `server/package.json`、`web/package.json`、`mcp/package.json`
- Modify: `CHANGELOG.md`、`README.md`、`docs/design.md`、`docs/api.md`

- [ ] **Step 1: `.gitignore` 加密钥防护**

在文件末尾追加：

```
master.key
*.key
```

- [ ] **Step 2: `scripts/deploy-launchd.sh` 健康检查改重试循环**

定位重启后那段 `sleep 2` + 单次 `curl .../api/health`，替换为重试循环（容忍升级后首启迁移变慢）：

```bash
# 健康检查：重试 ~15s，容忍升级后首启的一次性加密迁移耗时
ok=0
for i in $(seq 1 10); do
  if curl -fsS "http://127.0.0.1:${PORT:-2547}/api/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1.5
done
if [ "$ok" != "1" ]; then
  echo "健康检查失败：服务未在预期时间内就绪" >&2
  # （保留原有 tail 日志逻辑）
  exit 1
fi
```

> 实现者：以仓库现有变量名（端口、日志路径）为准微调；仅把「单次检查」改为「重试循环」，不改其它部署逻辑。

- [ ] **Step 3: 三个 package.json 版本 0.3.0 → 1.0.0**

`server/package.json`、`web/package.json`、`mcp/package.json` 各自 `"version": "0.3.0"` 改为 `"version": "1.0.0"`。

- [ ] **Step 4: `CHANGELOG.md` 切 [1.0.0] 段并加 M4**

把 `## [Unreleased]` 改为 `## [1.0.0] - 2026-06-18`，并在其**正下方、M3 段之上**插入 M4 段：

```markdown
### M4 · v1.0.0 加固发布
- 静态加密（at-rest）：clip `content`/`title` 以 AES-256-GCM 落盘（每条随机 IV + 认证标签），服务端仍读明文，secret 检测/自动标题/搜索全部保留
- 主密钥：首启自动生成 `~/.config/clipwarp/master.key`（chmod 600，与 `data/` 分目录便于分开备份）；`CLIPWARP_KEY`（64-hex 或 32 字节 base64）可注入覆盖
- 一次性迁移：升级首启把存量明文就地加密；前置密钥自检（错密钥直接 fail-fast 不损坏数据）+ 自动备份 `clipwarp.db.pre-m4.bak`
- 搜索：改内存解密过滤（覆盖全部 pinned，Unicode 大小写不敏感）
- 平滑升级广播：关停先向在线设备广播「升级中」，前端切琥珀重连横幅，骑指数退避重连穿过 bind 间隙
- ⚠️ 升级不可平滑回退：迁移后旧版本无法解密；升级前请备份 `clipwarp.db` 与 `master.key`（迁移亦自动产 `*.pre-m4.bak`）
- 测试：服务端全绿（新增 crypto / 迁移 / m4 端到端 ~25 用例）
```

- [ ] **Step 5: `README.md` + 文档**

- `README.md`：版本徽章/标注改 v1.0.0；新增「加密与密钥」小节，说明 `master.key` 保管、`CLIPWARP_KEY` 注入、与数据分目录、升级前备份、不可回退。
- `docs/design.md`：Roadmap 表把 M4 行标 ✅，并在「安全」节补一句 at-rest 加密落地（AES-256-GCM + master.key + 启动迁移）。
- `docs/api.md`：`/api/clips/search` 注明服务端内存过滤、字面子串、Unicode 大小写不敏感。

- [ ] **Step 6: 全量测试 + 构建 + 提交**

Run: `cd ~/github/ClipWarp/server && node --test 'test/*.test.js'` → 全绿
Run: `cd ~/github/ClipWarp/web && npm run build` → 成功
Run: `cd ~/github/ClipWarp && git status` → 确认 `master.key` 不在待提交列表（被 .gitignore）

```bash
cd ~/github/ClipWarp && git add .gitignore scripts/deploy-launchd.sh server/package.json web/package.json mcp/package.json CHANGELOG.md README.md docs/design.md docs/api.md && git commit -m "$(cat <<'EOF'
chore(release): ClipWarp v1.0.0 —— 静态加密发版 + 运维加固

.gitignore 防提交 master.key；部署健康检查重试；版本 0.3.0→1.0.0；
CHANGELOG/README/design/api 记录 M4。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7: 验收自检（对照 spec §13）**

- [ ] 全新库 + M3 旧库（含数据）均能启动；旧库存量自动加密、内容不丢、产 `*.pre-m4.bak`
- [ ] `sqlite3 <db> 'SELECT content FROM clips LIMIT 5'` 全为 `enc:v1:` 前缀
- [ ] Web/MCP 读取、搜索（pinned 全覆盖）、自动标题、burn/TTL 与 M3 一致
- [ ] 删除 `master.key` 后无法解密；误设错 `CLIPWARP_KEY` 启动 fail-fast
- [ ] 单条损坏行不影响其余列表/搜索
- [ ] 服务端测试全绿，`web` 构建通过

---

## Self-Review（写计划后自检）

**Spec 覆盖：**
- §4 加密内核 → Task 1 ✓；§5 迁移 → Task 2 + Task 3（装配）✓；§6 路由读写 → Task 3，搜索 → Task 4 ✓；§7 升级广播 → Task 5（服务端）+ Task 6（前端）✓；§8 配置（cryptoKey/master.key 路径/drain）→ Task 3 + Task 5 ✓；§9 测试 → 各任务 TDD + Task 3/4/5 的 m4.test.js ✓；§10 发版 → Task 7 ✓；§11 文件清单 → 全覆盖 ✓；§12 风险（密钥自检/全函数 decrypt/备份/gitignore/重入）→ Task 2/3/5/7 ✓。
- 无遗漏 spec 要求。

**占位符扫描：** 无 TBD/TODO；每个代码步给出完整实现。部署脚本第 2 步注明「以现有变量名微调」属合理本地适配，非占位。

**类型/命名一致性：** `makeToClip(crypto)`/`toClip`、`createCrypto({home,env})→{encrypt,decrypt,classify,keySource}`、`encryptExistingClips({db,crypto,dbFile})→{scanned,encrypted,backupPath}`、`hub.broadcastAll(payload)`、`scheduleAutoTitle({db,hub,llm,crypto,toClip,accountId,clipId,content})`、`opts.cryptoKey`、`PREFIX='enc:v1:'`/`MIN_BLOB=28`/`SEARCH_CAP=5000`/`CLIPWARP_SHUTDOWN_DRAIN_MS` —— 跨任务一致。
