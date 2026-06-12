// Clips 路由：列表（游标分页）/ 新增（类型识别 + 裁剪 + 广播）/ 删除 / pin。
// 所有 SQL 强制 WHERE account_id = ?，跨账号一律 404 not_found。
import { detectContentType } from './content-type.js';

export const MAX_CONTENT_BYTES = 1_048_576; // 1MB UTF-8
const KEEP_UNPINNED = 500;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function toClip(row) {
  return {
    id: row.id,
    content: row.content,
    contentType: row.content_type,
    title: row.title,
    isPinned: !!row.is_pinned,
    isSensitive: !!row.is_sensitive,
    deviceLabel: row.device_label,
    createdAt: row.created_at,
  };
}

export default function registerClipRoutes(app, { db, hub, authHook }) {
  app.get('/api/clips', { preHandler: authHook }, async (req) => {
    const accountId = req.account.id;
    let limit = Number.parseInt(req.query?.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
    if (limit > MAX_LIMIT) limit = MAX_LIMIT;
    const before = Number.parseInt(req.query?.before, 10);

    let rows;
    if (Number.isFinite(before)) {
      rows = db
        .prepare(
          'SELECT * FROM clips WHERE account_id = ? AND id < ? ORDER BY id DESC LIMIT ?'
        )
        .all(accountId, before, limit + 1);
    } else {
      rows = db
        .prepare('SELECT * FROM clips WHERE account_id = ? ORDER BY id DESC LIMIT ?')
        .all(accountId, limit + 1);
    }
    const hasMore = rows.length > limit;
    return { clips: rows.slice(0, limit).map(toClip), hasMore };
  });

  app.post('/api/clips', { preHandler: authHook }, async (req, reply) => {
    const accountId = req.account.id;
    const content = req.body?.content;

    if (typeof content !== 'string' || content.length === 0) {
      return reply.code(400).send({ error: 'empty_content', message: '内容不能为空' });
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
      return reply.code(400).send({ error: 'content_too_large', message: '内容超过 1MB 上限' });
    }

    const contentType = detectContentType(content);
    const info = db
      .prepare(
        'INSERT INTO clips (account_id, content, content_type, device_label, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(accountId, content, contentType, req.session.device_label ?? null, Date.now());

    // 插入后裁剪：未 pin 的只保留最新 500 条（被裁剪的不广播删除事件）
    db.prepare(
      `DELETE FROM clips
       WHERE account_id = ? AND is_pinned = 0 AND id NOT IN (
         SELECT id FROM clips WHERE account_id = ? AND is_pinned = 0 ORDER BY id DESC LIMIT ?
       )`
    ).run(accountId, accountId, KEEP_UNPINNED);

    const row = db
      .prepare('SELECT * FROM clips WHERE id = ? AND account_id = ?')
      .get(Number(info.lastInsertRowid), accountId);
    const clip = toClip(row);
    hub.broadcast(accountId, { type: 'clip:new', clip });
    return reply.code(201).send({ clip });
  });

  app.delete('/api/clips/:id', { preHandler: authHook }, async (req, reply) => {
    const accountId = req.account.id;
    const id = Number.parseInt(req.params.id, 10);
    const info = Number.isFinite(id)
      ? db.prepare('DELETE FROM clips WHERE id = ? AND account_id = ?').run(id, accountId)
      : { changes: 0 };
    if (!info.changes) {
      return reply.code(404).send({ error: 'not_found', message: 'clip 不存在' });
    }
    hub.broadcast(accountId, { type: 'clip:deleted', id });
    return reply.code(204).send();
  });

  app.post('/api/clips/:id/pin', { preHandler: authHook }, async (req, reply) => {
    const accountId = req.account.id;
    const id = Number.parseInt(req.params.id, 10);
    const pinned = req.body?.pinned === true;

    const row = Number.isFinite(id)
      ? db.prepare('SELECT * FROM clips WHERE id = ? AND account_id = ?').get(id, accountId)
      : null;
    if (!row) {
      return reply.code(404).send({ error: 'not_found', message: 'clip 不存在' });
    }
    db.prepare('UPDATE clips SET is_pinned = ? WHERE id = ? AND account_id = ?').run(
      pinned ? 1 : 0,
      id,
      accountId
    );
    const updated = db
      .prepare('SELECT * FROM clips WHERE id = ? AND account_id = ?')
      .get(id, accountId);
    hub.broadcast(accountId, { type: 'clip:pinned', id, pinned });
    return reply.code(200).send({ clip: toClip(updated) });
  });
}
