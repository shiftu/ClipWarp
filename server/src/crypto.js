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
