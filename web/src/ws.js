// WebSocket 客户端：同源 /ws，断线指数退避重连（上限 10s），每 30s ping 保活。
// 4401 关闭码 = 未认证 → 触发 onUnauthorized。

export class WSClient {
  constructor({ onMessage, onOpen, onClose, onUnauthorized }) {
    this.onMessage = onMessage;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.onUnauthorized = onUnauthorized;
    this.ws = null;
    this.attempt = 0;
    this.everOpened = false;
    this.destroyed = false;
    this.pingTimer = null;
    this.reconnectTimer = null;
  }

  connect() {
    if (this.destroyed) return;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws;
    try {
      ws = new WebSocket(`${proto}//${window.location.host}/ws`);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      const isReconnect = this.everOpened;
      this.everOpened = true;
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 30000);
      if (this.onOpen) this.onOpen(isReconnect);
    };

    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (this.onMessage) this.onMessage(msg);
    };

    ws.onclose = (e) => {
      clearInterval(this.pingTimer);
      this.ws = null;
      if (this.destroyed) return;
      if (this.onClose) this.onClose();
      if (e.code === 4401) {
        if (this.onUnauthorized) this.onUnauthorized();
        return;
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }

  scheduleReconnect() {
    if (this.destroyed) return;
    const delay = Math.min(10000, 500 * 2 ** this.attempt);
    this.attempt += 1;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  destroy() {
    this.destroyed = true;
    clearInterval(this.pingTimer);
    clearTimeout(this.reconnectTimer);
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    }
  }
}
