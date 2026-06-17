// Admin 路由：列账号 / 建号 / 删号（级联）/ 重置密码（吊销 session）。
// role != admin → 403 forbidden。
import {
  USERNAME_RE,
  createAccount,
  findById,
  findByUsername,
  hashPassword,
  publicAccount,
} from './accounts.js';
import { deleteSessionsForAccount } from './sessions.js';

export default function registerAdminRoutes(app, { db, hub, authHook }) {
  async function requireAdmin(req, reply) {
    if (req.account.role !== 'admin') {
      return reply.code(403).send({ error: 'forbidden', message: '需要管理员权限' });
    }
  }
  const guards = [authHook, requireAdmin];

  app.get('/api/accounts', { preHandler: guards }, async () => {
    const rows = db
      .prepare(
        `SELECT a.id, a.username, a.role, a.created_at,
                (SELECT COUNT(*) FROM clips c WHERE c.account_id = a.id) AS clip_count
         FROM accounts a ORDER BY a.id ASC`
      )
      .all();
    return {
      accounts: rows.map((r) => ({
        id: r.id,
        username: r.username,
        role: r.role,
        createdAt: r.created_at,
        clipCount: r.clip_count,
      })),
    };
  });

  app.post('/api/accounts', { preHandler: guards }, async (req, reply) => {
    const body = req.body || {};
    const username = body.username;
    const password = body.password;

    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
      return reply
        .code(400)
        .send({ error: 'invalid_username', message: '用户名需为 2-32 位字母/数字/_/-' });
    }
    if (typeof password !== 'string' || password.length < 6) {
      return reply.code(400).send({ error: 'weak_password', message: '密码至少 6 位' });
    }
    if (findByUsername(db, username)) {
      return reply.code(409).send({ error: 'username_taken', message: '用户名已存在' });
    }
    const account = createAccount(db, { username, password, role: 'user' });
    return reply.code(201).send({ account: publicAccount(account) });
  });

  app.delete('/api/accounts/:id', { preHandler: guards }, async (req, reply) => {
    const id = Number.parseInt(req.params.id, 10);
    const target = Number.isFinite(id) ? findById(db, id) : null;
    if (!target) {
      return reply.code(404).send({ error: 'not_found', message: '账号不存在' });
    }
    if (target.id === req.account.id || target.role === 'admin') {
      return reply
        .code(400)
        .send({ error: 'cannot_delete', message: '不能删除自己或管理员账号' });
    }
    // 级联删除 sessions + clips + api_tokens
    db.prepare('DELETE FROM sessions WHERE account_id = ?').run(target.id);
    db.prepare('DELETE FROM clips WHERE account_id = ?').run(target.id);
    db.prepare('DELETE FROM api_tokens WHERE account_id = ?').run(target.id);
    db.prepare('DELETE FROM accounts WHERE id = ?').run(target.id);
    hub.closeAccount(target.id);
    return reply.code(204).send();
  });

  app.post('/api/accounts/:id/password', { preHandler: guards }, async (req, reply) => {
    const id = Number.parseInt(req.params.id, 10);
    const target = Number.isFinite(id) ? findById(db, id) : null;
    if (!target) {
      return reply.code(404).send({ error: 'not_found', message: '账号不存在' });
    }
    const password = req.body?.password;
    if (typeof password !== 'string' || password.length < 6) {
      return reply.code(400).send({ error: 'weak_password', message: '密码至少 6 位' });
    }
    db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?').run(
      hashPassword(password),
      target.id
    );
    // 重置后吊销该账号全部 session
    deleteSessionsForAccount(db, target.id);
    hub.closeAccount(target.id);
    return reply.code(204).send();
  });
}
