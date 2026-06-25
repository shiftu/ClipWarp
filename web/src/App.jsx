import { useState, useEffect, useRef, useCallback } from 'react';
import { api, setUnauthorizedHandler } from './api.js';
import Login from './components/Login.jsx';
import Board from './components/Board.jsx';
import DeviceAuthPage from './components/DeviceAuthPage.jsx';

// 从 hash（如 "#/device-auth?code=CW-XXXX"）解析 code 查询参数。
function parseHashCode(hash) {
  const idx = hash.indexOf('?');
  if (idx === -1) return '';
  return new URLSearchParams(hash.slice(idx + 1)).get('code') || '';
}

export default function App() {
  const [account, setAccount] = useState(null);
  const [checking, setChecking] = useState(true);
  const [toast, setToast] = useState(null);
  const [hash, setHash] = useState(window.location.hash);
  const toastTimer = useRef(null);

  // 极简哈希路由：监听 hashchange 切换设备授权页（无需 react-router）。
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const showToast = useCallback((msg) => {
    clearTimeout(toastTimer.current);
    setToast({ msg, key: Date.now() });
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }, []);

  const clearSession = useCallback(() => {
    setAccount(null);
  }, []);

  // 全局 401 处理：清状态回登录页
  useEffect(() => {
    setUnauthorizedHandler(clearSession);
    return () => setUnauthorizedHandler(null);
  }, [clearSession]);

  // 启动时探测会话
  useEffect(() => {
    let cancelled = false;
    api('/api/me')
      .then((d) => {
        if (!cancelled && d && d.account) setAccount(d.account);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (checking) {
    return (
      <div className="splash">
        <span className="splash-bolt">⚡</span>
      </div>
    );
  }

  const isDeviceAuth = hash.startsWith('#/device-auth');

  return (
    <>
      {isDeviceAuth ? (
        <DeviceAuthPage user={account} code={parseHashCode(hash)} onLogin={setAccount} />
      ) : account ? (
        <Board account={account} showToast={showToast} onLogout={clearSession} />
      ) : (
        <Login onLogin={setAccount} />
      )}
      {toast && (
        <div className="toast" key={toast.key}>
          {toast.msg}
        </div>
      )}
    </>
  );
}
