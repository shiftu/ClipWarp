// 配置解析：数据目录（CLIPWARP_HOME 可覆盖）、端口、监听地址。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PORT = 2547;

// 解析 TRUST_PROXY 环境变量为 fastify trustProxy 可接受的值：
// 未设/false → false；true → true；纯数字 → 信任的跳数；其余原样（IP / CIDR / 'loopback'）。
function parseTrustProxy(raw) {
  if (!raw) return false;
  const v = raw.trim();
  if (/^(false|0|no)$/i.test(v)) return false;
  if (/^(true|yes)$/i.test(v)) return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

export function resolveConfig(opts = {}) {
  const home = path.resolve(
    opts.home || process.env.CLIPWARP_HOME || path.join(os.homedir(), '.config', 'clipwarp')
  );
  const port = opts.port ?? (process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT);
  const host = opts.host || process.env.HOST || '0.0.0.0';
  const dataDir = path.join(home, 'data');
  const dbFile = path.join(dataDir, 'clipwarp.db');

  // trustProxy：默认 false——直连时不信任 X-Forwarded-For，避免客户端伪造 IP 绕过登录限速。
  // 反代部署时设 TRUST_PROXY=loopback（信任本机反代）或具体 IP/CIDR/跳数。
  const trustProxy = opts.trustProxy ?? parseTrustProxy(process.env.TRUST_PROXY);
  // 生产 HTTPS 下置 COOKIE_SECURE=1，给会话 cookie 加 Secure 标志；本地 http 默认关。
  const secureCookie =
    opts.secureCookie ?? /^(1|true|yes)$/i.test(process.env.COOKIE_SECURE || '');

  // 数据目录仅属主可读写（chmod 700）。
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(home, 0o700);
    fs.chmodSync(dataDir, 0o700);
  } catch {
    /* 非关键：某些文件系统不支持 */
  }

  return { home, port, host, dataDir, dbFile, trustProxy, secureCookie };
}
