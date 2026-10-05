# MCP 与 OAuth 兼容层

总管完整管理权限已于 2026-10-05 部署并通过线上验证，详见[权限升级记录](releases/2026-10-05-manager-permissions.md)。

本次扩展新增 `/mcp` 和 OAuth 端点，现有网页、API、Agent Key、Session、通行密钥和自动化脚本继续使用原来的入口与权限。MCP 直接调用现有业务服务，条目、版本、待办、附件和身份管理共用原数据库。无新增 D1 迁移；OAuth 协议状态使用独立的 Cloudflare KV。

实现使用 `@modelcontextprotocol/sdk` 的 Web Standards Streamable HTTP transport 和 `@cloudflare/workers-oauth-provider`。每个请求创建独立的 MCP server，采用无状态、JSON 响应模式；不新增 Durable Objects，不保留跨请求的内存身份或会话。

## 两种连接方式

### 已有 Agent Key

连接地址为 `https://personal-hub.echem.ai/mcp`，在客户端认证配置中填写：

```http
Authorization: Bearer <已有 Agent Key>
```

普通、总管和只读 Agent 继承原角色。管理员登录密钥是网页登录凭据，不能在此直接作为 Bearer Key。客户端配置字段各不相同，应使用支持 Streamable HTTP 和自定义认证请求头的客户端。不要将密钥放在 URL、工具参数或提交到仓库的配置文件里。

客户端不携带 Origin 时可用于服务器或桌面调用；如果携带 Origin，目前仅接受 APP_ORIGIN，拒绝其他浏览器来源。现有 Cookie 不能单独登录 MCP，MCP 也不以 Cookie 作为 Bearer 失败后的回退凭据。

### OAuth

支持 OAuth 的客户端填写相同的 `/mcp` 地址，并选择 OAuth 登录。客户端通过发现元数据找到授权端点。

1. 客户端打开 Personal Hub 授权页。
2. 用户通过原有管理员登录页使用密钥或通行密钥登录，随后返回授权页。
3. 选择已有 Agent 身份，或显式选择管理员身份；勾选允许的操作范围。
4. 确认客户端名称、回调主机及权限，批准或拒绝。
5. 客户端用授权码和 PKCE verifier 获取专用于此 MCP 服务的令牌。

授权页还提供“使用已有 Agent 密钥授权”的入口。原始密钥仅提交给本站，客户端得到独立 OAuth token。授权码流程要求 PKCE S256；回调、客户端、资源和令牌由 OAuth 库验证。支持客户端元数据文档（CIMD）及旧客户端的动态注册（DCR）。

管理员选择 Agent 时，授权关联该身份的一把有效密钥，优先无限期密钥，再选择较新的有效密钥。若无可用密钥，先通过原网页或管理员 MCP 工具签发。撤销这把密钥会使关联 OAuth 访问失效；移除后恢复身份也不会复活被撤销密钥派生的授权。

| Scope | 含义 |
| --- | --- |
| `hub:read` | 当前身份允许的读取操作 |
| `hub:write` | 当前身份允许的内容、待办和上报写入；包含读取 |
| `hub:admin` | 全部管理操作，包含读写；须为管理员或启用的总管身份 |
| `offline_access` | 申请刷新令牌，不赋予业务权限 |

普通身份只能获授 read/write，只读身份只能获授 read；管理员和启用的总管可获授 hub:admin。已有总管密钥直接连接即获得全部管理工具，无需换 Key；已有 OAuth 连接仍受原批准范围约束，需重新授权 hub:admin 才能使用全部管理工具。授权页中的管理权限默认不勾选。最终权限同时受 OAuth scope 和数据库中当前角色、状态及来源授权限制。

访问令牌 1 小时有效。批准 offline_access 后允许刷新，授权最长 30 天；刷新不能扩展原授权或切换目标资源。管理员批准的授权使用单独的 30 天 D1 Session，退出原网页登录不会断开 MCP。修改管理员密钥或撤销用于登录的通行密钥会使相关授权失效。使用 Agent Key 直接批准的授权随该 Key 的到期、撤销和身份状态失效。

## 工具覆盖

工具列表按当前角色和 scope 过滤。即使调用方手动请求不可见工具，也不会获得权限。所有正文更新仍是完整快照；并发冲突后重新读取，不自动覆盖。

| 功能 | MCP tools |
| --- | --- |
| 身份、规则、来源 | `get_identity`, `get_api_documentation`, `list_agents` |
| 条目与版本 | `list_entries`, `get_entry`, `list_entry_versions`, `get_entry_version`, `create_entry`, `append_entry_version` |
| 管理员内容处理 | `get_entry_counts`, `mark_entries_read`, `update_entry_state`, `delete_entry` |
| 待办 | `list_tasks`, `create_task`, `update_task`, `delete_task` |
| Agent 生命周期 | `create_agent`, `update_agent`, `set_agent_status`, `purge_agent`, `report_run` |
| Agent 密钥 | `list_agent_keys`, `issue_agent_key`, `revoke_agent_key` |
| 只读来源授权 | `get_read_access`, `set_read_access` |
| 图片 | `upload_image`, `get_image` |
| 登录安全管理 | `list_passkeys`, `revoke_passkey`, `change_admin_secret` |
| OAuth 授权管理 | `list_oauth_grants`, `revoke_oauth_grant` |

普通 Agent 的 create_entry/upload_image 自动使用自身归属；总管和管理员须指定 agent_id。总管可调用全部管理工具，包括删除、Agent/密钥管理、来源授权、通行密钥撤销、管理员登录密钥修改及 OAuth 授权管理。修改登录密钥仍须验证当前登录密钥。总管保持原身份，版本和附件仍记录其 Agent ID。永久删除 Agent 可能返回 pending，继续调用至 done。

MCP 内容参数复用 API 的 Zod 校验与限制。图片以标准 Base64 上传，最大解码大小 10 MiB，文件签名和归属继续由附件服务验证；MCP 请求预算 15 MiB，以容纳图片编码。get_image 返回鉴权后的 MCP image 内容，不公开 R2 对象。工具业务错误使用 isError=true，并保留 error.code/message/details；HTTP 鉴权失败返回 401，reader 限流返回 429。

网页登录、退出网页登录、设备通行密钥注册和设备验证继续由原有浏览器流程完成。客户端的协议登录和退出通过 OAuth 流程及授权撤销完成；这些流程不包装成让模型处理浏览器认证挑战的工具。

## 授权查看与撤销

“登录与安全”新增“管理 MCP 连接”，访问 `/oauth/connections`。管理员可按身份查看和撤销授权，分页显示。user_id 使用 `admin` 或 `agent_<Agent ID>`；MCP 的 list_oauth_grants/revoke_oauth_grant 使用相同编号。

撤销某个 OAuth grant 不撤销原有 API Key，也不退出原网页。OAuth 协议令牌和授权记录存于 KV，跨位置写入/撤销遵循 KV 的一致性；原身份状态、密钥和读取授权仍从 D1 核验。工具执行前再次核对身份，避免仅沿用读取请求体之前的鉴权结果。

## 本地开发

沿用 README 的 `.dev.vars`、本地迁移与 npm run dev 流程。顶层 wrangler.jsonc 新增 OAUTH_KV 的本地模拟绑定；全零 ID 仅用于本地。使用 `http://localhost:5173/mcp`，不要与 127.0.0.1 混用，因为 APP_ORIGIN、Cookie、OAuth resource 与 WebAuthn RP 必须一致。

新增测试位于 tests/integration/mcp.test.ts 和 tests/unit/oauth-return.test.ts，覆盖 MCP/API 数据共享、角色权限、版本冲突、图片、管理操作、PKCE、资源绑定、刷新、来源变更、撤销和网页登录返回路径。

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

## 上线准备

生产已于 2026-09-30 创建独立的 OAUTH_KV、补齐 env.production 绑定并部署。已验证原管理员登录/API、OAuth PKCE 流程和官方 MCP SDK 只读调用，详见 [发布记录](releases/2026-09-30-mcp-oauth-production.md)。以下创建步骤仅用于尚未配置 OAuth KV 的新环境，不要重复创建生产命名空间。部署守卫会在缺少真实绑定时拒绝发布；原有数据库迁移命令不受此新检查影响。

部署时创建独立命名空间：

```powershell
npx wrangler kv namespace create OAUTH_KV --env production
```

将返回的真实 ID 写到 wrangler.jsonc 的 env.production（不能复用顶层全零值）：

```jsonc
"kv_namespaces": [
  { "binding": "OAUTH_KV", "id": "实际返回的32位namespace ID" }
]
```

保留当前 DB、MEDIA、Secrets 和 APP_ORIGIN。新增路由的 Worker-first 配置已加入；新增 global_fetch_strictly_public 标记用于 CIMD 公网获取保护。随后执行 npm run types、完整检查和 npm run deploy:production。

上线验收至少包括：原网页和现有 API/Key；匿名 MCP 401 challenge；OAuth 发现；一个真实目标客户端的 OAuth 登录、工具列表和调用；读取授权收缩、Key 撤销和 OAuth grant 撤销。Windows Hello 等设备验证仍需真实浏览器/设备测试。

若缺少 OAUTH_KV，新增 OAuth 端点返回明确 503；已有 API、网页及密钥 MCP 仍可运行。生产发布时不应依赖此退化模式，应先补齐真实绑定。

## 维护位置

- src/server/index.ts：只将新增 MCP/OAuth 路径交给兼容层，其余请求继续进入原 Hono app。
- src/server/mcp/transport.ts：传输、认证上下文、reader 限流和私有响应。
- src/server/mcp/tools.ts：工具契约、角色/scope 过滤和业务服务调用。
- src/server/mcp/identity.ts：身份引用、实时核验和独立 OAuth Session。
- src/server/mcp/oauth.ts：协议库装配、授权页面、授权查看及撤销。
- src/server/modules/auth/passkey-management.ts：原网页与 MCP 共用的通行密钥查看/撤销业务。

协议依据：[MCP 授权](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)、[Cloudflare OAuth Provider](https://github.com/cloudflare/workers-oauth-provider)。
