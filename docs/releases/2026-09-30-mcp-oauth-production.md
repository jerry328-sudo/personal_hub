# 2026-09-30 MCP 与 OAuth 生产发布

已按用户授权通过 `npm run deploy:production` 发布本地 MCP/OAuth 兼容层。原网页、API、Agent Key、登录及权限规则继续使用原入口。部署时使用尚未提交的工作区，基准 Git commit 为 `34eb4a2`。

## 生产资源与版本

- 域名：`https://personal-hub.echem.ai`；MCP：`https://personal-hub.echem.ai/mcp`。
- Worker：`personal-hub-production`，Wrangler `4.134.0`。
- 当前 Worker version：`ad69c800-2fba-4606-b958-b3dac3709e20`。
- 发布前 Worker version：`aa2b7769-13e6-4108-af75-19ad5c369def`，保留用于回退。
- 新增 KV：`production-OAUTH_KV`，绑定 `OAUTH_KV`，ID `581727d819cf49fe8c41a70a27fba0cb`。
- D1 沿用 `personal-hub-production`（`93a3fde0-6930-40a3-a983-775a707c1851`）。远程检查无待执行迁移，本次未执行迁移。
- R2 沿用私有桶 `personal-hub-media-production`，未修改附件对象。
- Secret 名称仍为 `ADMIN_LOGIN_SECRET`、`AUTH_PEPPER`，未写入、删除或轮换。

本次没有修改既有业务数据结构、业务记录或 R2 对象；未执行数据恢复、完整联合备份或停用现有 Agent。既有 Worker version 保留，代码回退无需恢复数据库。OAuth 协议注册/授权状态保存在新增 KV；批准授权所需的专用管理员会话沿用现有 D1 会话表。

## 本地凭据

现有管理员密钥和认证 pepper 保存在 Git 忽略的 `.env.production`。Cloudflare CLI OAuth 登录凭据保存在本机 Wrangler 配置中。本次未生成新的固定 MCP 密钥，也未将秘密值写入版本控制或发布记录。服务端所需的原秘密配置继续保存在 Cloudflare Secrets。

OAuth 客户端的访问/刷新令牌由客户端在授权时获得并自行保存，不能事先为所有未来客户端统一生成本地副本。

## 验证

- 本地类型检查、lint 通过，完整测试 13 个文件、127 项通过。
- 新增生产 KV 后重新生成 Worker 类型，修正“缺少 KV 时仍支持密钥 MCP”的测试夹具；随后类型检查、lint 和 13 项 MCP 集成测试再次通过。
- 生产构建与上传成功，首页和引用的前端资源返回 200。
- 原 `/api`、`/api/docs`、管理员 API 匿名请求返回 401；使用现有本地管理员密钥登录后返回 200。
- 匿名 MCP 返回 401 及 OAuth discovery challenge，两个 OAuth 元数据端点返回 200。
- 线上动态客户端注册、授权页、管理员只读授权、state 校验、PKCE S256 换取令牌通过。
- 官方 MCP SDK Streamable HTTP 客户端完成握手、工具列表、`get_identity` 与 `list_agents` 调用；只读 scope 不包含 `create_entry`。
- 已通过授权管理页撤销本次测试授权，并退出测试网页登录会话。测试令牌仅在验证进程内短暂存在，未保留可用的测试访问凭据。

线上验收通过 HTTP 与官方 SDK 执行；未验证特定第三方客户端的交互式 OAuth 页面、Windows Hello 设备流程，以及使用既有 Agent Key 的线上调用。后者已在本地集成测试验证，原有生产 Agent Key 未轮换或撤销。
