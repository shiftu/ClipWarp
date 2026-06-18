// WS Hub：/ws 升级时用 cw_session 认证（失败 close 4401），按 accountId 分房间，
// 连接即发 hello（含 devices），上下线广播 presence，协议层 ping 清死连接。
import { WebSocketServer } from 'ws';
import { COOKIE_NAME, getValidSession, parseCookieHeader } from './sessions.js';

const HEARTBEAT_MS = 30_000;

export function createWsHub({ server, db, heartbeatMs = HEARTBEAT_MS }) {
  // maxPayload：本协议只收 {"type":"ping"} 等微小帧，限 64KB 防认证用户发超大帧打爆内存。
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  /** Map<accountId, Set<ws>>，每个 ws 挂 meta = { accountId, deviceLabel, since } */
  const rooms = new Map();

  function devices(accountId) {
    const room = rooms.get(accountId);
    if (!room) return [];
    return [...room].map((ws) => ({
      deviceLabel: ws.meta.deviceLabel,
      since: ws.meta.since,
    }));
  }

  function broadcast(accountId, payload) {
    const room = rooms.get(accountId);
    if (!room) return;
    const text = JSON.stringify(payload);
    for (const ws of room) {
      if (ws.readyState === ws.OPEN) ws.send(text);
    }
  }

  // 向所有账号房间的所有 OPEN 连接广播同一帧（升级公告等全局通知）。
  function broadcastAll(payload) {
    const text = JSON.stringify(payload);
    for (const room of rooms.values()) {
      for (const ws of room) {
        if (ws.readyState === ws.OPEN) ws.send(text);
      }
    }
  }

  function joinRoom(ws) {
    const { accountId } = ws.meta;
    let room = rooms.get(accountId);
    if (!room) {
      room = new Set();
      rooms.set(accountId, room);
    }
    room.add(ws);
  }

  function leaveRoom(ws) {
    const { accountId } = ws.meta;
    const room = rooms.get(accountId);
    if (!room) return;
    room.delete(ws);
    if (room.size === 0) rooms.delete(accountId);
    broadcast(accountId, { type: 'presence', devices: devices(accountId) });
  }

  server.on('upgrade', (req, socket, head) => {
    // 整个升级前处理包在 try/catch 里：认证发生在握手前，任何未捕获异常
    // （畸形 cookie、解析错误等）都不能逃逸到事件循环顶层把进程打崩。
    try {
      let pathname = '';
      try {
        pathname = new URL(req.url, 'http://localhost').pathname;
      } catch {
        /* fallthrough */
      }
      if (pathname !== '/ws') {
        socket.destroy();
        return;
      }

      const cookies = parseCookieHeader(req.headers.cookie);
      const token = cookies[COOKIE_NAME];
      const session = getValidSession(db, token);

      wss.handleUpgrade(req, socket, head, (ws) => {
        if (!session) {
          // 完成握手后以 4401 关闭，客户端可据此识别"未认证"
          ws.close(4401, 'unauthorized');
          return;
        }
        const deviceLabel = session.device_label || 'Unknown';
        // 存 token：心跳里据此复验 session，登出/改密/过期后主动断开（否则旧连接会一直收广播）。
        ws.meta = { accountId: session.account_id, deviceLabel, since: Date.now(), token };
        ws.isAlive = true;

      joinRoom(ws);
      ws.send(JSON.stringify({ type: 'hello', devices: devices(ws.meta.accountId) }));
      // 上线：向本账号全部连接广播 presence
      broadcast(ws.meta.accountId, { type: 'presence', devices: devices(ws.meta.accountId) });

      ws.on('pong', () => {
        ws.isAlive = true;
      });
      ws.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (msg && msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      });
      ws.on('close', () => leaveRoom(ws));
      ws.on('error', () => {
        try {
          ws.terminate();
        } catch {
          /* noop */
        }
      });
      });
    } catch {
      // 升级阶段任何异常都只销毁本次连接，不影响进程
      try {
        socket.destroy();
      } catch {
        /* noop */
      }
    }
  });

  // 服务端协议层 ping 清死连接：顺带复验 session，已注销/过期的连接主动 close(4401)
  const heartbeat = setInterval(() => {
    for (const room of [...rooms.values()]) {
      for (const ws of [...room]) {
        if (ws.isAlive === false) {
          ws.terminate(); // close 事件里会 leaveRoom + 广播 presence
          continue;
        }
        // 复验 session：登出/改密/过期会删 session 行，旧 WS 连接据此主动断开，
        // 否则被吊销的会话仍能持续收到本账号广播。
        if (!getValidSession(db, ws.meta?.token)) {
          ws.close(4401, 'revoked');
          continue;
        }
        ws.isAlive = false;
        try {
          ws.ping();
        } catch {
          /* noop */
        }
      }
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  /** 强制断开某账号全部连接（删号/改密吊销 session 后调用）。 */
  function closeAccount(accountId, code = 4401, reason = 'revoked') {
    const room = rooms.get(accountId);
    if (!room) return;
    for (const ws of [...room]) {
      try {
        ws.close(code, reason);
      } catch {
        /* noop */
      }
    }
  }

  function close() {
    clearInterval(heartbeat);
    for (const room of rooms.values()) {
      for (const ws of room) {
        try {
          ws.terminate();
        } catch {
          /* noop */
        }
      }
    }
    rooms.clear();
    wss.close();
  }

  return { broadcast, broadcastAll, devices, closeAccount, close };
}
