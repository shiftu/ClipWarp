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
