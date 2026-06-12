// TTL 清扫器：周期性删除已过期的 clip，并向对应账号广播 clip:deleted，让在线设备实时移除。
// GET /api/clips 已在查询层过滤过期项（即使 sweeper 未跑也不会返回），sweeper 负责真正回收 + 实时通知。
const DEFAULT_INTERVAL_MS = 60_000;

export function createSweeper({ db, hub, intervalMs = DEFAULT_INTERVAL_MS }) {
  /** 删除所有 expires_at <= now 的 clip，按账号广播删除事件。返回清除条数。 */
  function sweep(now = Date.now()) {
    const expired = db
      .prepare('SELECT id, account_id FROM clips WHERE expires_at IS NOT NULL AND expires_at <= ?')
      .all(now);
    if (expired.length === 0) return 0;
    db.prepare('DELETE FROM clips WHERE expires_at IS NOT NULL AND expires_at <= ?').run(now);
    for (const row of expired) {
      hub.broadcast(row.account_id, { type: 'clip:deleted', id: row.id });
    }
    return expired.length;
  }

  const timer = setInterval(() => {
    try {
      sweep();
    } catch {
      /* 单次清扫失败不影响后续 */
    }
  }, intervalMs);
  timer.unref?.();

  return {
    sweep,
    stop() {
      clearInterval(timer);
    },
  };
}
