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
