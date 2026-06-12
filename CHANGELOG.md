# Changelog

## [Unreleased]

### M1 · v0.1.0 核心同步（开发中）
- 账号体系：admin + 子账号，登录/登出，账号隔离，首启自动创建 admin
- Clips：创建 / 列表（游标分页）/ 删除 / pin，规则版类型识别（json/url/code/text），每账号留存 500 条
- 实时：WebSocket 按账号分房间广播（clip:new / clip:deleted / clip:pinned / presence）
- Web：React + Vite PWA，移动优先，一键粘贴 / 复制，设备在线列表，admin 账号管理
- 部署：launchd 脚本（lol.jiangtao.clipwarp），数据目录 ~/.config/clipwarp
