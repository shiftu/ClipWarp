// ClipWarp 服务端入口（M1）。
// createServer({ home, port, host }) 为可测试工厂：port 0 = 随机端口，home 可指向临时目录。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';

import { resolveConfig } from './src/config.js';
import { openDb } from './src/db.js';
import { bootstrapAdmin } from './src/accounts.js';
import { makeAuthHook } from './src/sessions.js';
import { createWsHub } from './src/wshub.js';
import { createSweeper } from './src/sweeper.js';
import { createLlmClient } from './src/llm.js';
import { createCrypto } from './src/crypto.js';
import { encryptExistingClips } from './src/migrate-encrypt.js';
import registerAuthRoutes from './src/routes-auth.js';
import registerClipRoutes from './src/routes-clips.js';
import registerAdminRoutes from './src/routes-admin.js';
import registerTokenRoutes from './src/routes-tokens.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const WEB_DIST = path.resolve(__dirname, '..', 'web', 'dist');

export async function createServer(opts = {}) {
  const cfg = resolveConfig(opts);
  const db = await openDb(cfg.dbFile);
  bootstrapAdmin(db, cfg.home);

  const app = Fastify({
    logger: opts.logger ?? false, // 默认静默；即使开启也不会记录请求体（不打印 clip 内容与密码）
    bodyLimit: 2 * 1024 * 1024, // 大于 1MB 业务上限，让 content_too_large 的 400 先于 413 生效
    // 默认 false：直连时不信任 X-Forwarded-For，防客户端伪造 IP 绕过登录限速。反代部署设 TRUST_PROXY。
    trustProxy: cfg.trustProxy,
  });

  // 统一错误响应为 {error,message}，与业务契约一致（覆盖框架级 413/400 JSON 解析错误等）。
  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    let code = 'internal_error';
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || status === 413) code = 'content_too_large';
    else if (err.code === 'FST_ERR_CTP_INVALID_JSON_SYNTAX') code = 'invalid_json';
    else if (status === 400) code = 'bad_request';
    else if (status === 401) code = 'unauthorized';
    else if (status === 403) code = 'forbidden';
    else if (status === 404) code = 'not_found';
    else if (status < 500) code = 'bad_request';
    if (status >= 500 && app.log?.error) app.log.error(err);
    const message = status >= 500 ? '服务器内部错误' : err.message || '请求错误';
    reply.code(status).send({ error: code, message });
  });

  await app.register(fastifyCookie);

  const authHook = makeAuthHook(db);
  // wsHeartbeatMs 可注入（测试用短间隔验证 session 吊销断连）；默认走 hub 内置 30s。
  const hub = createWsHub({ server: app.server, db, heartbeatMs: opts.wsHeartbeatMs });
  // TTL 清扫器：周期回收过期 clip 并广播删除。sweepIntervalMs 可注入（测试用短间隔）。
  const sweeper = createSweeper({ db, hub, intervalMs: opts.sweepIntervalMs });
  try {
    sweeper.sweep(); // 启动即清一次，回收上次进程退出后已过期的 clip
  } catch {
    /* 启动清扫失败不应阻断服务启动，下一个定时周期会重试 */
  }

  // LLM 网关客户端（自动标题）。未配置 token 时 enabled=false，全程优雅降级。
  const llm = opts.llm ?? createLlmClient();

  // 静态加密：装配主密钥；opts.cryptoKey（测试用）经 env 注入，绝不改 process.env。
  const cryptoBox = createCrypto({
    home: cfg.home,
    env: opts.cryptoKey ? { ...process.env, CLIPWARP_KEY: opts.cryptoKey } : process.env,
  });
  // 启动一次性加密迁移：失败（含密钥自检）即抛错阻断启动（数据完整性不可带病运行）。
  const migrateStats = encryptExistingClips({ db, crypto: cryptoBox, dbFile: cfg.dbFile });

  app.get('/api/health', async () => ({ ok: true, version: pkg.version }));

  registerAuthRoutes(app, { db, authHook, secureCookie: cfg.secureCookie });
  registerClipRoutes(app, { db, hub, authHook, llm, crypto: cryptoBox });
  registerAdminRoutes(app, { db, hub, authHook });
  registerTokenRoutes(app, { db, authHook });

  // 生产静态托管：web/dist 存在才挂载；SPA fallback 不拦截 /api/* 与 /ws
  const hasWebDist = fs.existsSync(path.join(WEB_DIST, 'index.html'));
  if (hasWebDist) {
    await app.register(fastifyStatic, { root: WEB_DIST, index: ['index.html'] });
  }
  app.setNotFoundHandler((req, reply) => {
    const url = req.raw.url || '';
    if (url === '/ws' || url.startsWith('/ws?') || url.startsWith('/api/') || url === '/api') {
      return reply.code(404).send({ error: 'not_found', message: '接口不存在' });
    }
    if (hasWebDist && (req.method === 'GET' || req.method === 'HEAD')) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not_found', message: '资源不存在' });
  });

  app.addHook('onClose', async () => {
    sweeper.stop();
    hub.close();
    try {
      db.close();
    } catch {
      /* noop */
    }
  });

  return {
    app,
    db,
    hub,
    sweeper,
    config: cfg,
    keySource: cryptoBox.keySource,
    migrateStats,
    /** 启动监听；port 0 时返回实际随机端口。 */
    async listen() {
      await app.listen({ port: cfg.port, host: opts.host || cfg.host });
      return { port: app.server.address().port };
    },
    async close() {
      await app.close();
    },
  };
}

// 直接运行时（node index.js）按环境变量启动
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // 仅记录 warn 及以上：保留错误，避免逐请求 info 日志把 launchd 日志文件无限撑大。
  const srv = await createServer({ logger: { level: 'warn' } });
  const { port } = await srv.listen();
  console.log(`[clipwarp] v${pkg.version} listening on ${srv.config.host}:${port}`);
  console.log(`[clipwarp] data: ${srv.config.dbFile}`);
  console.log(`[clipwarp] 主密钥来源: ${srv.keySource}`);
  console.log(
    `[clipwarp] 加密迁移：扫描 ${srv.migrateStats.scanned}，加密 ${srv.migrateStats.encrypted}` +
      `${srv.migrateStats.backupPath ? '，备份 ' + srv.migrateStats.backupPath : ''}`
  );

  const shutdown = async (sig) => {
    console.log(`[clipwarp] ${sig}，正在退出…`);
    await srv.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
