// 启动一次性加密迁移：把存量明文 content/title 就地加密回写。
// 前置密钥自检（出现 cipher-undecryptable 即 fail-fast，防错密钥二次加密）+ 加密前自动备份。
// 逐字段独立判断，绝不二次加密已是 cipher-valid 的字段。幂等。
import fs from 'node:fs';

export function encryptExistingClips({ db, crypto, dbFile }) {
  const rows = db.prepare('SELECT id, content, title FROM clips').all();

  const work = [];
  for (const row of rows) {
    const cClass = crypto.classify(row.content);
    const tClass = row.title == null ? 'plaintext' : crypto.classify(row.title);
    // 密钥自检：像真密文却解不开 = 错密钥/损坏 → 中止，绝不加密（否则会把旧密文再裹一层）。
    if (cClass === 'cipher-undecryptable' || tClass === 'cipher-undecryptable') {
      throw new Error(
        '主密钥与现有数据不匹配（请核对 CLIPWARP_KEY / master.key），已停止以避免数据损坏'
      );
    }
    const needContent = cClass === 'plaintext';
    const needTitle = row.title != null && tClass === 'plaintext';
    if (needContent || needTitle) {
      work.push({
        id: row.id,
        content: needContent ? crypto.encrypt(row.content) : row.content,
        title: row.title == null ? null : needTitle ? crypto.encrypt(row.title) : row.title,
      });
    }
  }

  let backupPath = null;
  if (work.length > 0 && dbFile) {
    backupPath = dbFile + '.pre-m4.bak';
    if (!fs.existsSync(backupPath)) fs.copyFileSync(dbFile, backupPath); // 加密前备份，迁移不可逆
  }

  if (work.length > 0) {
    db.exec('BEGIN'); // 显式事务，兼容 better-sqlite3 与 node:sqlite 两驱动
    try {
      const upd = db.prepare('UPDATE clips SET content = ?, title = ? WHERE id = ?');
      for (const w of work) upd.run(w.content, w.title, w.id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  return { scanned: rows.length, encrypted: work.length, backupPath };
}
