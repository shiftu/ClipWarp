import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import * as api from '../api.js';

// 快速扫码登录弹窗：桌面已登录用户点开 → 拉取 quick-login-qr → 生成二维码。
// 手机扫码后打开预填 URL（带 ?username=），登录页自动填好用户名，用户只需输密码。
export default function QrPopup({ onClose }) {
  const [state, setState] = useState({ loading: true, error: '', dataUrl: '', info: null });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const info = await api.quickLoginQr();
        // 把预填 URL 编成二维码（中等纠错，留白小，便于手机识别）。
        const dataUrl = await QRCode.toDataURL(info.url, {
          width: 240,
          margin: 2,
          errorCorrectionLevel: 'M',
        });
        if (alive) setState({ loading: false, error: '', dataUrl, info });
      } catch (e) {
        if (alive) setState({ loading: false, error: e.message || '生成二维码失败', dataUrl: '', info: null });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal qr-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>扫码登录</h2>
          <button type="button" className="modal-close" onClick={onClose} title="关闭">
            ×
          </button>
        </header>

        {state.loading ? (
          <div className="qr-loading">生成中…</div>
        ) : state.error ? (
          <p className="modal-error">{state.error}</p>
        ) : (
          <>
            <div className="qr-image-wrap">
              <img className="qr-image" src={state.dataUrl} alt="登录二维码" />
            </div>
            <p className="qr-user">
              账号：<strong>{state.info.username}</strong>
            </p>
            <ol className="qr-steps">
              <li>用手机相机或浏览器扫描上方二维码</li>
              <li>打开后会自动填好服务器地址与用户名</li>
              <li>在手机上输入密码即可登录</li>
            </ol>
            <p className="qr-note">二维码 5 分钟内有效；为安全起见仅预填用户名，登录仍需密码。</p>
          </>
        )}
      </div>
    </div>
  );
}
