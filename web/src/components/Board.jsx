import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { api } from '../api.js';
import { copyToClipboard } from '../utils.js';
import { WSClient } from '../ws.js';
import ClipCard from './ClipCard.jsx';
import AdminPanel from './AdminPanel.jsx';

const PAGE_SIZE = 50;

export default function Board({ account, showToast, onLogout }) {
  const [clips, setClips] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [devices, setDevices] = useState([]);
  const [wsOnline, setWsOnline] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [fallbackOpen, setFallbackOpen] = useState(false);
  const [fallbackText, setFallbackText] = useState('');
  const [sending, setSending] = useState(false);
  const [, setTick] = useState(0);

  // 相对时间每 30s 刷新一次
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  const loadClips = useCallback(async () => {
    try {
      const d = await api(`/api/clips?limit=${PAGE_SIZE}`);
      setClips(d.clips);
      setHasMore(d.hasMore);
      setLoaded(true);
    } catch {
      /* 401 已全局处理；网络错误静默，WS 重连后会再对齐 */
    }
  }, []);

  // 首次加载
  useEffect(() => {
    loadClips();
  }, [loadClips]);

  // WebSocket：实时广播 + presence
  useEffect(() => {
    const client = new WSClient({
      onMessage: (msg) => {
        switch (msg.type) {
          case 'hello':
          case 'presence':
            setDevices(msg.devices || []);
            break;
          case 'clip:new':
            // 按 id 去重：自己 POST 已本地插入 + 广播重复到达
            setClips((prev) =>
              prev.some((c) => c.id === msg.clip.id) ? prev : [msg.clip, ...prev]
            );
            break;
          case 'clip:deleted':
            setClips((prev) => prev.filter((c) => c.id !== msg.id));
            break;
          case 'clip:pinned':
            setClips((prev) =>
              prev.map((c) => (c.id === msg.id ? { ...c, isPinned: msg.pinned } : c))
            );
            break;
          default:
            break;
        }
      },
      onOpen: () => {
        setWsOnline(true);
        // 每次 WS 连上都重新拉全量对齐：首连可补上"挂载拉取快照→WS 订阅"之间产生的 clip，
        // 重连可补上断线期间的增量。clip:new 按 id 去重，多拉一次无副作用。
        loadClips();
      },
      onClose: () => {
        setWsOnline(false);
        setDevices([]);
      },
      onUnauthorized: onLogout,
    });
    client.connect();
    return () => client.destroy();
  }, [loadClips, onLogout]);

  const sendContent = useCallback(
    async (content) => {
      setSending(true);
      try {
        const d = await api('/api/clips', { method: 'POST', body: { content } });
        setClips((prev) =>
          prev.some((c) => c.id === d.clip.id) ? prev : [d.clip, ...prev]
        );
        showToast('已瞬移 ⚡');
        return true;
      } catch (err) {
        if (err.error === 'content_too_large') showToast('内容超过 1MB 限制');
        else if (err.error === 'empty_content') showToast('内容为空');
        else if (err.status !== 401) showToast('发送失败，请重试');
        return false;
      } finally {
        setSending(false);
      }
    },
    [showToast]
  );

  // 大按钮粘贴：readText 必须在点击手势内直接调用；被拒/不支持 → 降级 textarea
  async function handlePaste() {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      setFallbackOpen(true);
      return;
    }
    let text;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      showToast('无法读取剪贴板，请手动粘贴');
      setFallbackOpen(true);
      return;
    }
    if (!text || !text.trim()) {
      showToast('剪贴板是空的');
      return;
    }
    await sendContent(text);
  }

  async function handleFallbackSend() {
    const text = fallbackText;
    if (!text.trim()) return;
    const ok = await sendContent(text);
    if (ok) {
      setFallbackText('');
      setFallbackOpen(false);
    }
  }

  async function handleLoadMore() {
    if (loadingMore || clips.length === 0) return;
    setLoadingMore(true);
    try {
      const before = Math.min(...clips.map((c) => c.id));
      const d = await api(`/api/clips?limit=${PAGE_SIZE}&before=${before}`);
      setClips((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...d.clips.filter((c) => !seen.has(c.id))];
      });
      setHasMore(d.hasMore);
    } catch (err) {
      if (err.status !== 401) showToast('加载失败，请重试');
    } finally {
      setLoadingMore(false);
    }
  }

  const handleCopy = useCallback(
    async (clip) => {
      const ok = await copyToClipboard(clip.content);
      showToast(ok ? '已复制' : '复制失败');
    },
    [showToast]
  );

  const handlePin = useCallback(
    async (clip) => {
      try {
        const d = await api(`/api/clips/${clip.id}/pin`, {
          method: 'POST',
          body: { pinned: !clip.isPinned },
        });
        setClips((prev) => prev.map((c) => (c.id === d.clip.id ? d.clip : c)));
      } catch (err) {
        if (err.status !== 401) showToast('操作失败，请重试');
      }
    },
    [showToast]
  );

  const handleDelete = useCallback(
    async (clip) => {
      if (!window.confirm('确定删除这条 clip 吗？')) return;
      try {
        await api(`/api/clips/${clip.id}`, { method: 'DELETE' });
        setClips((prev) => prev.filter((c) => c.id !== clip.id));
      } catch (err) {
        if (err.status !== 401) showToast('删除失败，请重试');
      }
    },
    [showToast]
  );

  async function handleLogout() {
    try {
      await api('/api/logout', { method: 'POST' });
    } catch {
      /* 即使失败也清本地状态 */
    }
    onLogout();
  }

  // pinned 置顶区 + 普通区，均按 id 倒序
  const pinnedClips = useMemo(
    () => clips.filter((c) => c.isPinned).sort((a, b) => b.id - a.id),
    [clips]
  );
  const normalClips = useMemo(
    () => clips.filter((c) => !c.isPinned).sort((a, b) => b.id - a.id),
    [clips]
  );

  return (
    <div className="board">
      <header className="topbar">
        <div className="topbar-row">
          <span className="logo-text">⚡ ClipWarp</span>
          <span className="spacer" />
          {account.role === 'admin' && (
            <button type="button" className="ghost-btn" onClick={() => setAdminOpen(true)}>
              账号管理
            </button>
          )}
          <button type="button" className="ghost-btn" onClick={handleLogout}>
            退出
          </button>
        </div>
        <div className="device-bar">
          {wsOnline ? (
            devices.map((d, i) => (
              <span key={`${d.deviceLabel}-${d.since}-${i}`} className="device-chip">
                <i className="dot online" />
                {d.deviceLabel || '未知设备'}
              </span>
            ))
          ) : (
            <span className="device-chip offline">
              <i className="dot reconnecting" />
              连接中…
            </span>
          )}
        </div>
      </header>

      <main className="content">
        {loaded && clips.length === 0 && (
          <div className="empty-state">
            <p className="empty-bolt">⚡</p>
            <p>还没有 clip</p>
            <p className="empty-hint">点下面的按钮，把剪贴板里的内容瞬移过来</p>
          </div>
        )}

        {pinnedClips.length > 0 && (
          <section className="clip-section">
            <h2 className="section-title">📌 置顶</h2>
            {pinnedClips.map((clip) => (
              <ClipCard
                key={clip.id}
                clip={clip}
                onCopy={handleCopy}
                onPin={handlePin}
                onDelete={handleDelete}
              />
            ))}
          </section>
        )}

        {normalClips.length > 0 && (
          <section className="clip-section">
            {pinnedClips.length > 0 && <h2 className="section-title">最近</h2>}
            {normalClips.map((clip) => (
              <ClipCard
                key={clip.id}
                clip={clip}
                onCopy={handleCopy}
                onPin={handlePin}
                onDelete={handleDelete}
              />
            ))}
          </section>
        )}

        {hasMore && (
          <button
            type="button"
            className="load-more-btn"
            onClick={handleLoadMore}
            disabled={loadingMore}
          >
            {loadingMore ? '加载中…' : '加载更多'}
          </button>
        )}
      </main>

      {fallbackOpen && (
        <div className="paste-sheet">
          <div className="paste-sheet-head">
            <span>手动粘贴</span>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => setFallbackOpen(false)}
            >
              收起
            </button>
          </div>
          <textarea
            value={fallbackText}
            onChange={(e) => setFallbackText(e.target.value)}
            placeholder="粘贴到这里"
            rows={5}
            autoFocus
          />
          <button
            type="button"
            className="primary-btn"
            onClick={handleFallbackSend}
            disabled={sending || !fallbackText.trim()}
          >
            {sending ? '发送中…' : '发送 ⚡'}
          </button>
        </div>
      )}

      {!fallbackOpen && (
        <button type="button" className="paste-btn" onClick={handlePaste} disabled={sending}>
          📋 粘贴
        </button>
      )}

      {adminOpen && (
        <AdminPanel onClose={() => setAdminOpen(false)} showToast={showToast} />
      )}
    </div>
  );
}
