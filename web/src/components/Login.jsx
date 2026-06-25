import { useState } from 'react';
import { api } from '../api.js';
import { guessDevice } from '../utils.js';

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [deviceLabel, setDeviceLabel] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const guessed = guessDevice();

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const body = { username: username.trim(), password };
      const label = deviceLabel.trim();
      if (label) body.deviceLabel = label;
      const d = await api('/api/login', { method: 'POST', body });
      onLogin(d.account);
    } catch (err) {
      if (err.status === 401) setError('用户名或密码错误');
      else if (err.status === 429) setError('尝试太频繁，请稍后再试');
      else setError('登录失败，请检查网络后重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-logo">
          <span className="logo-text">⚡ ClipWarp</span>
          <p className="login-slogan">文本在设备间瞬移</p>
        </div>
        <form onSubmit={handleSubmit} className="login-form">
          <label className="field">
            <span className="field-label">用户名</span>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              required
            />
          </label>
          <label className="field">
            <span className="field-label">密码</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <label className="field">
            <span className="field-label">设备名（可选）</span>
            <input
              type="text"
              value={deviceLabel}
              onChange={(e) => setDeviceLabel(e.target.value)}
              placeholder={guessed || '此设备'}
              maxLength={64}
            />
          </label>
          {error && <p className="login-error">{error}</p>}
          <button type="submit" className="primary-btn" disabled={busy}>
            {busy ? '登录中…' : '进入 ClipWarp'}
          </button>
        </form>
        <a className="login-device-link" href="#/device-auth">
          📲 在其他设备授权登录（免密码）
        </a>
      </div>
    </div>
  );
}
