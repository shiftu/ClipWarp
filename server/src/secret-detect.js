// 确定性 secret 检测（无 LLM，多端一致）：命中即把 clip 标记 is_sensitive=1，前端默认遮罩。
// 偏向召回——这些都是高信号的密钥/令牌形态，误报代价仅是"被遮一下、点一下显示"，不阻断粘贴、不改内容。
const PATTERNS = [
  // PEM 私钥块（RSA/EC/OPENSSH/ENCRYPTED 等，含 PGP 的 "... PRIVATE KEY BLOCK-----"）
  /-----BEGIN(?:[A-Z0-9 ]+)? PRIVATE KEY(?: BLOCK)?-----/,
  // JWT：三段 base64url
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/,
  // AWS Access Key ID
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}\b/,
  // GitHub token：PAT / OAuth / user-to-server / server-to-server / refresh
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
  // Slack token
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  // Google API key
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  // Stripe live/test 密钥
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  // OpenAI / Anthropic 风格密钥
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/,
  // HTTP Bearer 令牌
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/,
  // 通用赋值：password/secret/token/api_key/access_token/refresh_token/... = <非空白且≥6 位>
  /(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?(?:key|token)|api[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|token)["']?\s*[:=]\s*["']?[^\s"',;]{6,}/i,
];

/**
 * 检测文本中是否含疑似密钥/令牌/凭据。纯函数、确定性。
 * @param {string} content
 * @returns {boolean}
 */
export function detectSecret(content) {
  if (typeof content !== 'string' || content.length === 0) return false;
  // 只扫描前 64KB：限制超大文本上的正则开销，且密钥通常在开头。
  const sample = content.length > 65536 ? content.slice(0, 65536) : content;
  for (const re of PATTERNS) {
    if (re.test(sample)) return true;
  }
  return false;
}
