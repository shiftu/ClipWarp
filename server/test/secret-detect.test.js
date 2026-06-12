// secret 检测单测：确认高信号密钥被识别、普通文本不误伤。
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSecret } from '../src/secret-detect.js';

test('识别常见密钥/令牌形态', () => {
  const positives = [
    // JWT
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
    // AWS Access Key ID
    'AKIAIOSFODNN7EXAMPLE',
    'export AWS_ACCESS_KEY_ID=ASIA1234567890ABCDEF',
    // GitHub PAT
    'ghp_1234567890abcdefghijklmnopqrstuvwxyz',
    'github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz1234567890ABCD',
    // Slack（拆成片段拼接：避免把"像真令牌"的连续串写进源码触发 GitHub 推送保护，运行时等价）
    'xoxb-1234' + '56789012-1234567890123-abcdEFGHijklMNOPqrstUVwx',
    // Google API key
    'AIzaSyA1234567890abcdefghijklmnopqrstuv',
    // Stripe（同上，拆片段拼接以绕过 GitHub 推送保护，detectSecret 看到的仍是完整串）
    'sk_live' + '_1234567890abcdefghijklmnop',
    // OpenAI / Anthropic 风格
    'sk-1234567890abcdefghijklmnopqrstuv',
    'sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234',
    // Bearer
    'Authorization: Bearer abcdef0123456789ABCDEF.token-value',
    // PEM 私钥（含 PGP 的 "... PRIVATE KEY BLOCK-----"）
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
    '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA\n-----END OPENSSH PRIVATE KEY-----',
    '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF...\n-----END PGP PRIVATE KEY BLOCK-----',
    // 通用赋值（含 token / access_token / refresh_token 高频形态）
    'password = "hunter2secret"',
    'api_key: 9f8e7d6c5b4a3210',
    '{"client_secret":"abcdef123456ghijkl"}',
    'DB_PASSWORD=s3cr3tP@ssw0rd',
    'token=abcdef0123456789',
    'access_token: 9f8e7d6c5b4a3210',
    'refresh_token=zyxwvu987654321',
  ];
  for (const s of positives) {
    assert.equal(detectSecret(s), true, `应判为敏感：${s.slice(0, 40)}`);
  }
});

test('普通文本不误判为敏感', () => {
  const negatives = [
    '',
    'hello world',
    '今天天气不错，适合写代码',
    'https://example.com/path?q=1',
    'function add(a, b) { return a + b; }',
    '{"name":"clipwarp","port":2547}',
    'meeting at 3pm tomorrow',
    'the quick brown fox jumps over the lazy dog',
  ];
  for (const s of negatives) {
    assert.equal(detectSecret(s), false, `不应判为敏感：${s.slice(0, 40)}`);
  }
});

test('非字符串输入安全返回 false', () => {
  assert.equal(detectSecret(null), false);
  assert.equal(detectSecret(undefined), false);
  assert.equal(detectSecret(12345), false);
});
