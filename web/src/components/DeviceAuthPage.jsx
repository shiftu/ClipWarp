import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import * as api from '../api.js';

// 设备授权页（#/device-auth）。双模式：
//  - 未登录（新设备）：申请授权码 → 显示 user_code + 二维码 → 轮询，等已登录设备确认后自动登录。
//  - 已登录（信任设备，URL 带 ?code=XXXX）：显示确认按钮，确认后新设备即可登录。
export default function DeviceAuthPage({ user, code, onLogin }) {
  if (user) {
    return <ApproveView code={code} />;
  }
  return <NewDeviceView onLogin={onLogin} />;
}

// —— 信任设备：确认授权 ——
function ApproveView({ code }) {
  const [userCode, setUserCode] = useState((code || '').toUpperCase());
  const [status, setStatus] = useState('idle'); // idle | approving | done | error
  const [error, setError] = useState('');

  async function approve() {
    const c = userCode.trim().toUpperCase();
    if (!c || status === 'approving') return;
    setStatus('approving');
    setError('');
    try {
      await api.deviceApprove(c);
      setStatus('done');
    } catch (e) {
      setError(e.message || '确认失败');
      setStatus('error');
    }
  }

  return (
    <div className="login-page">
      <div className="login-card device-card">
        <div className="device-brand">
          <span className="device-logo">🔐</span>
          <h1 className="device-title">设备授权</h1>
          <p className="device-sub">确认让新设备登录你的账号</p>
        </div>

        {status === 'done' ? (
          <div className="device-done">
            <p className="device-ok">✅ 已确认</p>
            <p className="qr-note">请回到新设备，它会在几秒内自动登录。</p>
            <a className="ghost-btn device-back" href="#/">返回</a>
          </div>
        ) : (
          <>
            <p className="device-prompt">
              确认授权码 <strong className="device-code-inline">{userCode || '（请输入）'}</strong> 登录？
            </p>
            {!code && (
              <label className="field">
                <span className="field-label">授权码</span>
                <input
                  type="text"
                  placeholder="CW-XXXX"
                  value={userCode}
                  autoCapitalize="characters"
                  autoCorrect="off"
                  onChange={(e) => setUserCode(e.target.value.toUpperCase())}
                />
              </label>
            )}
            {error && <p className="login-error">{error}</p>}
            <button
              type="button"
              className="primary-btn"
              onClick={approve}
              disabled={status === 'approving' || !userCode.trim()}
            >
              {status === 'approving' ? '确认中…' : '确认授权'}
            </button>
            <p className="qr-note">只有你本人在信任设备上确认后，新设备才能登录。</p>
            <a className="ghost-btn device-back" href="#/">取消</a>
          </>
        )}
      </div>
    </div>
  );
}

// —— 新设备：申请授权码 + 轮询 ——
function NewDeviceView({ onLogin }) {
  const [data, setData] = useState(null); // { user_code, device_code, verification_uri, interval }
  const [qr, setQr] = useState('');
  const [phase, setPhase] = useState('loading'); // loading | waiting | approved | expired | error
  const [error, setError] = useState('');
  const pollRef = useRef(null);

  // 申请授权码并生成二维码。
  async function init() {
    setPhase('loading');
    setError('');
    try {
      const d = await api.deviceCreateCode();
      setData(d);
      try {
        setQr(await QRCode.toDataURL(d.verification_uri, { width: 200, margin: 2 }));
      } catch {
        setQr(''); // 二维码生成失败不致命，仍可手动输码
      }
      setPhase('waiting');
    } catch (e) {
      setError(e.message || '申请授权码失败');
      setPhase('error');
    }
  }

  useEffect(() => {
    init();
    return () => clearInterval(pollRef.current);
  }, []);

  // waiting 阶段轮询取 token。
  useEffect(() => {
    if (phase !== 'waiting' || !data) return;
    const intervalMs = Math.max(2, data.interval || 5) * 1000;
    pollRef.current = setInterval(async () => {
      try {
        const r = await api.devicePoll(data.device_code);
        if (r.status === 'approved') {
          clearInterval(pollRef.current);
          setPhase('approved');
          // cookie 已由服务端在响应里下发，这里通知 App 切到登录态。
          onLogin(r.account);
          window.location.hash = '#/';
        }
        // pending：继续轮询。
      } catch (e) {
        // 410 过期 / 404 失效：停止轮询，提示刷新。
        if (e.status === 410 || e.status === 404) {
          clearInterval(pollRef.current);
          setPhase('expired');
        }
        // 其它（网络抖动）忽略，下一轮再试。
      }
    }, intervalMs);
    return () => clearInterval(pollRef.current);
  }, [phase, data]);

  return (
    <div className="login-page">
      <div className="login-card device-card">
        <div className="device-brand">
          <span className="device-logo">📲</span>
          <h1 className="device-title">在此设备登录</h1>
          <p className="device-sub">无需输入密码，去已登录的设备上确认</p>
        </div>

        {phase === 'loading' && <div className="qr-loading">生成授权码…</div>}

        {phase === 'error' && (
          <>
            <p className="login-error">{error}</p>
            <button type="button" className="primary-btn" onClick={init}>重试</button>
          </>
        )}

        {phase === 'expired' && (
          <>
            <p className="device-prompt">授权码已过期。</p>
            <button type="button" className="primary-btn" onClick={init}>重新生成</button>
          </>
        )}

        {phase === 'approved' && <div className="device-ok">✅ 已授权，正在进入…</div>}

        {phase === 'waiting' && data && (
          <>
            <div className="device-code-big">{data.user_code}</div>
            {qr && (
              <div className="qr-image-wrap">
                <img className="qr-image" src={qr} alt="授权二维码" />
              </div>
            )}
            <ol className="qr-steps">
              <li>在<strong>已登录</strong>的手机/电脑上扫码，或点击「📱 扫码」进入设备授权</li>
              <li>核对授权码 <strong>{data.user_code}</strong> 后点确认</li>
              <li>本设备将自动登录（约 5 秒内）</li>
            </ol>
            <p className="qr-note device-waiting">等待确认中…</p>
            <a className="ghost-btn device-back" href="#/">用密码登录</a>
          </>
        )}
      </div>
    </div>
  );
}
