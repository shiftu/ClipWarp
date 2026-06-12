import { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';

const CREATE_ERR = {
  username_taken: '用户名已存在',
  invalid_username: '用户名需 2-32 位字母/数字/_/-',
  weak_password: '密码至少 6 位',
};

export default function AdminPanel({ onClose, showToast }) {
  const [accounts, setAccounts] = useState(null);
  const [error, setError] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [creating, setCreating] = useState(false);
  const [resetId, setResetId] = useState(null);
  const [resetPw, setResetPw] = useState('');

  const load = useCallback(async () => {
    try {
      const d = await api('/api/accounts');
      setAccounts(d.accounts);
    } catch (err) {
      setError(err.status === 403 ? '没有权限' : '加载账号列表失败');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreate(e) {
    e.preventDefault();
    if (creating) return;
    setError('');
    setCreating(true);
    try {
      await api('/api/accounts', {
        method: 'POST',
        body: { username: newUsername.trim(), password: newPassword },
      });
      setNewUsername('');
      setNewPassword('');
      showToast('账号已创建');
      load();
    } catch (err) {
      setError(CREATE_ERR[err.error] || '创建失败');
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(acc) {
    if (!window.confirm(`确定删除账号「${acc.username}」？其全部 clips 将一并删除。`)) return;
    setError('');
    try {
      await api(`/api/accounts/${acc.id}`, { method: 'DELETE' });
      showToast('账号已删除');
      load();
    } catch (err) {
      setError(err.error === 'cannot_delete' ? '不能删除自己或 admin 账号' : '删除失败');
    }
  }

  async function handleReset(e) {
    e.preventDefault();
    if (resetPw.length < 6) {
      setError('密码至少 6 位');
      return;
    }
    setError('');
    try {
      await api(`/api/accounts/${resetId}/password`, {
        method: 'POST',
        body: { password: resetPw },
      });
      showToast('密码已重置');
      setResetId(null);
      setResetPw('');
    } catch {
      setError('重置密码失败');
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>账号管理</h2>
          <button type="button" className="ghost-btn" onClick={onClose}>
            关闭
          </button>
        </header>

        {error && <p className="modal-error">{error}</p>}

        {accounts === null ? (
          <p className="modal-hint">加载中…</p>
        ) : (
          <ul className="account-list">
            {accounts.map((acc) => (
              <li key={acc.id} className="account-row">
                <div className="account-info">
                  <span className="account-name">
                    {acc.username}
                    {acc.role === 'admin' && <span className="role-tag">admin</span>}
                  </span>
                  <span className="account-sub">
                    {acc.clipCount} 条 clip · {new Date(acc.createdAt).toLocaleDateString('zh-CN')}
                  </span>
                </div>
                <div className="account-actions">
                  <button
                    type="button"
                    className="ghost-btn small"
                    onClick={() => {
                      setResetId(resetId === acc.id ? null : acc.id);
                      setResetPw('');
                      setError('');
                    }}
                  >
                    重置密码
                  </button>
                  {acc.role !== 'admin' && (
                    <button
                      type="button"
                      className="ghost-btn small danger"
                      onClick={() => handleDelete(acc)}
                    >
                      删除
                    </button>
                  )}
                </div>
                {resetId === acc.id && (
                  <form className="reset-form" onSubmit={handleReset}>
                    <input
                      type="password"
                      value={resetPw}
                      onChange={(e) => setResetPw(e.target.value)}
                      placeholder="新密码（≥ 6 位）"
                      autoFocus
                    />
                    <button type="submit" className="ghost-btn small">
                      确认
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}

        <form className="create-form" onSubmit={handleCreate}>
          <h3>新建账号</h3>
          <div className="create-fields">
            <input
              type="text"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              placeholder="用户名"
              autoCapitalize="none"
              autoCorrect="off"
              required
            />
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="密码（≥ 6 位）"
              required
            />
            <button type="submit" className="primary-btn small" disabled={creating}>
              {creating ? '创建中…' : '创建'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
