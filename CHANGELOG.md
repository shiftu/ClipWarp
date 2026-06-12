# Changelog

## [Unreleased]

### M1 · v0.1.0 核心同步（开发中）
- 账号体系：admin + 子账号，登录/登出，账号隔离，首启自动创建 admin
- Clips：创建 / 列表（游标分页）/ 删除 / pin，规则版类型识别（json/url/code/text），每账号留存 500 条
- 实时：WebSocket 按账号分房间广播（clip:new / clip:deleted / clip:pinned / presence）
- Web：React + Vite PWA，移动优先，一键粘贴 / 复制，设备在线列表，admin 账号管理
- 部署：launchd 脚本（lol.jiangtao.clipwarp），数据目录 ~/.config/clipwarp
- 加固（多维审查 + 对抗验证后修复）：
  - 修复畸形 Cookie 触发 WS 升级解析异常导致进程崩溃的未认证远程 DoS
  - 登出/改密/过期后心跳复验 session，主动断开被吊销的 WS 连接
  - trustProxy 可配（默认不信任 XFF，防伪造 IP 绕过登录限速）
  - 会话 cookie Secure 标志可配（COOKIE_SECURE=1）；WS 帧 64KB 上限
  - 登录恒定时间比对，消除用户名枚举侧信道；框架级错误归一为 {error,message}
  - 前端：折叠 clip 仅渲染截断预览（省内存）、降级粘贴框 16px 防 iOS 缩放、WS 首连即对齐拉取
