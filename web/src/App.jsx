import { useState, useEffect, useRef, useCallback } from 'react';
import { api, setUnauthorizedHandler } from './api.js';
import Login from './components/Login.jsx';
import Board from './components/Board.jsx';

export default function App() {
  const [account, setAccount] = useState(null);
  const [checking, setChecking] = useState(true);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

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

  return (
    <>
      {account ? (
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
