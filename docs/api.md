# ClipWarp API 契约（M1 + M2 + M3）

Server 与 Web 都以本文件为准。所有响应均为 JSON（除 204）。错误统一形如 `{ "error": "<code>", "message": "<人类可读>" }`。

## 认证

两种方式（任一通过即认证，先 cookie 后 Bearer）：
1. **Session cookie**：`cw_session`（httpOnly, SameSite=Lax, Path=/, 30 天）——浏览器登录态。
2. **个人访问令牌（PAT，M3）**：`Authorization: Bearer cw_pat_<40hex>`——给 MCP / 脚本用。明文仅创建时返回一次，库内只存 sha256。PAT 请求的设备名取令牌标签（默认 `MCP`）。

未认证访问受保护接口 → `401 {"error":"unauthorized"}`。令牌管理接口（`/api/tokens`）仅接受 cookie 会话，PAT 调用返回 `403 forbidden`（禁止令牌自我增殖）。

### POST /api/login

请求：`{ "username": "...", "password": "...", "deviceLabel": "iPhone 15" }`（deviceLabel 可选，默认从 User-Agent 推断，如 "iPhone" / "Mac" / "Unknown"）
- 200：`{ "account": { "id": 1, "username": "admin", "role": "admin" } }` + Set-Cookie
- 401：`{"error":"invalid_credentials"}`
- 429：同 IP 1 分钟内失败 ≥5 次 `{"error":"rate_limited"}`

### POST /api/logout

- 204，删除 session 行并清 cookie。

### GET /api/me

- 200：`{ "account": { "id", "username", "role" }, "deviceLabel": "..." }`
- 401 未登录。

## Clips（全部按当前 account 隔离）

Clip 对象：

```json
{
  "id": 42,
  "content": "...",
  "contentType": "text|json|url|code",
  "title": null,
  "isPinned": false,
  "isSensitive": false,
  "burnAfterRead": false,
  "deviceLabel": "iPhone 15",
  "createdAt": 1760000000000,
  "expiresAt": null
}
```

- `isSensitive`（M2）：服务端确定性 secret 检测命中（密钥/令牌/凭据形态）。前端默认遮罩，点"显示"揭开；复制不需揭开。
- `burnAfterRead`（M2）：阅后即焚。复制成功后客户端 `DELETE` 销毁，服务端广播 `clip:deleted` 全端移除。
- `expiresAt`（M2）：TTL 过期毫秒时间戳；`null` = 永久。过期项不在列表返回，并由后台 sweeper 周期回收 + 广播删除。

### GET /api/clips?limit=50&before=<id>

倒序（最新在前）。`limit` 默认 50 最大 200；`before` 为游标（返回 id < before 的）。pinned 不影响排序（仍按 id 倒序，前端可置顶展示）。
- 200：`{ "clips": [Clip...], "hasMore": true }`

### GET /api/clips/search?q=<词>&limit=50（M3+M4）

关键词搜索，account 隔离 + 过滤已过期。实现为**服务端内存过滤**：从库中读取全部 pinned 及最近若干条解密后，在内存中做字面子串匹配（Unicode 大小写不敏感）。`q` 中的特殊字符按字面处理，无需 SQL 转义。`limit` 默认 50 最大 200，倒序。
- 200：`{ "clips": [Clip...] }`
- 400：`{"error":"empty_query"}`（q 为空）

### POST /api/clips

请求：`{ "content": "...", "burnAfterRead": false, "ttlSeconds": 3600 }`。`burnAfterRead`、`ttlSeconds` 均可选。服务端做规则版类型识别（见下）+ secret 检测（命中置 `isSensitive`），并记录请求 session 的 deviceLabel。
- `ttlSeconds`：正整数秒，上限 30 天（2,592,000）；超出按上限截断。`expiresAt = now + ttlSeconds*1000`。不传 = 永久。
- 201：`{ "clip": Clip }`，并向该账号所有 WS 连接广播 `clip:new`
- 自动标题（M3）：非敏感 clip 入库后**异步**调用 LLM 网关生成标题，成功则落库并广播 `clip:updated`。`isSensitive` 的 clip 绝不外发 LLM。网关未配置/超时/出错一律跳过，不影响本接口与同步。
- 400：`{"error":"empty_content"}`、`{"error":"content_too_large"}`（> 1,048,576 字节 UTF-8）、`{"error":"invalid_ttl"}`（ttlSeconds 非正数或非法）

插入后裁剪：该账号未 pin 的 clip 只保留最新 500 条，被裁剪的不广播删除事件。

### DELETE /api/clips/:id

- 204，并广播 `clip:deleted`
- 404：非本账号或不存在 `{"error":"not_found"}`

### POST /api/clips/:id/pin

请求：`{ "pinned": true }`
- 200：`{ "clip": Clip }`，并广播 `clip:pinned`
- 404 同上。

### 类型识别规则（服务端，保证多端一致）

1. trim 后以 `{` 或 `[` 开头且 `JSON.parse` 成功 → `json`
2. 单行且匹配 `/^https?:\/\/\S+$/` → `url`
3. 含换行且匹配 `/[{};]|^\s*(import |export |function |def |class |const |let |var |#include|package |fn |func )/m` → `code`
4. 其余 → `text`

### Secret 检测（M2，服务端确定性正则）

命中任一即置 `isSensitive=true`（偏向召回，误报代价仅是前端遮罩一下）：PEM 私钥块、JWT、AWS Access Key（AKIA/ASIA…）、GitHub token（ghp_/github_pat_…）、Slack（xox[baprs]-）、Google API key（AIza…）、Stripe（sk_live/sk_test…）、`sk-`/`sk-ant-` 风格密钥、`Bearer <token>`、以及 `password|secret|token|api_key|...` 形式的 key=value 赋值。仅扫描内容前 64KB。检测不阻断粘贴、不改写内容。

## 个人访问令牌（PAT，M3，全部按 account 隔离 + 仅 cookie 会话可操作）

PAT 调用这些接口返回 `403 forbidden`（防令牌自我增殖）。

### GET /api/tokens
- 200：`{ "tokens": [{ "id", "label", "createdAt", "lastUsedAt" }] }`（不含明文）

### POST /api/tokens
请求：`{ "label": "MacBook MCP" }`（label 可选，≤ 64 字）
- 201：`{ "token": "cw_pat_<40hex>", "id", "label", "createdAt", "lastUsedAt": null }`（`token` 明文仅此一次返回）
- 400：`{"error":"invalid_label"}`（label 非字符串）

### DELETE /api/tokens/:id
- 204；吊销后该令牌立即失效。
- 404：非本账号或不存在。

## MCP server（`mcp/`，stdio）

独立 Node 包，仅通过上面的 HTTP API 工作。以 `CLIPWARP_TOKEN`（PAT）+ `CLIPWARP_URL`（默认 `http://localhost:2547`）配置。注册：`claude mcp add clipwarp -- node /路径/ClipWarp/mcp/index.js`。工具：

| 工具 | 入参 | 映射 |
|---|---|---|
| `clipboard_push` | `content`, `burnAfterRead?`, `ttlSeconds?` | `POST /api/clips` |
| `clipboard_pull` | `limit?`（默认 10，≤ 50） | `GET /api/clips?limit=` |
| `clipboard_search` | `query`, `limit?`（默认 10，≤ 50） | `GET /api/clips/search?q=` |

## Admin（role=admin，否则 403 `{"error":"forbidden"}`）

### GET /api/accounts
- 200：`{ "accounts": [{ "id", "username", "role", "createdAt", "clipCount" }] }`

### POST /api/accounts
请求：`{ "username": "...", "password": "..." }`（username: `/^[a-zA-Z0-9_-]{2,32}$/`；password ≥ 6 位）
- 201：`{ "account": { "id", "username", "role" } }`
- 409：`{"error":"username_taken"}`；400 校验失败 `{"error":"invalid_username"|"weak_password"}`

### DELETE /api/accounts/:id
级联删除其 sessions 和 clips。不能删除自己、不能删除 admin 角色账号 → 400 `{"error":"cannot_delete"}`；404 不存在。
- 204

### POST /api/accounts/:id/password
请求：`{ "password": "..." }`。重置后吊销该账号全部 session。
- 204

## WebSocket `/ws`

升级时用 `cw_session` cookie 认证，未认证以 code **4401** 关闭。
连接归入 account 房间。消息均为 JSON 文本帧。

Server → Client：

| type | 载荷 | 时机 |
|---|---|---|
| `hello` | `{ "type":"hello", "devices":[Device...] }` | 连接建立后立即 |
| `clip:new` | `{ "type":"clip:new", "clip": Clip }` | 本账号任意设备新增 |
| `clip:deleted` | `{ "type":"clip:deleted", "id": 42 }` | 删除 |
| `clip:pinned` | `{ "type":"clip:pinned", "id": 42, "pinned": true }` | pin 状态变化 |
| `clip:updated` | `{ "type":"clip:updated", "clip": Clip }` | clip 字段更新（M3 自动标题落库） |
| `presence` | `{ "type":"presence", "devices":[Device...] }` | 本账号设备上线/下线 |

Device 对象：`{ "deviceLabel": "iPhone 15", "since": 1760000000000 }`（同账号当前在线 WS 连接，含自己）。

Client → Server：`{ "type":"ping" }` → 回 `{ "type":"pong" }`（客户端每 30s 发一次保活；断线自动重连，指数退避上限 10s，重连成功后客户端应重新拉取 GET /api/clips 对齐状态）。

## 其他

- `GET /api/health` → 200 `{ "ok": true, "version": "<server package.json 版本>" }`（无需认证；version 为运行中服务端版本号，会随发版变动）
- 生产模式下 `@fastify/static` 托管 `web/dist`，SPA fallback 到 `index.html`（`/api/*` 与 `/ws` 除外）。
- Vite dev proxy：`/api` 和 `/ws`（ws:true）→ `http://localhost:2547`。
