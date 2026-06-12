// 工具函数：UA 推断设备名 / 复制降级 / 相对时间

export function guessDevice() {
  const ua = navigator.userAgent || '';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  // iPadOS 13+ 伪装成 Mac，但有多点触控
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac';
  return '';
}

// 复制：clipboard.writeText 优先，失败降级 textarea + execCommand
export async function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* 降级 */
    }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function relativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / 86400000)} 天前`;
  const d = new Date(ts);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

// TTL 剩余时间（用于过期倒计时展示）
export function remainingTime(expiresAt) {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return '已过期';
  if (ms < 60 * 1000) return `剩 ${Math.ceil(ms / 1000)} 秒`;
  if (ms < 60 * 60 * 1000) return `剩 ${Math.ceil(ms / 60000)} 分`;
  if (ms < 24 * 60 * 60 * 1000) return `剩 ${Math.ceil(ms / 3600000)} 时`;
  return `剩 ${Math.ceil(ms / 86400000)} 天`;
}
