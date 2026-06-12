import { useState } from 'react';
import { relativeTime } from '../utils.js';

const TYPE_META = {
  text: { label: 'TEXT', cls: 'badge-text' },
  json: { label: 'JSON', cls: 'badge-json' },
  url: { label: 'URL', cls: 'badge-url' },
  code: { label: 'CODE', cls: 'badge-code' },
};

const COLLAPSE_LINES = 6;
const PREVIEW_CHARS = 2000; // 折叠态最多塞进 DOM 的字符数，避免 1MB clip 整段渲染拖垮列表

export default function ClipCard({ clip, onCopy, onPin, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const meta = TYPE_META[clip.contentType] || TYPE_META.text;
  const lineCount = (clip.content.match(/\n/g) || []).length + 1;
  const collapsible = lineCount > COLLAPSE_LINES || clip.content.length > 480;

  // 折叠态只把截断后的预览交给 DOM；展开才渲染完整内容（CSS line-clamp 只隐藏不卸载，无法省内存）。
  const display =
    collapsible && !expanded ? clip.content.slice(0, PREVIEW_CHARS) : clip.content;

  function toggle() {
    if (collapsible) setExpanded((v) => !v);
  }

  return (
    <article className={`clip-card${clip.isPinned ? ' pinned' : ''}`}>
      <header className="clip-head">
        <span className={`badge ${meta.cls}`}>{meta.label}</span>
        {clip.isPinned && <span className="pin-mark">📌</span>}
        <span className="clip-meta">
          {clip.deviceLabel || '未知设备'} · {relativeTime(clip.createdAt)}
        </span>
      </header>
      {/* 内容一律按文本渲染（React 默认转义），绝不注入 HTML */}
      <pre
        className={`clip-content${expanded ? ' expanded' : ''}${collapsible ? ' collapsible' : ''}`}
        onClick={toggle}
        title={collapsible ? (expanded ? '点击收起' : '点击展开') : undefined}
      >
        {display}
        {collapsible && !expanded && display.length < clip.content.length ? ' …' : ''}
      </pre>
      {collapsible && (
        <button type="button" className="expand-btn" onClick={toggle}>
          {expanded ? '收起 ▲' : '展开 ▼'}
        </button>
      )}
      <footer className="clip-actions">
        <button type="button" className="action-btn" onClick={() => onCopy(clip)}>
          复制
        </button>
        <button type="button" className="action-btn" onClick={() => onPin(clip)}>
          {clip.isPinned ? '取消置顶' : '置顶'}
        </button>
        <button type="button" className="action-btn danger" onClick={() => onDelete(clip)}>
          删除
        </button>
      </footer>
    </article>
  );
}
