// 统一 API 封装：同源相对路径（dev 走 Vite proxy，prod 同源托管）。
// 任何接口返回 401 → 触发全局 unauthorized 处理（清状态回登录页）。

let unauthorizedHandler = null;

export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = fn;
}

export async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw { status: 0, error: 'network_error' };
  }
  if (res.status === 401) {
    if (unauthorizedHandler) unauthorizedHandler();
    throw { status: 401, error: 'unauthorized' };
  }
  if (res.status === 204) return null;
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    throw { status: res.status, ...(data || {}) };
  }
  return data;
}

// —— 跨设备登录（设备授权码 / 扫码快速登录）——
export const deviceCreateCode = () => api('/api/auth/device/code', { method: 'POST' });
export const devicePoll = (device_code) =>
  api('/api/auth/device/token', { method: 'POST', body: { device_code } });
export const deviceApprove = (user_code) =>
  api('/api/auth/device/approve', { method: 'POST', body: { user_code } });
export const deviceCheck = (user_code) =>
  api(`/api/auth/device/check?user_code=${encodeURIComponent(user_code)}`);
export const quickLoginQr = () => api('/api/auth/quick-login-qr');
