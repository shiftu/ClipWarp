// 规则版类型识别（服务端，保证多端一致）。规则与顺序见 docs/api.md。
const URL_RE = /^https?:\/\/\S+$/;
const CODE_RE = /[{};]|^\s*(import |export |function |def |class |const |let |var |#include|package |fn |func )/m;

export function detectContentType(content) {
  const trimmed = content.trim();

  // 1. trim 后以 { 或 [ 开头且 JSON.parse 成功 → json
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      /* 不是合法 JSON，继续 */
    }
  }

  // 2. 单行且匹配 URL → url
  if (!trimmed.includes('\n') && URL_RE.test(trimmed)) {
    return 'url';
  }

  // 3. 含换行且匹配代码特征 → code
  if (content.includes('\n') && CODE_RE.test(content)) {
    return 'code';
  }

  // 4. 其余 → text
  return 'text';
}
