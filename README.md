# ⚡ ClipWarp

[![version](https://img.shields.io/badge/version-0.3.0-blue)](https://github.com/shiftu/ClipWarp/releases)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![stack](https://img.shields.io/badge/stack-Fastify%20%C2%B7%20SQLite%20%C2%B7%20ws%20%C2%B7%20React%2FVite-444)](docs/design.md)
[![PWA](https://img.shields.io/badge/PWA-installable-5A0FC8?logo=pwa&logoColor=white)](https://github.com/shiftu/ClipWarp)

> AI Native 云端粘贴板 —— 文本在设备之间"瞬移"。

iPhone 上粘贴一段 token / 配置 JSON / 任意文本，Mac 浏览器里实时出现、一键复制。跨设备、跨网络，多账号隔离，同账号多设备实时同步。

## 特性

- 📋 **一键粘贴 / 一键复制** —— 移动优先 PWA，iPhone 添加到主屏幕即是 App
- ⚡ **实时同步** —— WebSocket 按账号分房间广播，多设备秒级到达
- 🔒 **账号隔离** —— admin + 子账号，数据互不可见；session 可吊销
- 🧠 **AI Native**（路线图）—— 类型识别、secret 检测遮罩、LLM 自动标题、语义搜索、MCP 工具（Claude Code 直接读写粘贴板）

## 快速开始

```bash
# 服务端
cd server && npm install && npm start          # 默认 http://localhost:2547
# 首次启动自动创建 admin，密码见 stdout 或 ~/.config/clipwarp/initial-admin-password.txt

# 前端开发
cd web && npm install && npm run dev

# 生产部署（macOS launchd，构建前端 + 常驻服务）
./scripts/deploy-launchd.sh
```

环境变量：`PORT`（默认 2547）、`HOST`（默认 0.0.0.0）、`CLIPWARP_HOME`（数据目录，默认 `~/.config/clipwarp`）。

> ⚠️ `navigator.clipboard` 需要 HTTPS（或 localhost）。生产环境请挂在反向代理后提供 HTTPS。

## 文档

- [设计文档](docs/design.md) —— 架构、数据模型、安全、roadmap
- [API 契约](docs/api.md) —— REST + WebSocket 协议

## Roadmap

| 版本 | 内容 |
|---|---|
| v0.1 | 核心同步：账号、CRUD、WS 实时、PWA、launchd 部署 |
| v0.2 | 智能层：secret 检测遮罩、JSON 高亮、阅后即焚、TTL |
| v0.3 | AI Native：MCP server、LLM 自动标题、语义搜索 |
| v1.0 | 加固：静态加密、端到端加密选项、平滑升级 |

## License

[MIT](LICENSE) © 2026 jiangtao
