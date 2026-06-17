# ClipWarp 设计文档

> **Warp = 曲速传送**。AI Native 云端粘贴板：文本在设备之间"瞬移"——iPhone 上粘贴进来，Mac 上一键复制走。跨设备、跨网络同步配置 JSON、token、密钥、任意文本。

- 仓库：`~/github/ClipWarp`
- 服务名：`lol.jiangtao.clipwarp`（launchd）
- 数据目录：`~/.config/clipwarp/`（可用 `CLIPWARP_HOME` 覆盖）
- 默认端口：`2547`（电话键盘上的 C-L-I-P）

## 核心理念：确定性同步内核 + AI 智能表面

同步本身（增删改查、多设备广播）是确定性的、不依赖 LLM 的——断网了、LLM 挂了，粘贴板照常工作。AI 价值放在内容理解和查询层（类型识别、secret 检测、自动标题、语义搜索、MCP 工具）。

## 架构

```
iPhone PWA ─┐                        ┌─ SQLite (clips/accounts/sessions)
Mac 浏览器 ──┤── HTTPS/WSS ── Fastify ┤─ AI 层（类型识别/secret检测/LLM标题）→ llm-gateway
Claude Code ┘   (MCP/REST)           └─ WS Hub（按 account 分房间广播）
```

- **Server**：Node ESM（纯 JS，不用 TS，与 CloudClaude 一致）+ Fastify 5 + `@fastify/cookie` + `@fastify/static` + `ws` + `better-sqlite3`，密码 bcryptjs。
- **Web**：React 18 + Vite，PWA（iPhone 添加到主屏幕）。移动优先。
- **多设备**：同账号所有 WS 连接进同一房间，新 clip 即时推送；显示在线设备（登录时填 device label）。
- **账号隔离**：admin + 子账号，所有查询强制 `WHERE account_id = ?`，账号间完全不可见。
- **iOS 注意**：`navigator.clipboard` 需要 HTTPS（或 localhost）+ 用户手势。粘贴 = 点大按钮触发 `readText`（失败则聚焦 textarea 让用户手动粘贴）；复制 = 每条 clip 的复制按钮 `writeText`。

## 数据模型（SQLite）

```sql
accounts(id INTEGER PRIMARY KEY AUTOINCREMENT,
         username TEXT UNIQUE NOT NULL,
         password_hash TEXT NOT NULL,
         role TEXT NOT NULL DEFAULT 'user',     -- 'admin' | 'user'
         created_at INTEGER NOT NULL)

sessions(token TEXT PRIMARY KEY,                -- 32 字节随机 hex
         account_id INTEGER NOT NULL,
         device_label TEXT,
         created_at INTEGER NOT NULL,
         expires_at INTEGER NOT NULL)           -- 30 天

clips(id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      content TEXT NOT NULL,                    -- ≤ 1MB
      content_type TEXT NOT NULL DEFAULT 'text',-- 'text'|'json'|'url'|'code'
      title TEXT,                               -- M3: LLM 自动标题；M1 为 NULL
      is_pinned INTEGER NOT NULL DEFAULT 0,
      is_sensitive INTEGER NOT NULL DEFAULT 0,  -- M2: secret 检测（命中遮罩）
      burn_after_read INTEGER NOT NULL DEFAULT 0,-- M2: 阅后即焚（复制即销毁）
      device_label TEXT,                        -- 来源设备
      created_at INTEGER NOT NULL,
      expires_at INTEGER)                       -- M2: TTL；NULL = 永久
-- INDEX: clips(account_id, id DESC)
```

留存策略：每账号保留最近 **500** 条未 pin 的 clip，插入时裁剪超出部分；pinned 永久保留。

## 安全（M1）

- bcrypt 密码哈希；登录失败限速（同 IP 5 次/分钟 → 429）。
- Session cookie：`cw_session`，httpOnly + SameSite=Lax，30 天过期，存 DB 可吊销。
- 所有 clips/WS 操作强制 account 隔离。
- content 大小限制 1MB；日志不打印 clip 内容。
- 数据目录 `chmod 700`。
- M2+：secret 检测遮罩、阅后即焚、TTL；M4：静态加密 + 可选端到端加密。

## Roadmap

| 里程碑 | 内容 |
|---|---|
| **M1 · v0.1 核心同步** | 账号/登录/隔离、clip CRUD + pin、WS 实时广播、PWA、一键粘贴/复制、设备在线列表、规则版类型识别（json/url/code/text）、launchd 部署脚本 |
| **M2 · v0.2 智能层** | secret 检测+遮罩、JSON 格式化/高亮、阅后即焚、TTL 过期 |
| **M3 · v0.3 AI Native** | ✅ 核心两件：MCP server（clipboard_push/pull/search）+ 个人访问令牌、LLM 自动标题（接 llm-gateway，敏感内容不外发）、关键词搜索。语义搜索（embedding 向量）推后到后续小版本 |
| **M4 · v1.0 加固发布** | 静态加密 + 可选端到端加密、历史管理、平滑升级广播 |

## M1 范围明确（YAGNI）

- ✅ 纯文本（含 JSON/代码/URL，本质都是文本）
- ❌ 图片/文件（v1.1+）
- ❌ LLM 调用（M3）
- ❌ 编辑 clip（只增删，粘贴板不需要编辑）
- ✅ admin 账号管理 UI（创建/删除子账号、改密码）
- 引导：首次启动若无账号，自动创建 `admin`，随机密码打印到 stdout 并写入
  `~/.config/clipwarp/initial-admin-password.txt`（chmod 600）

## 部署（沿用 CloudClaude 模式）

- `scripts/deploy-launchd.sh`：构建前端 → 生成 plist（label `lol.jiangtao.clipwarp`）→ bootstrap 启动。代码与数据分离，重部署不动数据。
- `scripts/undeploy-launchd.sh`：卸载服务。
- 环境变量：`PORT`（默认 2547）、`HOST`（默认 0.0.0.0）、`CLIPWARP_HOME`（默认 `~/.config/clipwarp`）。
- 反向代理提供 HTTPS（clipboard API 必需 secure context）。
