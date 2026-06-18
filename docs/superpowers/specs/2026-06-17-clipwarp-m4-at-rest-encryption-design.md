# ClipWarp M4 (v1.0) 设计：静态加密 + 平滑升级广播

- 日期：2026-06-17
- 里程碑：M4 / v1.0（当前 0.3.0 → 1.0.0）
- 状态：设计已确认，经 4 视角对抗式评审加固，待 spec 评审 → 进入实现计划
- 仓库：`~/github/ClipWarp`

> 本文档已根据一轮对抗式评审（密码学/数据完整性/代码一致性/完整性 4 视角，33 条发现）整体修订。核心加固：以 GCM 验证而非字符串前缀作为「是否密文」的权威判据；`decrypt` 全函数化（永不抛错）；迁移前密钥自检防错密钥二次加密；搜索覆盖全部 pinned；前端 banner 落 Board.jsx；迁移前自动备份。

## 1. 目标与非目标

### 目标（v1.0 范围）
1. **静态加密（encryption at rest）**：clip 的 `content` 与 `title` 在 SQLite 落盘时为 AES-256-GCM 密文，磁盘 / 备份 / 仓库泄露不暴露明文。
2. **一次性加密迁移**：服务启动时把存量明文行就地加密回写，幂等、可中断重跑、明密混存安全、错密钥 fail-fast。
3. **平滑升级广播**：服务收 `SIGTERM`/`SIGINT` 时先向所有在线 WS 广播「升级中」，前端切到琥珀重连横幅，骑现有指数退避重连穿过 bind 间隙。
4. **发版 v1.0.0**：版本号、CHANGELOG、README、部署。

### 非目标（明确不做）
- ❌ **端到端加密（E2E）**：服务端仍读明文（保住 secret 检测 / 自动标题 / 搜索）。已评估放弃。
- ❌ **历史管理 UI**（手动清空 / 按时间清理 / 批量删除 / 导出）：推迟到 v1.1。
- ❌ **密钥轮换 / 在线 re-key**：v1.0 不做；`enc:v1:` 版本前缀为将来轮换留空间。
- ❌ **AAD（密文绑定行/账号）**：v1.0 不做（理由见 §2 边界）；将来可经 `enc:v2:` 平滑引入。
- ❌ **零停机热升级**：launchd 无 socket 交接，「平滑」= 前端横幅 + 自动重连，非零中断。
- ❌ 改动传输层：HTTPS/WSS 仍由反向代理提供。

## 2. 威胁模型

| 威胁 | v1.0 防护 | 机制 |
|---|---|---|
| 磁盘 / 备份 / 误传仓库导致 `clipwarp.db` 泄露 | ✅ | content/title 为密文；密钥独立存于 `home/master.key`，与 `home/data/clipwarp.db` **不在同一目录**，可独立于数据备份策略保管 |
| 拿到 DB 但拿不到密钥 | ✅ | 无 `master.key` / `CLIPWARP_KEY` 无法解密 |
| 在原地翻转密文字节（bit-flip） | ✅ | GCM 认证标签：篡改后该行无法解密（按 §4 全函数 decrypt 显示为原存储串，不产生伪造明文） |
| 攻击者把 A 账号密文整块搬到 B 账号行（cut-and-paste relocation） | ❌（已知，本期不防） | v1.0 不绑定 AAD。**前提是攻击者已能写 DB 文件**——在单机 at-rest 模型下，能写 `~/.config/clipwarp/data` 通常等价于能读同属主的 `master.key`，故 AAD 边际价值有限。将来 `enc:v2:` 可绑定 `account_id` |
| 攻击者已取得运行主机的进程读权限 / root | ❌（超出 at-rest 范畴，需 E2E） | 进程内持有明文密钥与明文 clip |
| 服务端管理员窥探用户内容 | ❌（设计如此） | 服务端本就需读明文做 secret/标题/搜索 |

**边界声明（已修正）**：`master.key` 位于 `cfg.home`（如 `~/.config/clipwarp/master.key`），`clipwarp.db` 位于 `cfg.home/data/`——二者**不同目录**，正是为了让密钥能排除在 `data/` 备份之外。README 注明：密钥与数据应分开保管；支持 `CLIPWARP_KEY` 注入实现物理分离。

## 3. 架构总览

```
            ┌─────────────────────────────────────────────┐
clip 写入 →  │ detectContentType / detectSecret（明文元数据）│ → content_type, is_sensitive
            │ crypto.encrypt(content) ──────────────────── │ → content 列存 enc:v1:…
            └─────────────────────────────────────────────┘
clip 读出 ←  │ crypto.decrypt(content/title)（全函数，永不抛）│ ← 行存储串
搜索       :  拉「全部 pinned + 全部未过期 unpinned」→ 内存 decrypt → JS 小写子串匹配
自动标题    :  闭包持明文 content → LLM → crypto.encrypt(title) 回写
迁移       :  备份 → 逐字段 classify → 仅「明文」字段 encrypt（前置密钥自检）
升级广播    :  SIGTERM →（重入守卫）broadcastAll({sys,upgrading}) → drain → close
```

加密 / 解密集中在新模块 `crypto.js`；clip 路由是唯一明密转换点。`sessions / accounts / api-tokens / sweeper / wshub 协议 / secret-detect / content-type / llm / mcp` 不接触明文 clip，均不改。

## 4. 加密内核（新模块 `server/src/crypto.js`）

只依赖 `node:crypto`（better-sqlite3 与 node:sqlite 两驱动下都可用）。工厂 `createCrypto({ home, env = process.env }) → { encrypt, decrypt, classify, keySource }`。

### 4.1 主密钥来源与解析（消歧，评审 #1）
优先级：
1. `env.CLIPWARP_KEY`：按**固定顺序**解析为 32 字节：
   - 若匹配 `/^[0-9a-fA-F]{64}$/` → 当作 **hex**（→ 32 字节）。**纯 64 hex 字符永远按 hex，绝不按 base64**。
   - 否则按 **base64** 解析，且要求 `Buffer.from(s,'base64')` 长度严格 `=== 32` 且 base64 往返一致（`buf.toString('base64')` 规范化后与去填充输入相符），防 Node base64 宽松解析静默接受短/坏密钥。
   - 都不满足 → **抛错并拒绝启动**（绝不静默用弱/错密钥加密整库）。
2. `home/master.key`：存在则读取，按上面同一 hex/base64 规则解析（文件总是写 64-hex，读取无歧义）。
3. 都没有：`crypto.randomBytes(32)`，以 **64-hex** **原子创建**写入 `home/master.key`：
   - `fs.writeFileSync(keyPath, hex, { mode: 0o600, flag: 'wx' })`——`wx`(O_CREAT|O_EXCL) 使「不存在才创建」原子，创建即 0o600（消除 write→chmod 的 TOCTOU 窗口）。
   - 捕获 `EEXIST`（并发启动竞态）：改为**读取已存在文件**，不覆盖。
   - 日志打印「已生成新主密钥」+ `keySource`，**绝不打印密钥本身**。
- `keySource ∈ {'env','file','generated'}`，供启动日志与测试断言。

### 4.2 加密格式
- 算法 `aes-256-gcm`，每次 `crypto.randomBytes(12)` 作 IV，标签 16 字节，**v1.0 不设 AAD**。
- 存储串：`enc:v1:` + base64(`IV(12) ‖ tag(16) ‖ ciphertext`)。
- `encrypt(plaintext: string) → string`：UTF-8 编码加密，返回上述串。空串也照常加密（业务非空校验在上层）。

### 4.3 分类与解密（核心：GCM 验证为权威，前缀仅预筛）
评审 #2/#4/#7/#19/#25/#26 的根因——**不能用字符串前缀单独判定「是否密文」**，因为 clip 内容用户可控，可粘贴以 `enc:v1:` 开头的文本。统一用如下三分类：

`classify(stored: string) → 'plaintext' | 'cipher-valid' | 'cipher-undecryptable'`
- 不以 `enc:v1:` 开头 → `plaintext`（旧明文）。
- 以 `enc:v1:` 开头，但 base64 非法 **或** 解码长度 `< 28`（12+16）→ `plaintext`（用户恰好粘了个像前缀的短文本，如 `enc:v1:hello`）。
- 以 `enc:v1:` 开头、base64 合法、长度 `≥ 28`：在当前密钥下尝试 GCM 解密——
  - 成功 → `cipher-valid`；
  - 失败（标签不符）→ `cipher-undecryptable`（**像真密文但解不开** = 错密钥 / 损坏，危险信号）。

`decrypt(stored) → string`（**全函数，永不抛错**，评审 #7/#9）：
- `cipher-valid` → 返回明文。
- 其它（`plaintext` 或 `cipher-undecryptable`）→ **原样返回 `stored`**。
  - 对用户粘贴的 `enc:v1:hello` 这是正确原文；对损坏行这是退化显示（罕见）——但绝不抛错、绝不 500 整个列表、绝不把脏数据当伪造明文。
  - 错误信息/日志里**绝不**嵌入 stored 串或明文（评审 #9）；decrypt 本身不 log。

### 4.4 不变量（测试断言）
- `decrypt(encrypt(x)) === x`，含中文 / emoji / 1MB 边界 / 空串。
- 同明文两次 encrypt 密文不同（随机 IV）。
- 篡改 base64 任一字节 → 该串 `classify === 'cipher-undecryptable'`、`decrypt` 原样返回不抛。
- 截断（解码 < 28 字节）→ `plaintext`、原样返回。
- 旧明文（无前缀）原样透传。
- 用户文本 `enc:v1:hello`：`classify === 'plaintext'`、`decrypt` 原样返回 `enc:v1:hello`。

## 5. 数据模型与迁移

### 5.1 Schema
**不新增列、不改类型**。`content`、`title` 仍 `TEXT`，内容由明文变为 `enc:v1:…`。其余列保持明文元数据。密文 base64 约比明文大 33%+28 字节；1MB 明文 → ~1.33MB 存储串，SQLite `TEXT` 无实际上限，`bodyLimit`(2MB) 校验的是**请求明文**、`content_too_large` 仍按明文 `Buffer.byteLength ≤ 1MB`（§6.2），不受密文膨胀影响。

### 5.2 一次性迁移（新模块 `server/src/migrate-encrypt.js`）
导出 `encryptExistingClips({ db, crypto }) → { scanned, encrypted, backupPath|null }`。

**前置：自动备份（评审 #17/#29）**。若本进程将要加密任何行（见下判定）且备份文件尚不存在，先 `fs.copyFileSync(dbFile, dbFile + '.pre-m4.bak')`（含 WAL 注意：迁移在 `openDb` 后、服务对外前单线程执行，无并发写；备份在加密前完成）。迁移不可逆，备份是唯一回退。

**前置：密钥自检（评审 #20，防错密钥二次加密灾难）**。先扫描，若**存在任一字段 `classify === 'cipher-undecryptable'`** → **抛错中止启动**：`主密钥与现有数据不匹配（请核对 CLIPWARP_KEY / master.key），已停止以避免数据损坏`（不含任何内容）。
- 区分两种 DB：纯 M3 明文库（无 `cipher-*` 行）→ 正常迁移；已加密库 + 错密钥（出现 `cipher-undecryptable`）→ fail-fast，绝不把旧密文当明文再加密一层。
- 用户粘贴的 `enc:v1:hello`（`plaintext` 类）不会触发自检（解码 < 28）。

**逐字段独立加密（评审 #3）**：
```
for each row (id, account_id, content, title):
  newContent = classify(content) === 'plaintext' ? encrypt(content) : content   // cipher-valid 跳过
  newTitle   = title == null ? null
             : classify(title) === 'plaintext' ? encrypt(title) : title
  if (newContent !== content || newTitle !== title)
     UPDATE clips SET content=?, title=? WHERE id=?
```
- 永不加密已是 `cipher-valid` 的字段（杜绝二次加密 → 否则 `decrypt` 只剥一层返回内层 `enc:v1:…` 脏串）。
- 单事务：`db.exec('BEGIN')` … `COMMIT`，异常 `ROLLBACK`（用 BEGIN/COMMIT 而非 better-sqlite3 专有 `db.transaction()`，兼容 node:sqlite；两驱动均支持 `prepare().all/.run` + `exec`，评审已确认）。
- 规模：每账号 unpinned 留存 ≤500，pinned 无上限但个人量级有限，单事务全表 SELECT+UPDATE 可接受；若未来数据增大再引入分批（v1.0 不做，注明）。
- 返回统计，调用方打印 `[clipwarp] 加密迁移：扫描 N，加密 M，备份 <path|已存在>`（不打印内容）。

**幂等**：`cipher-valid` 字段跳过；重复运行 `encrypted=0`、不再备份。

**调用点**：`createServer` 中 `openDb` 之后、注册路由之前、`createCrypto` 之后。迁移/自检失败 **fail-fast 阻断启动**（与 sweeper 启动失败可吞掉不同——数据完整性不可带病运行）。

### 5.3 兼容与回滚
- 旧版本（无 crypto）读已加密库会把 `enc:v1:…` 当文本显示——不崩但乱码。
- **一旦迁移跑过，回退到 M3 代码无法解密**。CHANGELOG/部署注明：升级不可平滑回退；`*.pre-m4.bak` + `master.key` 为回退凭据。

## 6. 路由层改动（`server/src/routes-clips.js`）

`registerClipRoutes(app, { db, hub, authHook, llm, crypto })` 新增 `crypto`。

### 6.1 `toClip` 改闭包，承担解密
```
function makeToClip(crypto) {
  return (row) => ({ ...,
    content: crypto.decrypt(row.content),
    title: row.title == null ? null : crypto.decrypt(row.title), ... });
}
```
- `decrypt` 全函数永不抛 → **单行损坏不会 500 整个 list/search**（评审 #7）。
- 所有调用点都在 `registerClipRoutes` 内闭包之后：list、search、POST 后广播、pin。

### 6.2 写入 `POST /api/clips`
顺序（**先在明文上算元数据，再加密**）：
1. 校验非空、`Buffer.byteLength(content,'utf8') ≤ 1MB`（**明文**，语义不变）。
2. `detectContentType(content)`、`detectSecret(content)` → 元数据。
3. `enc = crypto.encrypt(content)`，INSERT `content` 列写 `enc`。
4. 裁剪 500（按 id，不碰内容）不变。
5. 广播 `clip:new`，clip = `toClip(row)`（解密后明文，与现状一致）。
- **自动标题（评审 #23 关键修正）**：`scheduleAutoTitle` 现为模块级函数、无法访问闭包 `toClip`/`crypto`。其入参对象新增 `crypto` 与 `toClip`：闭包持**明文** `content`（不读 DB 密文）→ LLM → `UPDATE clips SET title=?` 写 `crypto.encrypt(title)` → 再 `SELECT` 行经 `toClip` 解密广播 `clip:updated`。secret 红线不变（`!isSensitive` 才调）。

### 6.3 搜索 `GET /api/clips/search` —— SQL LIKE 改内存过滤
不能再 `WHERE content LIKE ?`（密文无法匹配）。新逻辑：
1. **候选集必须覆盖全部 pinned**（评审 #6）：`WHERE account_id=? AND (未过期) AND (is_pinned=1 OR id >= <第 CAP 新的 unpinned 起点>)`。实现上更简单且等价：取 `is_pinned=1 全部` ∪ `is_pinned=0 全部未过期`（unpinned 本就 ≤500，pinned 个人量级有限），CAP（如 5000）仅作越界保护并在命中时 `log` 丢弃量，绝不静默截断。**pinned 永远可搜**（与 M3 全表 LIKE 行为一致）。
2. 内存对候选行 `decrypt(content)`、`decrypt(title)`（复用同一 `makeToClip(crypto)`，避免二次解密，评审 #22）。
3. **小写子串匹配**：`hay.toLowerCase().includes(q.toLowerCase())`。诚实说明（评审 #16/#21）：JS `toLowerCase()` 是 Unicode 感知，故搜索对**非 ASCII 有大小写的字母（重音拉丁/希腊/西里尔）变为大小写不敏感**，是 M3 ASCII-only LIKE 的**轻微超集**（更宽松，通常更好）；中文无大小写不受影响。`docs/api.md` 据实更新。
4. `escapeLike` + `ESCAPE` 子句删除，`q` 直接作字面小写子串（评审 #22）。
5. 命中按 id DESC 取前 `limit`，返回 `{ clips }` 不变。

### 6.4 不变的部分
- `GET /api/clips`（分页）：SQL 不变，仅 `toClip` 解密。
- `DELETE`、`POST /:id/pin`：纯元数据；pin 后 `toClip` 解密返回。
- burn-after-read / TTL / sweeper：均基于元数据列，**零改动**（sweeper 按 `expires_at` 删行，不读内容，评审完整性确认）。

### 6.5 MCP server
`clipboard_push/pull/search` 是独立 HTTP 客户端走同一套 REST，服务端解密后返回 → **`mcp/*` 零改动**（评审确认）。回归测试覆盖一次端到端。

## 7. 平滑升级广播

### 7.1 `server/src/wshub.js`
- 新增并导出 `broadcastAll(payload)`：遍历所有房间发同一帧（复用 `broadcast` 的 OPEN 守卫与 JSON 序列化）。不改认证/心跳/presence。

### 7.2 `server/index.js` 关停（仅改「直接运行」分支）
- `shutdown(sig)`（index.js:128 现为 `await srv.close(); exit`）改为：
  1. **重入守卫**（评审 #15）：模块级 `let closing=false`；已 `closing` 则直接返回，防二次 SIGTERM 期间重复广播/重复 close。
  2. `try { srv.hub.broadcastAll({ type:'sys', kind:'upgrading' }) } catch {}`（`srv.hub` 已在返回对象暴露，index.js:106）。
  3. drain：`await new Promise(r => setTimeout(r, DRAIN_MS))`，`DRAIN_MS = CLIPWARP_SHUTDOWN_DRAIN_MS || 400`。
  4. `await srv.close()`（触发 `onClose`：sweeper.stop + hub.close + db.close）→ `process.exit(0)`。
- 顺序关键：broadcastAll 必须在 `srv.close()`（terminate 全部连接）之前。

### 7.3 前端（落 `Board.jsx`，非 App.jsx，评审 #5/#12）
`Board.jsx` 已持有 `WSClient` 与 `wsOnline` 状态。改动：
- 新增 `everConnected` ref 与 `upgrading` state。
- `onOpen: (isReconnect) => { setWsOnline(true); setUpgrading(false); loadClips(); }`（现忽略 `isReconnect`，ws.js 已透传，无需改 ws.js，评审 #12）。
- `onClose: () => { setWsOnline(false); setDevices([]); }`（不变；断线由现有指数退避重连接管）。
- `onMessage` switch 增 `case 'sys'`：`if (msg.kind === 'upgrading') setUpgrading(true)`。
- 渲染**琥珀色细横幅**（顶部 sticky、半透明、不盖遮罩、不阻断浏览已加载 clip）：`upgrading` → 「服务升级中，稍候自动重连…」；否则 `everConnected && !wsOnline` → 「连接已断开，正在重连…」。（现有 device-bar「连接中…」保留或并入横幅，择一，实现期定。）
- `web/src/styles.css`：横幅样式。

### 7.4 部署脚本（评审 #18/#31）
- `scripts/deploy-launchd.sh`：重启后健康检查由「`sleep 2` + 单次 curl」改为**重试循环**（如 10 次、每次 1.5s，任一成功即过），容忍升级后**首启迁移**带来的较慢就绪。首部署/服务未起仍自动跳过。
- 不移植 CloudClaude 的 `/api/activity` 前置检测（剪贴板无会话状态可丢）。
- README/CHANGELOG 注明：升级前建议手动 `cp clipwarp.db clipwarp.db.bak`（迁移已自动产 `*.pre-m4.bak`，此为双保险）。

## 8. 配置与环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `CLIPWARP_KEY` | 空 | 注入主密钥（64-hex 或 32 字节 base64），优先于 `master.key`；密钥与数据物理分离 |
| `CLIPWARP_SHUTDOWN_DRAIN_MS` | `400` | 升级广播后到关闭的 drain 窗口（ms） |
| `CLIPWARP_HOME` | `~/.config/clipwarp` | 数据父目录；`master.key` 在此目录下 |

- `master.key` 路径 = `path.join(cfg.home, 'master.key')`（**在 `home`，不在 `home/data`**，与 db 分目录，评审 #10/#14）。`createCrypto` 接收 `cfg.home`。
- 测试注入固定密钥：`createServer({ ..., cryptoKey })` → 线程进 `createCrypto({ home, env: cryptoKey ? { ...env, CLIPWARP_KEY: cryptoKey } : env })`（评审 #13，端到端定义单一机制）。测试**优先用 `opts.cryptoKey`，不要改 `process.env.CLIPWARP_KEY`**，避免跨用例 env 泄漏（评审 #32）。`server/index.js` 的 `createServer` 增 `opts.cryptoKey` 透传。

## 9. 测试策略
沿用 `node --test 'test/*.test.js'`（显式 glob）。helpers.startServer 已用 `mkdtempSync` 临时 `home` 并清理 → 生成的 `master.key` 落临时目录、不污染真实 `~/.config`（评审 #32 确认）。

- **`test/crypto.test.js`**（新）：往返（中文/emoji/1MB/空串）；随机 IV；篡改→`cipher-undecryptable`+不抛；截断<28→`plaintext`；旧明文透传；`enc:v1:hello`→`plaintext`+原样返回；`CLIPWARP_KEY` hex 与 base64 各一正确、非法（短/坏/长度≠32）拒绝；生成 `master.key` mode=0o600 + `keySource` 正确；并发 EEXIST 走读取分支。
- **`test/migrate-encrypt.test.js`**（新）：明文行→`enc:v1:`且还原；`cipher-valid` 跳过（幂等二次 `encrypted=0`）；明密混存正确；逐字段（content 已密 + title 明文 → content 不变、title 加密、不二次加密）；`title` NULL 保持 NULL；空串 content/title 往返且与 NULL 区分（评审 #27）；**legacy 明文 `content==='enc:v1:hello'` 经迁移与读取正确还原**；**自检：注入 `cipher-undecryptable` 行（错密钥）→ 迁移抛错中止**；备份文件生成且二次运行不重复备份。
- **`test/m4.test.js`**（新，端到端）：插入后查 DB 原始 `content` 为 `enc:v1:` 且不含明文子串；`GET /api/clips` 返回明文；搜索命中密文内容、Unicode 大小写不敏感（`É` 配 `é`）、account 隔离；**pin 一条 + 推 >CAP unpinned → pinned 仍可搜**（评审 #6）；自动标题（注入假 llm）title 落库密文、API 返回明文；**注入一条损坏行 → 其余 list 仍正常返回**（评审 #7）；burn/TTL 不回归；`broadcastAll` 单测 + 注入 WS 收到 `sys/upgrading`；shutdown 重入守卫不二次广播。
- **回归**：现有 62 测试全绿（经 `opts.cryptoKey` 固定密钥）。预计净增 ~25 用例。`web` 构建通过。

## 10. 发版 v1.0.0
1. `server/package.json` + `web/package.json` + `mcp/package.json`：`0.3.0` → `1.0.0`（已核实当前为 0.3.0，非降级）。
2. `CHANGELOG.md`（评审 #30）：把现有 `## [Unreleased]`（含 M1/M2/M3 历史）切为 `## [1.0.0] - 2026-06-17`，在其上新增 **M4 · v1.0.0** 段（静态加密 / 迁移+自动备份 / 平滑升级 / **升级不可平滑回退 + 备份建议**警告）。
3. `README.md`：标 v1.0.0；新增「加密与密钥」小节（`master.key` 保管、`CLIPWARP_KEY` 注入、与数据分目录、备份建议、不可回退）。
4. `docs/design.md`：勾选 M4、补 at-rest 说明；`docs/api.md`：搜索语义注明内存过滤 + Unicode 大小写不敏感。
5. `.gitignore`（评审 #28）：新增 `master.key` 与 `*.key`（公开仓库 github.com/shiftu/ClipWarp 防误提交密钥）。
6. 部署 `./scripts/deploy-launchd.sh`，首启自动备份+迁移；健康检查重试循环。
7. **发布前置**：手动备份现网 `clipwarp.db` 与 `master.key`（迁移不可逆 + 不可回退；迁移亦自动产 `*.pre-m4.bak` 双保险）。

## 11. 文件改动清单
**新增**
- `server/src/crypto.js`、`server/src/migrate-encrypt.js`
- `server/test/crypto.test.js`、`server/test/migrate-encrypt.test.js`、`server/test/m4.test.js`

**修改**
- `server/index.js` — 装配 crypto（传 `cfg.home`、`opts.cryptoKey`）、调用迁移（fail-fast）、shutdown 加重入守卫+broadcastAll+drain、传 crypto 给 clip 路由
- `server/src/routes-clips.js` — toClip 解密闭包、写入加密、scheduleAutoTitle 加 `crypto`/`toClip` 入参+加密 title、搜索改内存过滤（覆盖全部 pinned，删 escapeLike）
- `server/src/wshub.js` — `broadcastAll`
- `server/src/config.js` —（如需集中）`master.key` 路径常量（`home/master.key`）
- `web/src/components/Board.jsx` — `upgrading`/`everConnected` + onOpen(isReconnect) + `sys` 消息 + 横幅
- `web/src/styles.css` — 横幅样式
- `scripts/deploy-launchd.sh` — 健康检查重试循环
- `server/package.json`、`web/package.json`、`mcp/package.json` — 1.0.0
- `.gitignore` — `master.key`、`*.key`
- `CHANGELOG.md`、`README.md`、`docs/design.md`、`docs/api.md`

**不改**：`sessions.js`、`accounts.js`、`api-tokens.js`、`routes-auth.js`、`routes-admin.js`、`routes-tokens.js`、`sweeper.js`、`secret-detect.js`、`content-type.js`、`llm.js`、`web/src/ws.js`、`mcp/*`。

## 12. 风险与缓解
| 风险 | 缓解 |
|---|---|
| 误用错密钥导致旧密文被二次加密损坏 | **迁移前密钥自检**：出现 `cipher-undecryptable` 即 fail-fast，绝不加密 |
| 单行损坏/解不开 500 整个 feed | `decrypt` 全函数永不抛，损坏行退化显示原存储串 |
| 用户粘贴 `enc:v1:…` 文本被误判 | classify 用 GCM 验证为权威，前缀仅预筛；短文本归 `plaintext` |
| 迁移中途崩溃明密混存 | 事务 + 逐字段幂等 + classify 兼容；先自动备份 |
| 迁移不可逆/不可回退 | 自动 `*.pre-m4.bak` + 手动备份 + 文档显著告警 |
| 测试污染真实 master.key / env 泄漏 | 临时 `home`（helpers 已有）+ `opts.cryptoKey` 注入，禁改 process.env |
| 公开仓库误提交 master.key | `.gitignore` 加 `master.key`/`*.key` |
| 升级首启迁移变慢致部署健康检查误判失败 | deploy 健康检查改重试循环 |
| 密钥与数据同备份则加密失效 | 密钥置 `home`（与 `data/` 分目录）+ `CLIPWARP_KEY` 物理分离 + README |
| node:sqlite 不支持 `db.transaction()` | 迁移用 `BEGIN/COMMIT` 显式事务 |

## 13. 验收标准
1. 全新库与 M3 旧库（含数据）均能启动；旧库存量 clip 自动加密且内容不丢；自动产 `*.pre-m4.bak`。
2. `sqlite3 clipwarp.db 'SELECT content FROM clips LIMIT 5'` 全为 `enc:v1:` 前缀、无明文。
3. Web/MCP 读取、搜索（含 pinned 全覆盖）、自动标题、burn/TTL 行为与 M3 一致或合理超集（搜索 Unicode 大小写不敏感）。
4. 删除 `master.key` 后服务无法解密旧数据；**误设错 `CLIPWARP_KEY` 启动直接 fail-fast 而非损坏数据**。
5. 单条损坏行不影响其余 clip 列表/搜索返回。
6. 线上重启时在线前端先收到「升级中」横幅，断连后自动重连恢复。
7. 服务端测试全绿，`web` 构建通过。
