import { useState, useMemo } from 'react';
import { relativeTime, remainingTime } from '../utils.js';
import { prettyJson, highlightJson } from '../json-highlight.js';

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
  const [revealed, setRevealed] = useState(false);
  const isJson = clip.contentType === 'json';
  const [formatted, setFormatted] = useState(isJson); // json 默认美化展示

  const meta = TYPE_META[clip.contentType] || TYPE_META.text;
  const masked = clip.isSensitive && !revealed; // 敏感内容默认遮罩，点击揭开

  // JSON 美化（仅 json、开启格式化、且非遮罩态时）；解析失败回退原文。
  // useMemo 避免父组件每次重渲染（30s tick / presence / 广播）都对最大 1MB 内容重复 parse+stringify。
  const pretty = useMemo(
    () => (isJson && formatted && !masked ? prettyJson(clip.content) : null),
    [isJson, formatted, masked, clip.content]
  );
  const body = pretty ?? clip.content;

  const lineCount = (body.match(/\n/g) || []).length + 1;
  const collapsible = !masked && (lineCount > COLLAPSE_LINES || body.length > 480);
  // 折叠态只把截断后的预览交给 DOM；展开才渲染完整内容（CSS line-clamp 只隐藏不卸载，无法省内存）。
  const display = collapsible && !expanded ? body.slice(0, PREVIEW_CHARS) : body;
  const truncated = collapsible && !expanded && display.length < body.length;

  function toggle() {
    if (collapsible) setExpanded((v) => !v);
  }

  const remain = clip.expiresAt ? remainingTime(clip.expiresAt) : null;

  return (
    <article
      className={`clip-card${clip.isPinned ? ' pinned' : ''}${clip.isSensitive ? ' sensitive' : ''}`}
    >
      <header className="clip-head">
        <span className={`badge ${meta.cls}`}>{meta.label}</span>
        {clip.isSensitive && <span className="badge badge-sensitive">🔒 敏感</span>}
        {clip.burnAfterRead && <span className="badge badge-burn">🔥 阅后即焚</span>}
        {clip.isPinned && <span className="pin-mark">📌</span>}
        <span className="clip-meta">
          {remain && <span className="ttl-chip">⏳ {remain}</span>}
          {clip.deviceLabel || '未知设备'} · {relativeTime(clip.createdAt)}
        </span>
      </header>

      {masked ? (
        <div className="clip-masked" onClick={() => setRevealed(true)}>
          <span className="masked-dots">•••• •••• 已遮蔽敏感内容 •••• ••••</span>
          <button
            type="button"
            className="reveal-btn"
            onClick={(e) => {
              e.stopPropagation();
              setRevealed(true);
            }}
          >
            👁 显示
          </button>
        </div>
      ) : (
        <>
          {/* 内容一律按文本渲染（React 默认转义），高亮只产出带类名的 <span>，绝不注入 HTML */}
          <pre
            className={`clip-content${expanded ? ' expanded' : ''}${collapsible ? ' collapsible' : ''}`}
            onClick={toggle}
            title={collapsible ? (expanded ? '点击收起' : '点击展开') : undefined}
          >
            {pretty
              ? highlightJson(display).map((t, i) =>
                  t.cls ? (
                    <span key={i} className={`j ${t.cls}`}>
                      {t.text}
                    </span>
                  ) : (
                    t.text
                  )
                )
              : display}
            {truncated ? ' …' : ''}
          </pre>
          {collapsible && (
            <button type="button" className="expand-btn" onClick={toggle}>
              {expanded ? '收起 ▲' : '展开 ▼'}
            </button>
          )}
        </>
      )}

      <footer className="clip-actions">
        <div className="action-group">
          <button type="button" className="action-btn" onClick={() => onCopy(clip)}>
            {clip.burnAfterRead ? '复制并销毁' : '复制'}
          </button>
          {isJson && !masked && (
            <button
              type="button"
              className="action-btn"
              onClick={() => setFormatted((v) => !v)}
            >
              {formatted ? '原文' : '格式化'}
            </button>
          )}
          {clip.isSensitive && revealed && (
            <button type="button" className="action-btn" onClick={() => setRevealed(false)}>
              隐藏
            </button>
          )}
        </div>
        <div className="action-group">
          <button type="button" className="action-btn" onClick={() => onPin(clip)}>
            {clip.isPinned ? '取消置顶' : '置顶'}
          </button>
          <button type="button" className="action-btn danger" onClick={() => onDelete(clip)}>
            删除
          </button>
        </div>
      </footer>
    </article>
  );
}
