# Changelog

## [1.0.0] - 2026-06-18

### M4 · v1.0.0 加固发布
- 静态加密（at-rest）：clip `content`/`title` 以 AES-256-GCM 落盘（每条随机 IV + 认证标签），服务端仍读明文，secret 检测/自动标题/搜索全部保留
- 主密钥：首启自动生成 `~/.config/clipwarp/master.key`（chmod 600，与 `data/` 分目录便于分开备份）；`CLIPWARP_KEY`（64-hex 或 32 字节 base64）可注入覆盖
- 一次性迁移：升级首启把存量明文就地加密；前置密钥自检（错密钥直接 fail-fast 不损坏数据）+ 自动备份 `clipwarp.db.pre-m4.bak`
- 搜索：改内存解密过滤（覆盖全部 pinned，Unicode 大小写不敏感）
- 平滑升级广播：关停先向在线设备广播「升级中」，前端切琥珀重连横幅，骑指数退避重连穿过 bind 间隙
- ⚠️ 升级不可平滑回退：迁移后旧版本无法解密；升级前请备份 `clipwarp.db` 与 `master.key`（迁移亦自动产 `*.pre-m4.bak`）
- 测试：服务端全绿（新增 crypto / 迁移 / m4 端到端 ~25 用例）

### M3 · v0.3.0 AI Native（核心两件）
- MCP server（`mcp/`，stdio）：给 Claude Code 三个工具 `clipboard_push` / `clipboard_pull` / `clipboard_search`，以个人访问令牌 Bearer 认证读写自己的粘贴板（`@modelcontextprotocol/sdk` + zod）
- 个人访问令牌（PAT）：新增 `api_tokens` 表，明文 `cw_pat_<40hex>`（仅创建时返回一次，库内只存 sha256）；`Authorization: Bearer` 与 cookie 并存认证；令牌管理需 cookie 会话（禁止用 PAT 再签发/吊销 PAT）；Web「🔑 令牌」面板创建/列出/吊销
- LLM 自动标题：新 clip 异步调用 llm-gateway（OpenAI 兼容）生成简洁标题，落库并广播 `clip:updated`；网关未配置/超时/出错一律优雅降级，不影响核心同步
- 隐私红线：标记为 `isSensitive` 的 clip 绝不外发 LLM —— 不起标题（语义层同理不做 embedding），secret 永远只留本地
- 关键词搜索：`GET /api/clips/search?q=`（content/title 双字段 LIKE，元字符按字面转义，account 隔离 + 过滤过期）
- 测试：服务端 62/62（+6 条 M3：PAT 认证/隔离、令牌管理需 cookie、吊销失效、搜索、自动标题异步落库 + 敏感不外发 + clip:updated 广播）；MCP smoke 8/8

### M2 · v0.2.0 智能层
- Secret 检测：服务端确定性正则识别密钥/令牌/凭据（PEM/JWT/AWS/GitHub/Slack/Google/Stripe/sk-/Bearer/key=value），命中置 `is_sensitive`；前端默认遮罩，点"显示"揭开，复制无需揭开
- JSON 格式化/高亮：json 类型默认美化（解析失败回退原文），安全 token 高亮（key/string/number/bool 着色，绝不注入 HTML），可一键切原文
- 阅后即焚：建 clip 可选 `burnAfterRead`，复制成功即销毁（DELETE → 广播 `clip:deleted` 全端移除）
- TTL 过期：建 clip 可选 `ttlSeconds`（预设 5分/1时/1天，上限 30 天）；GET 过滤已过期 + 后台 sweeper 周期回收并广播删除；前端倒计时 + 客户端剔除
- DB 迁移：幂等补 `burn_after_read` 列，兼容 M1 旧库
- 测试：服务端 56/56（含 10 条 M2 用例：secret 检测、burn 持久化、TTL/过期过滤、非法 TTL、sweeper 广播、旧库迁移）

### M1 · v0.1.0 核心同步
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
