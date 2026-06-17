// 个人访问令牌（PAT）管理路由。全部按 account 隔离。
// 仅允许 cookie 会话操作（authVia==='cookie'）——禁止用 PAT 再签发/吊销 PAT，避免令牌自我增殖与提权。
import { createApiToken, listApiTokens, deleteApiToken } from './api-tokens.js';

function requireCookie(req, reply) {
  if (req.authVia !== 'cookie') {
    reply.code(403).send({ error: 'forbidden', message: '令牌管理需登录后操作' });
    return false;
  }
  return true;
}

export default function registerTokenRoutes(app, { db, authHook }) {
  app.get('/api/tokens', { preHandler: authHook }, async (req, reply) => {
    if (!requireCookie(req, reply)) return;
    return { tokens: listApiTokens(db, req.account.id) };
  });

  app.post('/api/tokens', { preHandler: authHook }, async (req, reply) => {
    if (!requireCookie(req, reply)) return;
    const label = req.body?.label;
    if (label !== undefined && typeof label !== 'string') {
      return reply.code(400).send({ error: 'invalid_label', message: '标签必须是字符串' });
    }
    const { token, row } = createApiToken(db, req.account.id, label);
    // token 明文仅此一次返回
    return reply.code(201).send({ token, ...row });
  });

  app.delete('/api/tokens/:id', { preHandler: authHook }, async (req, reply) => {
    if (!requireCookie(req, reply)) return;
    const id = Number.parseInt(req.params.id, 10);
    const ok = Number.isFinite(id) && deleteApiToken(db, req.account.id, id);
    if (!ok) {
      return reply.code(404).send({ error: 'not_found', message: '令牌不存在' });
    }
    return reply.code(204).send();
  });
}
