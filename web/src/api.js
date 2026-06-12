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
