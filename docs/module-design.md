# Personal Hub 项目模块与函数设计

状态：首版代码已经落地。已确认的单文件交互模板保存在 `design/prototype.html`；仓库根目录 `index.html` 是 Vite/React 应用入口，`src/server/index.ts` 是 Worker 导出入口。Worker 后端、React 页面、D1 迁移、本地 D1/R2 测试和部署脚本均已加入仓库；远程 Cloudflare 资源和生产部署尚未创建或执行。本文同时记录当前实现和仍需远程验收的边界。

需求依据：[产品与架构设计](./design.md)。本文件说明“代码放哪里、函数做什么、调用关系是什么”。接口字段使用 snake_case，TypeScript 内部变量与函数使用 camelCase。

## 1. 整体架构

采用 TypeScript + Hono + React + Vite，单 Worker、单 D1、私有 R2；不使用 Cloudflare Access。监控、调度、语义去重由外部 Agent 完成。

~~~mermaid
flowchart TD
  Browser[浏览器 React 页面] --> Router[Worker / Hono 入口]
  Agent[普通 Agent / 总管 Agent] --> Router
  Router --> Auth[认证与角色检查]
  Auth --> Routes[模块 routes：解析参数和返回 HTTP]
  Routes --> Services[模块 service：业务规则和权限]
  Services --> Repos[模块 repository：参数化 SQL]
  Repos --> D1[(D1)]
  Services --> Storage[附件 storage：对象读写]
  Storage --> R2[(私有 R2)]
  Router --> Assets[前端静态资源]
  Routes --> Discovery[按身份提供 API 文档]
~~~

依赖固定为 routes → service → repository/storage。前端只通过 HTTP 访问服务器。共享类型不导入服务器实现，服务器也不导入 React。总管接口复用同一套 service，不另建“总管数据库”或复制业务模块。

服务函数显式接收 ctx = { env, actor, requestId }；纯工具函数只接收所需参数。数据库函数接收 db 与明确的查询范围。关键写入必须 await 后再回应成功，禁止把提交或删除放入 waitUntil 后直接报告完成。

## 2. 当前实现目录

下列为当前代码树的职责摘要。`node_modules/`、`dist/`、`.wrangler/` 和生成的 Worker 类型文件不属于业务源码，因此不在树中展开。

~~~text
personal_hub/
├── index.html                       Vite/React 应用入口
├── design/                          已确认的原型、说明和参考截图
├── preview.cjs                      原型预览工具，不作为应用运行入口
├── docs/
│   ├── design.md                    需求、业务规则与部署架构
│   ├── module-design.md             本文：实现边界和函数清单
│   ├── development.md               本地开发与验证
│   └── deployment.md                Cloudflare 资源和发布流程
├── scripts/
│   ├── cloudflare-environment.mjs   远程环境完整性校验
│   ├── deploy.mjs                   显式 staging/production 发布守卫
│   └── migrate.mjs                  显式 staging/production 迁移守卫
├── src/
│   ├── shared/
│   │   ├── contracts.ts             可传输的请求/响应类型
│   │   ├── validation.ts            运行时输入校验
│   │   ├── limits.ts                应用层长度/大小/分页限制
│   │   └── markdown.ts              图片引用解析与 URL 规则
│   ├── server/
│   │   ├── index.ts                 Worker 导出入口
│   │   ├── app.ts                   Hono 实例与路由装配
│   │   ├── env.ts                   Binding、Actor、ServiceContext
│   │   ├── bindings.d.ts             Secret Binding 类型补充
│   │   ├── shared/
│   │   │   ├── authorize.ts         角色、归属、生命周期规则
│   │   │   ├── http.ts              Origin、响应头、请求大小
│   │   │   ├── errors.ts            AppError 和错误映射
│   │   │   ├── db.ts                SQL 结果检查和错误分类
│   │   │   ├── pagination.ts        游标编解码与查询匹配
│   │   │   └── ids.ts               实体编号生成
│   │   ├── discovery/
│   │   │   ├── routes.ts            GET /api 和 /api/docs
│   │   │   └── content.ts           固定的分角色使用说明
│   │   └── modules/
│   │       ├── auth/               routes.ts / service.ts / repository.ts / crypto.ts / middleware.ts
│   │       ├── agents/             routes.ts / service.ts / repository.ts / lifecycle.ts
│   │       ├── entries/            routes.ts / service.ts / repository.ts
│   │       ├── tasks/              routes.ts / service.ts / repository.ts
│   │       └── attachments/        index.ts / routes.ts / service.ts / repository.ts / storage.ts / validation.ts
│   └── web/
│       ├── main.tsx                React 挂载
│       ├── App.tsx                 登录态与页面路由
│       ├── api.ts                  HTTP 传输和按模块分组的接口函数
│       ├── pages/                  登录、收件箱、Agent、条目、Agent 管理、待办页面
│       ├── components/             AppShell、三种条目布局、正文、表单和通用 UI
│       ├── hooks/                  useSession.tsx / useEntries.ts / useTheme.ts
│       ├── lib/                    format.ts / theme.ts
│       └── styles/                 tokens.css / app.css
├── migrations/
│   ├── 0001_initial.sql            七张核心表、约束、索引与 manual 分区
│   └── 0002_attachment_upload_leases.sql  在途附件上传租约
├── tests/
│   ├── setup.ts                    每个隔离测试存储的迁移初始化
│   ├── unit/                       鉴权、校验、Markdown、游标、主题测试
│   └── integration/                Worker + D1 + R2 API 和附件集成测试
├── package.json                    开发、检查、迁移与部署命令
├── eslint.config.js                TypeScript、React、Promise 与部署脚本规则
├── tsconfig.json                   严格 TypeScript 配置
├── vite.config.ts                  React + Cloudflare Vite 构建
├── vitest.config.ts                Workers 测试池与隔离存储
├── wrangler.jsonc                  本地 Binding；远程环境按部署手册填写
├── .dev.vars.example               仅变量名与假值，实际秘密不入库
└── .gitignore                      构建、秘密和本地状态忽略规则
~~~

项目没有使用 monorepo、通用插件系统、通用 CRUD 基类、ORM 或依赖注入容器。四个业务模块保持少量文件，出现独立职责后再拆。

## 3. 公共数据契约与输入校验

### 3.1 contracts.ts

| 类型 | 必要内容 |
| --- | --- |
| AgentDto | id、name、description、scope、status、deleting_at、display_mode、main_entry_id、最近上报与创建时间 |
| EntryStateDto | archived、read_version、completed、completed_at |
| EntryBriefDto | id、agent_id、created_at、当前 version/title/important/updated_at/created_by_agent_id、完整处理状态 |
| EntryFullDto | brief 的全部字段 + 当前 content、url |
| EntryVersionDto | 指定版本完整内容 + 当前 EntryStateDto；说明状态不属于历史快照 |
| EntryVersionBriefDto | 历史目录中的 entry_id、version、title、important、created_by_agent_id、created_at |
| TaskDto | id、agent_id、entry_id、title、done、due_at、created_at |
| AttachmentDto | id、agent_id、url、filename、content_type、size、created_at；不返回 object_key |
| Page<T> | items、next_cursor；空游标明确表示结束 |
| ApiErrorBody | error: { code, message, request_id, details? } |
| CreateEntryInput | title、content、url?、important? |
| AppendVersionInput | CreateEntryInput + base_version |
| PatchEntryStateInput | read_version?、archived?、completed?；至少一个字段 |
| CreateTaskInput / PatchTaskInput | 标题、截止时间、完成状态；创建时可选来源或目标，更新不可改变归属 |
| CreateAgentInput / UpdateAgentInput | 名称、说明、布局、主报告；scope 与首把密钥到期时间只在创建时指定 |
| IssuedKeyDto | 返回 id、agent_id、secret（仅本次）、created_at、expires_at；签发输入 IssueKeyInput 定义在 auth/service.ts |
| AgentKeyMetadataDto | id、agent_id、created_at、expires_at、revoked_at、last_used_at；不返回 secret 或摘要 |
| SessionDto | 响应仅登录状态与到期时间，不返回 Cookie 明文；登录输入 LoginInput 定义在 auth/service.ts |
| ReportInput | result: success/failed、note?；上报时间由服务器生成 |
| PurgeProgressDto | agent_id、status: pending/done、removed_objects、remaining_objects |

编号均为不透明字符串，时间使用 UTC ISO 8601；D1 的 0/1 转为 JSON boolean。DTO 不暴露 secret_hash、token_hash、Cookie、pepper 或管理员密钥。

### 3.2 validation.ts / limits.ts / markdown.ts

- `createAgentSchema`、`updateAgentSchema`、`issueKeySchema`：严格校验字段与枚举；各模块路由用自己的薄解析函数调用这些共享 schema。
- `createEntrySchema`、`appendVersionSchema`、`patchEntryStateSchema`：拒绝正文接口夹带 `completed`、`agent_id`、`created_by_agent_id` 等不可写字段。
- `createTaskSchema`、`patchTaskSchema`、`reportSchema`、`loginSchema`：校验日期、布尔值、状态、密钥输入和长度。
- `entryQuerySchema`、`taskQuerySchema`：校验筛选、`limit` 和游标的输入形态；角色默认值和游标指纹在对应 service 中确定。
- `attachmentIdFromUrl`、`extractAttachmentIds`、`findUnsupportedImageUrls`：识别行内、完整引用式与折叠引用式图片，跳过 fenced/inline code 中的示例，只允许本站媒体 URL。
- `isAllowedLink`：正文普通链接只允许以 `/` 开头的站内根相对地址及 `http`/`https`；React Markdown 渲染层同时禁用原始 HTML。

应用默认值集中在 limits.ts：标题 200 字符、Markdown 256 KiB UTF-8、图片 10 MiB、JSON 请求 320 KiB、multipart 请求上限 11 MiB、列表默认 20 条/最多 100 条、JSON 响应预算 2 MiB。它们是本项目约定，不是 Cloudflare 套餐上限。用 UTF-8 字节和实际编码后的响应大小判断；大响应减少本页数量并返回游标，不能截断某篇正文，也不能因为预算返回空页而重复同一游标。

## 4. Worker 入口与公共基础设施

### 4.1 环境与应用装配

生成的 `worker-configuration.d.ts` 声明 `DB`、`MEDIA`、`ASSETS`、`LOGIN_RATE_LIMITER` 和非秘密 vars；`bindings.d.ts` 补充 Secrets `ADMIN_LOGIN_SECRET`、`AUTH_PEPPER`。前端不导入服务器 Env。

`index.ts` 只导出 `app`；`app.ts` 构造 Hono 应用，统一注册请求编号、私有响应头、认证、API 模块、JSON 404、错误映射和 `ASSETS` 回退。

`/api` 与 `/api/*` 先经过 Worker；静态资源和页面路径由 Assets 直接提供或执行 SPA 回退。静态 React 壳可匿名读取，应用挂载后依据 Session 将未登录用户导航到登录页；私有数据只从鉴权 API 获取。任何已认证但未匹配的 API 请求返回 JSON 404。[Worker-first 路由](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)由 Cloudflare Vite 插件和 `wrangler.jsonc` 的两条 API 规则实现。

| 文件 | 函数 | 责任 |
| --- | --- | --- |
| http.ts | createRequestId() | 创建不含用户数据的跟踪编号 |
| http.ts | requireSameOrigin(request, origin) | 登录及 Cookie 认证的写操作必须同源；缺失或不符都拒绝 |
| http.ts | readLimitedJson(request, maxBytes) | 按实际读取字节限制请求，解析失败返回 400 |
| http.ts | applyPrivateHeaders(headers) | 私有 API/media/auth 返回 no-store 与必要安全响应头 |
| errors.ts | errorBody(error, requestId)、normalizeError(error) | 统一 400/401/403/404/409/413/415/429/500；不回显 SQL 或堆栈 |
| db.ts | requireChanged(result)、isUniqueConstraintError(error)、boolFromDb(value) | 验证条件写入结果，识别预期唯一约束冲突，转换 D1 布尔值 |
| pagination.ts | queryFingerprint(query)、encodeCursor(value, fingerprint)、decodeCursor(text, fingerprint) | 绑定排序与筛选条件；游标不赋予任何权限 |
| ids.ts | newEntityId(prefix) | 生成不含秘密的唯一 ID |

不要实现不存在的“可跨请求 D1 事务”或在 repository 中直接拼用户 SQL。动态 ORDER BY 只能从白名单选择，其余全部参数绑定。

### 4.2 可信身份与权限函数

Actor 是服务器内部判别联合类型：
- AdminActor：type=admin、sessionId。
- AgentActor：type=agent、agentId、scope=own/all、status、keyId。
- 普通 Agent 的 owner 必须由 actor.agentId 得到，忽略不了非法 owner 字段，应直接拒绝。
- 总管创建时目标来自已校验路径，更新时目标来自既有条目；操作者来自 actor。
- 管理员写版本的 created_by_agent_id 为保留标识 manual。

authorize.ts：
- `requireAdminActor(actor)`：仅网页管理员。
- `requireOwnAgentActor(actor)`：仅 `scope=own` 的机器身份。
- `requireManagerActor(actor)`：仅 `scope=all` 且启用的总管。
- `resolveReadScope(actor, requestedAgentId?)` → `{ kind: "own", agentId }` 或 `{ kind: "all", agentId? }`。
- assertCanReadOwner(actor, ownerId)：普通仅自己，总管和管理员可读其他来源。
- `assertCanWriteOwner(actor, ownerId)`：先验证角色和 owner 范围；service 与条件 SQL 再检查目标生命周期。
- `createdByActor(actor)`：管理员返回 `manual`，Agent 返回自身编号，供版本和附件记录操作者。

路由拒绝角色不符返回 403。普通 Agent 按 ID 查询自己的资源时，用含 owner 的 SQL；不存在与越权统一返回 404，避免先查出其他人的对象再泄漏存在性。跨 Agent 管理不意味着可管理凭据或会话。

## 5. 认证模块 auth

routes.ts 注册下表入口；service 负责会话和密钥策略，crypto 不接触业务正文，repository 只保存摘要。

| 入口 | service 函数 | 输入 → 结果及边界 |
| --- | --- | --- |
| POST /api/v1/auth/login | loginAdmin(env, request, input) | 路由验证 Origin；service 对每次登录请求限流并验证管理员密钥，插入 Session，返回 Session 与 HttpOnly Cookie |
| GET /api/v1/auth/session | getAdminSession(ctx) | 当前会话信息；无会话 401 |
| POST /api/v1/auth/logout | logoutAdmin(ctx) | 撤销当前 Session 并清 Cookie |
| POST /api/v1/admin/agents/:id/keys | issueAgentKey(ctx, agentId, input) | 仅管理员；返回一次明文，禁止超出有效密钥数量 |
| GET /api/v1/admin/agents/:id/keys | listAgentKeys(ctx, agentId) | 仅元数据，无摘要/明文 |
| DELETE /api/v1/admin/agents/:id/keys/:keyId | revokeAgentKey(ctx, agentId, keyId) | 目标归属匹配，幂等撤销 |

内部函数：
- authenticateBearer(env, token) → AgentActor：解析 key ID，验证 HMAC、撤销、到期、Agent 状态。
- authenticateSession(env, token) → AdminActor：解析已经从 Cookie 提取的随机 Session token，验证摘要与有效期。
- authenticateRequest(request, env) → Actor | null：解析一种凭据；同时携带两种凭据时拒绝歧义，不在 Bearer 失败后回退 Cookie。角色白名单由 middleware 检查。
- prepareAgentKey(env, agentId, expiresAt?, createdAt?) → { record, plaintext, prepareInsert }：生成摘要与明文但不保存，用于新建 Agent 的原子批次。
- checkLoginRateLimit(env, request) → void：对可信来源 IP 做登录尝试限流，不将提交的密钥作为键。
- middleware.ts：requireIdentity(roles)、requireAdminSession()、requireAgentKey(scope)。

crypto.ts：
- generateSecret(bytes=32) → 高熵 base64url 字符串。
- hashCredential(kind, id, secret, pepper) → HMAC 摘要；agent/session 用不同域前缀。
- verifyCredential(kind, id, secret, digest, pepper) → boolean，使用 Web Crypto 验证，不做普通字符串秘密比较。
- verifyAdminSecret(candidate, configuredSecret) → boolean；长度受限，比较不可早停泄漏匹配前缀。
- formatAgentKey(id, secret)、parseAgentKey(text)：ID 格式不得与分隔符歧义。
- buildSessionCookie(token, expiresAt)、clearSessionCookie()：Secure、HttpOnly、SameSite=Strict、Path=/、无 Domain，名称 __Host-ph_session。

repository.ts：
findKeyWithAgent、insertKey、listKeyMetadata、revokeKey、revokeAgentKeys、touchKeyUsage、insertSession、findSession、revokeSession、deleteExpiredSessions。新建 Agent 的 key 写入提供 prepareInsertKey() 语句供外层 batch，不嵌套提交。

密钥最多两把未撤销且未过期的记录以便轮换；限额在数据库写入条件内执行，不能只做事前计数。总管密钥要求 expires_at；普通密钥允许明确的空有效期。Session 默认按 `SESSION_TTL_SECONDS=604800` 设置为 7 天绝对有效期，不做滑动续期。凭据每次从 D1 核验，不加会导致撤销延迟的缓存。

登录限流使用 Workers 的 Rate Limiting binding，不新增 KV 或业务表。Binding 的 `limit()` 调用会消费额度，因此当前实现限制同一来源的全部登录请求（成功和失败都会计数）。它是按位置的近似限流，不能声称是全球精确计数。[官方限制与行为](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)

## 6. Agent 模块 agents

### 6.1 状态落库

将原先概念字段 enabled 细化为 status: active | disabled | removed | deleting，加 deleting_at。UI 的启停由 status 派生，不再另存 enabled。这样可以表示模板已有的移除/恢复，并支持中断后的 R2 删除重试。

- active：正常写入。
- disabled：普通 Agent 可读取自身资料以确认停用，业务读写拒绝；总管业务请求全部拒绝。
- removed：隐藏日常导航，历史可由管理员/启用总管读取；撤销全部密钥，禁止内容写入。
- deleting：撤销全部密钥，阻止所有角色向该目标写入，等待图片清理；只允许管理员继续删除和读清理状态。
- 恢复 removed → disabled，管理员签发新密钥并启用后恢复执行，旧密钥永远不复活。
- manual 是保留的手动分区，不能签发 Agent 密钥、停用、移除、删除或升级总管。
- 总管是身份记录，不是消息分区，不能作为创建条目/待办/图片的 owner。scope 创建后不变；需要更换总管时先停用旧身份，再创建并启用新身份。

### 6.2 函数与接口

| 入口 | 实现函数 | 说明 |
| --- | --- | --- |
| GET /api/v1/admin/agents | listAgents(ctx, query, "admin") | 含管理字段，可显式查询 removed/deleting |
| POST /api/v1/admin/agents | createAgent(ctx, input) | Agent 与首把 key 同一个 D1 batch，成功后只返回一次明文 |
| PATCH /api/v1/admin/agents/:id | updateAgent(ctx, id, input) | 名称、说明、display_mode、main_entry_id；验证主报告归属 |
| POST /api/v1/admin/agents/:id/enable | enableAgent(ctx, id) | disabled → active，总管唯一性由 DB 保证 |
| POST /api/v1/admin/agents/:id/disable | disableAgent(ctx, id) | active → disabled；不删除数据或密钥 |
| POST /api/v1/admin/agents/:id/remove | removeAgent(ctx, id) | 转 removed 与撤销所有 key 同一批次 |
| POST /api/v1/admin/agents/:id/restore | restoreAgent(ctx, id) | removed → disabled |
| DELETE /api/v1/admin/agents/:id | purgeAgentStep(ctx, id, dependencies) | 注入附件清理步骤，可重复调用；未完成返回 202 和进度，完成返回 200 |
| GET /api/v1/agent | getSelfAgent(ctx) | 普通 Agent 自身说明 |
| GET /api/v1/manager/agents | listAgents(ctx, query, "manager") | 状态和配置，不含密钥 |
| POST /api/v1/agent/report 或 /api/v1/manager/report | reportRun(ctx, input) | 更新调用者最近结果，时间取服务器 |

repository.ts：listAgents、findAgent、createAgentAndKeyBatch、agentOwnsEntry、updateAgentConfig、setAgentStatus、removeAndRevokeBatch、beginAgentDeletionBatch、updateLastReport、countAgentAttachments、finalizeAgentDeletionBatch。

lifecycle.ts：beginAgentPurge、purgeAgentStep、finalizeAgentPurge。该文件协调跨模块清理，业务 service 不互相循环导入；它调用注入的附件清理操作，并通过 agents repository 执行生命周期查询与最终 D1 batch。

删除步骤：先持久化 deleting 并撤销凭据 → 等待有界在途上传结束 → 分批清理该 Agent R2 前缀及附件元数据 → 最后一个 D1 batch 清除条目/版本/密钥/Agent 并迁移待办。中途失败保留 deleting 及剩余元数据，管理页重试；不先删 Agent 再寻找失联对象。无队列，不宣称请求结束后会自动继续。

## 7. 条目模块 entries

### 7.1 service 函数

| 函数 | 输入 → 返回 | 核心约束 |
| --- | --- | --- |
| listEntries(ctx, query, audience) | 筛选/游标 → Page<Brief或Full> | 普通默认 full 且包含归档/完成；总管默认 brief；网页显式指定 |
| getEntry(ctx, entryId) | ID → EntryFullDto | 在数据查询中约束 owner |
| createEntry(ctx, targetAgentId, input) | 完整内容 → {id, version:1} | 归属和图片校验；条目+v1 原子创建 |
| appendEntryVersion(ctx, entryId, input) | 完整快照+base_version → {id, version} | 条件写入，冲突 409，保留处理状态 |
| listEntryVersions(ctx, entryId, page) | ID → 历史目录分页 | 目录不批量返回历史正文 |
| getEntryVersion(ctx, entryId, version) | ID/版号 → EntryVersionDto | 历史快照和当前状态明确分离 |
| updateEntryState(ctx, entryId, input) | 状态补丁 → EntryStateDto | 仅管理员，不产生版本 |
| deleteEntry(ctx, entryId) | ID → void | 仅管理员；删整条及版本，保留待办并解除来源 |

repository.ts：
- listCurrentEntries(db, scope, query)、findCurrentEntry(db, scope, id)：集合查询最新版本，避免 N+1。
- prepareCreateEntry(...)、prepareCreateInitialVersion(...)、createEntryBatch(...)：创建边界。
- insertVersionIfCurrent(db, scope, entryId, input, actorId, createdAt)：单 SQL 条件 INSERT；返回是否插入。
- findCurrentVersionNumber(...)、listVersions(...)、findVersion(...)。
- patchEntryState(...)：只更新显式允许字段，read_version 单调不减且不得超过当前版本。
- deleteEntryBatch(...)：同时清主报告引用、待办来源、条目及版本。

### 7.2 版本写入边界

实现形状为 INSERT INTO entry_versions (...) SELECT ... WHERE 当前 MAX(version)=base_version AND owner/生命周期仍有效；(entry_id, version) 建唯一约束。不能采用先 SELECT 然后无条件 INSERT。

只有插入成功才能回复成功。无插入时再次读取得到“当前可见版本号”用于 409，或资源不可见 404、生命周期禁止 403；并发导致的同条目版号唯一冲突映射到 409，其他数据库错误不能都伪装成版本冲突。

原子创建和删除使用 D1 batch；其语句错误会回滚，但条件 SQL 的 0 行不等于错误。组合语句必须相互依赖并检查预期行数，禁止 batch 没报错就认为全部成功。[D1 batch 语义](https://developers.cloudflare.com/d1/worker-api/d1-database/)。

标记完成：false → true 时记录服务器时间，重复 true 保留原 completed_at；恢复 false 清空时间。已读更新用 MAX(existing, submitted)，打开旧版不能让 read_version 倒退。正文更新不触碰 archived/read_version/completed/completed_at。

### 7.3 分页与默认值

API 按 id 稳定游标分页；清单页面可指定 created_at,id 升序，全局信息流按最新版本 created_at,id 降序，均带 ID 作相同时间的次级排序。所有游标携带排序模式与筛选指纹；更换条件后必须从第一页读取。

不提供跨页快照保证，尤其按更新时间排序时并发追加可能移动结果；网页刷新重新取数，Agent 一轮使用稳定 id 排序并串行完成“读取—比较—写入”。归档/已完成从来不是删除，也不是机器读取的隐式排除条件。

## 8. 待办模块 tasks

service.ts：
- listTasks(ctx, query) → Page<TaskDto>：根据角色和 owner 查询。
- createTask(ctx, input) → TaskDto：有关联条目时 owner 从条目读取；普通 Agent 只能创建自己任务；管理员无来源默认 manual；总管无来源需明确目标。
- updateTask(ctx, id, input) → TaskDto：只更新 title/due_at/done，不允许改归属和来源。
- deleteTask(ctx, id) → void：普通 Agent 可删除自身，管理员可删除全部，总管首版不开放删除入口。

repository.ts：listTasks、findTask、insertTask、patchTask、deleteTask、prepareDetachEntryTasks、prepareMoveAgentTasksToManual。

删除单条条目：任务仍属原 Agent，entry_id 置空。删除整个 Agent：任务迁移 manual、entry_id 置空。原子清理在调用方同一个 batch 中完成，不能先删除再补救。条目完成与任务完成不互相调用。

## 9. 附件模块 attachments

### 9.1 函数

| 文件 | 函数 | 责任 |
| --- | --- | --- |
| routes.ts | registerAttachmentRoutes(app) | 三种上传入口和 GET /api/v1/media/:id |
| service.ts | uploadAttachment(ctx, ownerId, request) | 有界读取、校验、R2 上传、D1 记录、失败补偿 |
| service.ts | getAttachmentMedia(ctx, id) | 身份/归属检查后读取对象并返回受保护 Response |
| service.ts | validateEntryAttachments(ctx, ownerId, markdown) | 批量查引用，所有图片均属于目标 Agent |
| service.ts | purgeAgentAttachmentsStep(ctx, agentId, limit) | 只在 deleting 状态允许，返回待清理进度 |
| validation.ts | readImageUpload(request)、detectImageType(bytes)、validateImageUpload(file) | 实际大小和魔数校验；声明类型与实测类型匹配 |
| repository.ts | acquireAttachmentUploadLease、commitAttachmentMetadata、releaseAttachmentUploadLease | R2 写入前登记租约，元数据与成功租约释放同批提交 |
| repository.ts | findAttachment、findAttachmentsByIds、listExpiredAttachmentUploadLeases、findActiveUploadLeaseObjectKeys、cleanupDeletedAttachmentObject | 参数化查询、引用归属与可恢复清理 |
| storage.ts | makeObjectKey、putImage、getImage、deleteImage、listAgentObjects | R2 Binding 薄封装，对象按 Agent 前缀组织 |
| storage.ts | compensateFailedUpload(bucket, objectKey, requestId) | D1 失败后尝试删除；失败日志只记对象键/编号 |

### 9.2 上传、显示和删除一致性

1. 验证调用者和目标状态，再按流实际字节限制 multipart；不能仅相信 Content-Length。
2. 仅 PNG/JPEG/WebP/GIF；检查文件格式签名与基本头部，文件名只用于显示。首版不承诺图片转码或完整解码验证。
3. 服务端生成不可覆盖的随机对象键；任何 R2 写入前，先在 D1 为 `active + scope=own` 的目标登记有期限上传租约。
4. R2 写入成功后，D1 在同一 batch 中条件插入附件元数据并释放租约；目标状态改变时补偿 R2，只有对象确认删除后才单独释放失败租约。
5. 成功返回稳定相对 URL /api/v1/media/:id；数据库内部对象键不得由用户指定。
6. 媒体读取先校验 actor/owner，再获取 R2；设置真实 Content-Type、nosniff、private,no-store。错误不回退 HTML。
7. 上传和正文写入是两次操作；允许暂时未被引用的附件存在。不覆盖对象，不在删除单条信息时回收附件。
8. 整个 Agent 删除时先保留未到期租约，回收过期租约，再查附件元数据并扫描 R2 前缀。对象删除成功才移除相应元数据和租约，可重复操作。

D1 与 R2 没有跨存储事务。当前实现用持久化租约记录对象键和到期时间；`deleting` 目标在有效租约排空、附件元数据与 R2 前缀均为空之前保持 `pending`。撤销密钥不被当作自动终止已执行请求，崩溃遗留的过期租约由后续删除重试回收。

服务端由 attachments/validation.ts 提取所有 Markdown 图片 URL，并用 shared/markdown.ts 的规范媒体 ID 规则核对归属；前端 MarkdownContent.tsx 独立执行同样的同源媒体限制。Markdown 原始 HTML 禁用；图片只允许本站 /api/v1/media/:id，普通外链仅允许 http/https，外部图片由执行器先上传。媒体 URL 不含 Bearer Key。

## 10. 路由如何复用函数

各模块 routes.ts 导出显式注册函数：多数接收 app，Agent 模块的 `registerAgentRoutes(app, dependencies)` 额外接收附件清理依赖。注册函数统一在 app.ts 中调用；不用反射扫描目录。

| 能力 | 普通 Agent 前缀 /api/v1/agent | 总管前缀 /api/v1/manager | 管理员前缀 /api/v1/admin | 复用函数 |
| --- | --- | --- | --- | --- |
| 列表/详情 | /entries、/entries/:id | 同左 | 同左 | listEntries / getEntry |
| 创建 | POST /entries | POST /agents/:id/entries | POST /agents/:id/entries | createEntry |
| 追加版本 | POST /entries/:id/versions | 同左 | 同左 | appendEntryVersion |
| 历史目录/详情 | GET /entries/:id/versions[/:version] | 同左 | 同左 | listEntryVersions / getEntryVersion |
| 状态修改 | 无 | 无 | PATCH /entries/:id/state | updateEntryState |
| 永久删条目 | 无 | 无 | DELETE /entries/:id | deleteEntry |
| 待办列表/创建 | GET/POST /tasks | 同左 | 同左 | listTasks / createTask |
| 待办修改 | PATCH /tasks/:id | 同左 | 同左 | updateTask |
| 待办删除 | DELETE /tasks/:id | 无 | DELETE /tasks/:id | deleteTask |
| 图片上传 | POST /attachments | POST /agents/:id/attachments | 同左 | uploadAttachment |

GET /api、GET /api/docs 和 GET /api/v1/media/:id 接受三类身份；其余路由不混用 Session 与 Agent Key。总管使用 /manager，普通使用 /agent，互不通过篡改前缀提升权限。

discovery/content.ts：getQuickStart(actor)、getFullApiDocs(actor)。说明固定维护，明确读取已完成/归档、分页、base_version、写超时核对、图片上传。docs 响应不插入上传正文或用户自定义“指令”。

## 11. 前端模块与函数

### 11.1 页面与组件

| 文件/组件 | 责任与调用 |
| --- | --- |
| App.tsx / App | 初始化 Session、按登录态组织页面路由；无 Session 时进入登录页 |
| LoginPage | submit(event) 调用 Session context 的 login；成功后清除输入状态并进入来源页或收件箱，不保存管理员密钥 |
| InboxPage | 全局筛选与信息流；useEntries 提供当前页摘要，选中条目后由 EntryReader 单独读取完整详情 |
| AgentPage | 读取 Agent 配置，按 display_mode 选择 FeedView/ListView/ReportView |
| EntryPage | 单条与历史详情，手机独立阅读入口 |
| AgentsPage | 新建、配置、启停、移除、恢复、分步删除、密钥管理 |
| TasksPage | 待办列表、创建、完成和删除 |
| AppShell（含内联侧栏） | 导航、Agent 列表、主题选择、退出 |
| FeedView | 日期分组和条目选择；阅读区及窄屏层级由 InboxPage/AgentPage 组合 |
| ListView | 稳定清单，单条展开、独立完成 checkbox |
| ReportView | 主报告和切换器，无固定左侧条目列表 |
| EntryReader | 当前/历史正文；通过 mutateState 更新已读、完成和归档，并可创建待办、上传图片、恢复历史版本 |
| EntryReader 内版本选择器 | 选择实际版本，不自动把后台最新版本标为已读 |
| MarkdownContent / AttachmentImage | 受限 Markdown、同源私有图片、失败占位和点击放大 |
| AgentForm / KeysDialog / IssuedKeyDialog | 配置、密钥列表和一次性明文展示；关闭明文弹窗后清除前端临时状态 |
| TaskForm / ConfirmDialog | 简单表单、删除确认 |
| AppShell 主题选择器 | 夜间模式、日间模式、随系统 |

函数名体现行为，不新增万能 dispatchAction(action, payload) 混合所有业务。

### 11.2 请求、状态和主题

api.ts：
- requestJson<T>(path, options) → Promise<T>：只访问同源、携带 Cookie、处理错误体。
- attachmentsApi.upload(agentId, file) → AttachmentDto：multipart，不手动设置错误的 boundary。
- sessionApi.login/get/logout；agentsApi.list/listAll/create/update/enable/disable/remove/restore/purgeStep。
- keysApi.list/issue/revoke；entriesApi.list/get/create/appendVersion/listVersions/getVersion/setState/delete。
- tasksApi.list/create/update/delete。读取可取消，POST/PATCH/DELETE 不盲目自动重试。
- notifyDataChanged() 通知页面重新读取已变更数据；AppShell 导出的 useAppShell() 提供共享 Agent 目录与刷新函数。
- UI 将 409 与网络错误显示为明确提示，不对 POST/PATCH/DELETE 自动重试；条目编辑使用当前 `base_version`，冲突后由用户刷新再提交。

hooks/useSession.tsx：useSession() → session/loading/error/login/logout；只保存 Session 摘要信息，不接触 HttpOnly Cookie。
hooks/useEntries.ts：useEntries(query) → items/loading/loadingMore/error/nextCursor/loadMore/refresh；AbortController 取消旧筛选请求，写后刷新受影响详情/列表。
hooks/useTheme.ts：useTheme() → mode/resolvedTheme/setMode；注册并清理系统主题监听器。
lib/theme.ts：readThemePreference()、resolveTheme(mode, prefersDark)、applyTheme(theme)、saveThemePreference(mode)。
components/MarkdownContent.tsx：MarkdownContent、isAllowedLink(url)、resolveMediaUrl(url)；跳过原始 HTML，仅允许 HTTP(S) 链接和本站受保护媒体 URL。

主题继续使用模板已有 personal-hub-theme 本地键，默认 system；首屏 React 挂载前设置 data-theme，显式 light/dark 不受系统变化覆盖。localStorage 不可用仍可在本次页面切换。styles/tokens.css 管理颜色变量，app.css 管理结构，不对图片做反色。

当前页面不会把私人正文、图片或密钥复制到 localStorage；本地只保留主题等界面偏好。完成、已读、归档、布局均保存到服务器，页面等待变更成功后再更新状态，避免误报已保存。

## 12. 数据库迁移与约束

`migrations/0001_initial.sql` 已创建七张核心表、必要索引与保留的 `manual` 行；`0002_attachment_upload_leases.sql` 增加上传租约表。应用启动时不隐式改结构。

相对原需求结构的具体化：
- agents 使用 status 代替 enabled，增加 deleting_at；状态转换由 service 控制。
- entry_versions 的 (entry_id, version) 是主键或唯一键，version >= 1。
- entries 加 UNIQUE(id, agent_id)，tasks 的 (entry_id, agent_id) 可用组合外键防止来源跨 Agent；无来源时 entry_id=NULL。
- agents.main_entry_id 的同属校验在写入条件中完成，删除条目前同批次清空引用，避免循环级联。
- created_by_agent_id 保存历史身份字符串，不对 agents 设置级联删除；删除操作者不会删掉其他来源的历史。
- completed 与 completed_at 的空值关系、scope/status/display_mode 枚举、布尔值用 CHECK 约束。
- 建立仅对 scope=all 且 status=active 的唯一部分索引，阻止并发启用两个总管。
- `agent_keys.id` 与 `secret_hash` 不公开，`admin_sessions.token_hash` 不公开；Session 和 Agent key 的查找键均有索引，哈希字段不用于明文检索。
- entries(agent_id,id)、entries(agent_id,created_at,id)、entry_versions(entry_id,version)、tasks(agent_id,done,id)、attachments(agent_id,id) 是首批索引。
- 删除 Agent 不直接依赖 CASCADE 完成业务：先清 R2、迁移待办、清主报告，再在一个批次删除归属数据。
- 原型示例数据只保留在 `design/prototype.html`，生产初始库不预塞个人监控内容或示例秘密。

## 13. 关键流程的调用顺序

**新增 Agent**：AgentsPage → agentsApi.create → auth 管理员验证 → agents.createAgent → auth.prepareAgentKey → repository.createAgentAndKeyBatch → 一次明文弹窗。

**机器追加版本**：Bearer 认证 → 角色和 owner 解析 → appendVersionSchema + parseJson → validateEntryAttachments → insertVersionIfCurrent → 成功返回版本号 / 冲突返回 409。完成状态完全不参与正文写入。

**手动完成**：EntryReader/ListView → entriesApi.setState → 管理员 + Origin → updateEntryState → patchEntryState → 刷新 UI。下轮 Agent 的默认 full 列表继续包含该条及 completed_at。

**图片展示**：上传接口 → R2 和 D1 成功 → 将受保护 URL 写入正文 → MarkdownContent 渲染同源 img → Cookie 认证 → getAttachmentMedia → R2。浏览器不需要读取 Session Cookie。

**恢复旧正文**：getEntryVersion → 用户明确提交完整快照和刚读取的当前 base_version → appendEntryVersion。旧版本和处理状态保持不变。

## 14. 实现次序与完成标准

| 阶段 | 编码范围 | 进入下一阶段的标准 |
| --- | --- | --- |
| 1 工程基础 | package/config、类型、迁移、app/error、测试环境 | 本地 Worker 可运行，API 404 不返回 HTML，七张表迁移成功 |
| 2 认证与 Agent | Session、独立密钥、权限、Agent 状态/配置 | 普通/总管/管理员隔离，撤销/过期生效，并发唯一总管受约束 |
| 3 条目与待办 | 原子创建、条件追加、分页、处理状态、任务 | 并发追加只有一个成功；完成状态可被 Agent 读取且新版本保留 |
| 4 图片与清理 | 上传校验、私有读取、正文引用、删除补偿 | 越权读图拒绝，历史不变，R2/D1 故障和删除竞态可恢复 |
| 5 真实网页 | 将模板迁移 React，接 API、三布局、主题 | 桌面/手机主要流程、历史版已读、主题持久化正确 |
| 6 发布说明 | 分角色 API 文档、测试/生产绑定、备份恢复 | 隔离环境验收、数据库和图片共同恢复演练完成 |

阶段 1–5 的本地实现和阶段 6 的部署文档已经落地；本地迁移、API、React 页面与自动化测试可运行。真实 Cloudflare staging/production 资源、远程迁移、浏览器验收和生产发布尚未执行。

## 15. 测试按风险组织

- unit：请求校验、游标非法/条件变更、凭据处理、图片引用解析（含引用式图片/代码块）、主题优先级。
- `integration/api.test.ts`：Session 与密钥生命周期、普通/总管/管理员隔离、manual 管理、版本冲突、完成状态、待办和图片引用归属。
- `integration/attachments.test.ts`：实际类型与大小、未认证/跨 Agent 读取、对象键冲突、失败补偿、有效/过期上传租约、R2 孤儿和可重试永久删除。
- `unit/*.test.ts`：输入校验、Markdown 引用、游标和三态主题的纯逻辑测试；auth 单元文件另使用隔离 D1 验证凭据摘要与 Bearer 行为。
- 当前没有浏览器 e2e 自动化；登录/退出、三布局、一次性 key、图片、主题和手机导航按部署手册在 staging 做人工验收。
- integration 同时检查 `/api`、`/api/docs` 的认证和角色范围；固定文档中的全部调用示例仍需在 staging smoke checks 中验证。

采用适配 Workers 的本地测试运行环境与隔离 D1/R2；真实事务与 Binding 行为不能仅凭 mock 通过判定。只给关键业务写有意义的测试，不为每个轻量封装建立重复测试。
