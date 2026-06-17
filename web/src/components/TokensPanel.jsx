import { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';

// 个人访问令牌（PAT）管理：给 MCP / 脚本用 Bearer 认证。
// 明文仅创建时返回一次——展示并提供一键复制，关闭后无法再查看。
export default function TokensPanel({ onClose, showToast }) {
  const [tokens, setTokens] = useState(null);
  const [error, setError] = useState('');
  const [label, setLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [freshToken, setFreshToken] = useState(null); // 刚创建出的明文（仅此一次）

  const load = useCallback(async () => {
    try {
      const d = await api('/api/tokens');
      setTokens(d.tokens);
    } catch {
      setError('加载令牌列表失败');
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
      const d = await api('/api/tokens', {
        method: 'POST',
        body: { label: label.trim() || undefined },
      });
      setFreshToken({ token: d.token, label: d.label });
      setLabel('');
      showToast('令牌已创建');
      load();
    } catch {
      setError('创建令牌失败');
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(t) {
    if (!window.confirm(`吊销令牌「${t.label || '未命名'}」？使用它的 MCP/脚本将立即失效。`)) return;
    setError('');
    try {
      await api(`/api/tokens/${t.id}`, { method: 'DELETE' });
      showToast('令牌已吊销');
      load();
    } catch {
      setError('吊销失败');
    }
  }

  async function copyToken() {
    try {
      await navigator.clipboard.writeText(freshToken.token);
      showToast('已复制到剪贴板');
    } catch {
      showToast('复制失败，请手动选择');
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>个人访问令牌</h2>
          <button type="button" className="ghost-btn" onClick={onClose}>
            关闭
          </button>
        </header>

        <p className="modal-hint">
          供 MCP（Claude Code 直接读写粘贴板）与脚本以 <code>Authorization: Bearer</code> 认证使用。
          注册：<code>claude mcp add clipwarp -- node /路径/ClipWarp/mcp/index.js</code>，
          并设环境变量 <code>CLIPWARP_URL</code> / <code>CLIPWARP_TOKEN</code>。
        </p>

        {error && <p className="modal-error">{error}</p>}

        {freshToken && (
          <div className="token-reveal">
            <p className="token-reveal-hint">
              ⚠️ 令牌仅此一次完整显示，关闭后无法再查看，请立即保存：
            </p>
            <code className="token-value">{freshToken.token}</code>
            <button type="button" className="primary-btn small" onClick={copyToken}>
              复制
            </button>
          </div>
        )}

        {tokens === null ? (
          <p className="modal-hint">加载中…</p>
        ) : tokens.length === 0 ? (
          <p className="modal-hint">还没有令牌。</p>
        ) : (
          <ul className="account-list">
            {tokens.map((t) => (
              <li key={t.id} className="account-row">
                <div className="account-info">
                  <span className="account-name">{t.label || '未命名'}</span>
                  <span className="account-sub">
                    创建 {new Date(t.createdAt).toLocaleDateString('zh-CN')}
                    {t.lastUsedAt
                      ? ` · 最近使用 ${new Date(t.lastUsedAt).toLocaleDateString('zh-CN')}`
                      : ' · 从未使用'}
                  </span>
                </div>
                <div className="account-actions">
                  <button
                    type="button"
                    className="ghost-btn small danger"
                    onClick={() => handleDelete(t)}
                  >
                    吊销
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <form className="create-form" onSubmit={handleCreate}>
          <h3>新建令牌</h3>
          <div className="create-fields">
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="标签（可选，如 MacBook MCP）"
              autoCapitalize="none"
              autoCorrect="off"
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
