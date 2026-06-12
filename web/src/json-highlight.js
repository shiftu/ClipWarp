// 安全的 JSON 美化 + 轻量高亮：把 JSON 文本切成带类名的 token，由 React 渲染为 <span>，
// 全程按文本处理（React 默认转义），绝不注入 HTML。

/** 美化：解析成功返回缩进 2 空格的字符串；非法 JSON 返回 null（调用方回退原文）。 */
export function prettyJson(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}

// 依次匹配：带引号字符串（可含转义）、true/false/null、数字。其余作为普通文本切片透传。
const TOKEN_RE = /("(?:\\.|[^"\\])*")|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

/**
 * 把 JSON 文本切成 token 数组：[{ text, cls }]。cls 为 null 表示普通文本（标点/空白）。
 * cls：jk=key（后跟冒号的字符串）/ js=string value / jb=bool|null / jn=number。
 */
export function highlightJson(text) {
  const tokens = [];
  let last = 0;
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    if (m.index > last) tokens.push({ text: text.slice(last, m.index), cls: null });
    const tok = m[0];
    if (m[1] !== undefined) {
      // 字符串：紧跟（忽略空白后）冒号的是 key，否则是字符串值
      const after = text.slice(TOKEN_RE.lastIndex);
      tokens.push({ text: tok, cls: /^\s*:/.test(after) ? 'jk' : 'js' });
    } else if (m[2] !== undefined) {
      tokens.push({ text: tok, cls: 'jb' });
    } else {
      tokens.push({ text: tok, cls: 'jn' });
    }
    last = TOKEN_RE.lastIndex;
  }
  if (last < text.length) tokens.push({ text: text.slice(last), cls: null });
  return tokens;
}
