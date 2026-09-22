# 只读 Agent 功能设计与实施计划

状态：已于 2026-09-22 部署并执行生产迁移。本地通过 typecheck、lint、113 项自动化测试、构建，以及授权弹窗的 3 个浏览器回归场景。线上已验证授权读取、禁止写入、图片访问、撤权及游标失效；临时只读测试身份已清理。详见 [发布记录](releases/2026-09-22-readonly-agents.md)。

本次审查修订：运行时角色与数据库 scope 分离；读取默认拒绝；明确授权替换的事务顺序；补充来源字段白名单、游标恢复、限流及日志边界。以下规则为实施约束，不能仅以人工检索代替。

## 1. 目标与使用方式

新增“只读 Agent”，由管理员创建、签发独立密钥并设置读取范围。外部 AI 使用该密钥读取授权内容，不能向 Hub 写入业务数据。

典型例子：创建“每日摘要助手”，仅授权读取“微信监控助手”和“网络信息检测”。它可以汇总这两个 Agent 的消息和待办，但不能改动原消息，也不能把汇总结果写回 Hub。需要写回时，应另行使用有写权限的身份，不能让只读密钥承担写入。

管理流程：

1. 在“Agent 管理”选择身份“只读 Agent”。
2. 选择“指定 Agent”并勾选来源，或选择“全部内容分区”。
3. 设置独立密钥有效期，创建成功后复制密钥；沿用明文仅展示一次的规则。
4. 外部 Agent 带 Bearer 密钥访问 `/api`、`/api/docs`，按返回的只读说明接入。
5. 管理员以后可调整范围、停用、撤销密钥或移除身份。调整权限不需要更换密钥。

本次只规划这一功能，不调整通行密钥登录，也不为外部 Agent 增加调度执行功能。

## 2. 权限语义与默认选择

以下为实施时采用的默认方案，提前明确边界：

| 项目 | 规则 |
| --- | --- |
| 指定范围 | 按不可变 Agent ID 保存授权；改名不影响授权 |
| 全部范围 | 动态包含现有和未来新增的内容分区，包括 `manual` 手动记录；页面明确提示这一点 |
| 指定范围中的手动记录 | 可以单独勾选“手动记录”；不把它冒充普通 Agent |
| 新建表单默认 | “指定 Agent”，不默认选择任何来源；创建时至少选一个 |
| 已有身份清空授权 | 允许保存空清单，含义为无权读取任何业务内容，绝不能当作“全部” |
| 读取内容 | 授权来源的消息摘要、正文、历史版本、归档、完成/阅读状态、待办及私有图片 |
| 只读含义 | 不能创建、追加版本、修改、上传、删除、标记已读、归档、完成或上报运行结果 |
| 身份自身 | 没有内容分区，不进入左侧内容 Agent 导航，也不能作为消息、待办或附件 owner |
| 身份数量 | 可以有多个只读 Agent，不受“只有一个启用总管”的限制 |
| 角色变更 | 首版不支持普通/总管/只读角色互转；只读身份内部可调整授权范围 |
| 只读身份停用 | 拒绝读取业务数据；移除时撤销它的全部密钥；恢复后需按既有密钥规则重新签发 |
| 来源 Agent 停用/移除 | 已授权的历史数据仍可读；进入永久删除状态 `deleting` 后立即不可读 |
| 来源永久删除 | 删除关联授权记录，不自动授权给同名新 Agent；指定范围为空时仍为无访问权 |
| 读取副作用 | 不改变消息已读、归档、完成状态；允许服务端记录密钥最近使用时间及访问日志等技术元数据 |

授权范围只按资源 owner 判断。某消息由总管代写，仍属于原 Agent；正文提及其他来源，不会因此授权访问其他来源。历史版本中的操作者 ID 是记录溯源字段，不赋予查看该身份其他数据的权限。

无法撤回外部 Agent 已经下载的内容。权限更新约束后续请求，不宣称能追回已返回的消息或图片。

## 3. 现有代码中的关键改动点

当前 `scope=own` 表示普通 Agent，`scope=all` 表示总管，角色和范围混在一起。只增加一个范围值或给总管隐藏写按钮，都不足以满足只读要求。

- `src/server/env.ts`、`src/shared/contracts.ts`：`AgentScope` 当前只有 `own | all`。
- `auth/service.ts` 的 `roleOf`、`auth/middleware.ts` 的 `requireAgentKey`：目前根据 scope 推导角色。
- `shared/authorize.ts`：目前 `all` 身份可跨 Agent 写入，需要明确拒绝只读身份。
- `entries/repository.ts`：已有 `ReadScope` 和 `addScopeWhere`，列表与版本读取可扩展复用。
- `tasks/service.ts` / `repository.ts`：目前主要用单个 owner 过滤，需要增加多来源授权条件。
- `attachments/service.ts` 的 `assertOwnerAccess`：目前把读取和写入共享在同一检查中，必须拆开，避免有读权限就能上传。
- `agents`、`entries`、`tasks`、`attachments` 的写入 SQL：目前多处仅以 `scope='own'` 判断内容归属，需要统一保留“普通可写分区”的约束。
- `migrations/0001_initial.sql`：`only_one_active_manager` 目前按 `scope='all'` 限制，需要排除只读身份。

继续沿用模块化单体、现有 D1/R2 和独立 Agent 密钥，不新增 Cloudflare Access、权限服务或通用角色管理框架。

## 4. 数据模型与兼容方式

### 4.1 区分身份角色与读取范围

对 API 和前端提供明确的 `role: agent | manager | reader`。数据库保留现有 scope 列，增加访问模式，避免重建带多重外键的 agents 表。

| 对外角色 | 数据库 scope | access_mode | read_mode |
| --- | --- | --- | --- |
| 普通 Agent `agent` | own | read_write | null |
| 总管 `manager` | all | read_write | null |
| 只读 `reader` | all | read_only | selected 或 all |

这里只读身份的 `scope=all` 是数据库兼容表示，**不代表总管，也不代表可读所有来源**。实际读取范围由 read_mode 和授权表决定。

运行时 `AgentActor` 必须移除 `scope`，也不向业务层透传数据库的 `access_mode`。认证边界使用 `decodeAgentRole` 验证上述字段组合并生成判别联合；不合法的组合拒绝认证，不能降级为普通或总管角色。示意类型：

```ts
type AgentActor = AgentActorBase & (
  | { role: "agent" }
  | { role: "manager" }
  | { role: "reader"; readMode: "selected" | "all"; permissionsRevision: number }
);
// AgentActorBase 保留 type: "agent"、agentId、keyId、status。
// AdminActor 继续通过 type: "admin" 区分。
```

`roleOf` 只返回已验证的角色，不再根据 scope 推断；业务鉴权使用穷尽分支，未知角色默认拒绝。数据库行类型和旧 API 的 scope 输入仅在持久化/兼容转换边界保留。删除运行时 scope 后，旧 `actor.scope` 分支必须产生类型错误，不用类型断言、可选字段或宽泛索引签名绕过编译检查。

原 `requireAgentKey(scope)` 改为必须显式传角色白名单的 `requireAgentRole(roles)`。普通/总管接口逐条声明角色，不能因全局认证接纳 reader 就自动向它开放旧路由。管理员的 Agent 生命周期及密钥管理继续只接受管理员 Session；总管不因此获得管理员权限。

### 4.2 拟新增迁移

拟使用 `migrations/0006_readonly_agents.sql`，实施前再次检查编号是否已被占用。迁移仅规划，不在本轮创建或执行。

`agents` 新增：

| 字段 | 类型 / 默认值 | 用途 |
| --- | --- | --- |
| access_mode | TEXT，默认 read_write，限定 read_write/read_only | 能否写业务数据 |
| read_mode | TEXT，可空，非空时限定 selected/all | 只读身份的范围；缺失时拒绝读取 |
| permissions_revision | INTEGER，默认 0，非负 | 管理员每次替换授权时递增，使旧分页游标失效 |

新增 `agent_read_grants`：

| 字段 | 约束 |
| --- | --- |
| reader_agent_id | 外键 agents.id，删除级联 |
| target_agent_id | 外键 agents.id，删除级联 |
| created_at | 非空创建时间 |

主键为 `(reader_agent_id, target_agent_id)`，另建以 target_agent_id 开头的索引用于来源删除及反向查询。服务端验证 reader 为只读身份，target 为普通内容分区或 manual，禁止授权总管、其他只读身份及正在永久删除的来源。

重建 `only_one_active_manager` 为仅覆盖 `scope='all' AND access_mode='read_write' AND status='active'` 的唯一索引，保持原有总管数量限制。

已有 Agent 全部按 read_write 处理，scope、密钥哈希、有效期、业务数据及管理员登录保持不变。密钥不内嵌授权清单；同一身份的所有有效密钥共享最新权限。

### 4.3 管理写入的原子性

创建只读身份时，身份记录、授权关系、首把密钥必须作为同一事务提交，失败则全部回滚，不返回可用的明文密钥。

修改授权使用完整替换，而非逐个对外增删。切换为 all 清空旧 grant；切回 selected 必须提供新清单，已有身份允许空清单。请求先校验类型、合法模式、非负整数 base_revision，对 agent_ids 去重，再编码为绑定参数 JSON。任一目标无效则整个请求失败，不能只保存有效子集。

**固定采用“全部变更检查旧版本，最后递增版本”的事务顺序。** D1 的 batch 在 SQL 语句报错时回滚，但 UPDATE 影响 0 行不会报错或中止后续语句，不能把它当成自动 CAS 保护。[D1 batch 文档](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)

定义共用事务谓词 `G`，每条变更语句均通过同一 SQL 构造函数展开并绑定相同参数：

```text
EXISTS reader(id = reader_id, scope = all, access_mode = read_only,
              read_mode IN (selected, all), status IN (active, disabled),
              permissions_revision = base_revision)
AND NOT EXISTS (
  json_each(targets_json) 中任一目标不是现存普通 read_write / own / read_mode=null 分区，
  或目标 status = deleting
)
```

manual 使用其已有普通分区记录验证。all 模式将 targets_json 规范化为 `[]`；selected 空清单也通过目标检查，但两者的 mode 不同。目标不得为 manager 或 reader；普通来源 disabled/removed 仍可授权。修改 removed/deleting 的 reader 配置拒绝，需先按生命周期规则恢复。

同一个 `db.batch()` 内依序执行：

1. SELECT 读取 reader 是否存在、角色/状态、当前 revision 和无效目标信息，供失败时分类错误；本语句不代替后续谓词。
2. `DELETE FROM agent_read_grants WHERE reader_agent_id = ? AND G`。
3. `INSERT INTO agent_read_grants (...) SELECT ?, value, ? FROM json_each(?) WHERE G`；只有 selected 模式的规范化清单产生行。
4. `UPDATE agents SET read_mode = ?, permissions_revision = permissions_revision + 1 WHERE id = ? AND G`，这是 batch 中最后一条变更语句。
5. SELECT 读取最终配置，作为成功响应；不能在事务外重读后声称它必然属于本次更新。

上述 `G` 是设计占位符，不是 SQL 变量；实现时每条语句展开完整的参数化谓词。它只依赖 reader 行、目标行与输入 JSON，不依赖正在替换的 grants；前两条变更不能提前改变 reader 的 mode、revision 或目标状态。因全部语句处于同一事务，G 为假时三条变更均不执行，G 为真时一起提交；SQL 错误则整个 batch 回滚。禁止使用 `INSERT OR IGNORE` 静默吞掉约束错误。

以最后 UPDATE 的 `meta.changes === 1` 判定成功。否则使用同 batch 的初始诊断返回 reader 不存在 404、角色/生命周期不允许 409、版本冲突 409、目标无效 400（按此顺序），不得返回成功。不要检查 `revision = base_revision + 1` 来给后续写入放行：另一个请求可能已把版本推进到该值，失败请求会错误匹配。

事务内目标合法性检查是必须的，service 的提前验证只用于更快反馈。创建流程同样要保证目标验证失败时身份、首把密钥和授权均不产生；不能因条件 INSERT 影响 0 行就提交一个缺失授权的身份。测试覆盖目标并发删除及故意制造末条 SQL 错误后的完整回滚。

## 5. 后端鉴权与查询设计

### 5.1 三层检查

1. **身份层**：Bearer 验证后读入 access_mode、read_mode、permissions_revision，推导明确角色。只读身份被停用、密钥过期/撤销时按既有认证约定拒绝。
2. **操作层**：只读角色仅允许登记的读取路由。普通、总管、管理员命名空间均不能借用。写 service 的入口也调用只读拒绝检查，不能只依靠 HTTP 方法或前端按钮。
3. **资源层**：每条查询及图片读取都按当前授权范围限制 owner。列表与搜索在 SQL 分页之前过滤；详情、历史版本不能只验证列表入口。

复用现有 `Actor.type='agent'`，按 4.1 节改为 role 判别联合；扩展 `IdentityRole` 加入 reader。改造 `requireOwnAgentActor`、`requireManagerActor`、`requireReaderActor`，显式要求对应角色及 active 状态。运行时不再存在 actor.scope；编译检查负责发现旧字段引用，SQL、生命周期与共享入口另做定向检查。

`assertCanReadOwner(actor, ownerId)` 对 reader 默认抛出 403，不能在非 own 分支兜底放行。reader 的合法读取改走专用 `resolveReaderReadScope` 和应用该范围的 repository 查询，不给旧 helper 添加 `authorized: true` 一类绕过参数。漏接入的调用路径应失败，不能静默返回内容。旧通用 `resolveReadScope` 同样不为 reader 生成 all 范围，必须显式进入 reader 分支。需要查明单项是否可读时使用受限查询，查不到对外按 5.2 节返回 404；这是资源不可见，与操作入口的 403 区分。

拟扩展内部 `ReadScope` 为三个明确分支：own、all、reader。reader 分支保存只读身份 ID、请求时的权限版本及可选目标筛选，不用“空 agentIds 数组”同时表示无权限和所有权限。

### 5.2 SQL 授权条件

对 reader 查询，使用参数化 `EXISTS` 关联当前身份及授权表：

```text
reader 仍是 active + scope=all + read_only，且权限版本与本次请求一致
AND owner 是 own + read_write + read_mode=null 的内容分区，状态不是 deleting
AND (
  reader.read_mode = all
  OR (reader.read_mode = selected AND 存在 reader → owner 的授权关系)
)
AND 可选的 agent_id / 搜索 / 时间 / 状态筛选
```

grant 查询使用复合主键索引。不要先从 D1 拉取全量记录再在 JavaScript 筛选，也不要把大清单拼成 SQL 字符串。共享 SQL helper 只能接收代码内定义的表别名/owner 列，不接受用户提供的 SQL 标识符。

权限在每次请求重新读取，不跨请求缓存授权清单。查询阶段再次应用实时授权及版本条件，避免旧 Actor 持有已撤销的读取范围。已经开始返回的响应不能保证中途撤回；新请求必须受到更新后的限制。

明确指定无权读取的 agent_id，或访问越权/不存在的条目、版本、附件，统一返回 404；越权读取不能通过错误消息暴露标题、名称等信息。省略 agent_id 时只返回可访问集合，空授权返回空页。

### 5.3 分页与状态

- 复用现有摘要优先、正文按需、响应体大小限制及分页上限。
- 游标指纹包含角色、只读身份 ID、permissions_revision、资源类型和全部筛选条件。
- 管理员修改范围后，属于当前 reader 的旧游标返回 `400 cursor_scope_changed`，沿用现有错误信封并提供 `details.restart_from_first_page = true`；游标损坏、身份不匹配或筛选条件变化返回 `400 invalid_cursor`。不能将所有 400 都当成权限变化。
- 游标只保存翻页位置，不能替代 SQL 鉴权；伪造或复制别人的游标不能扩大范围。
- 消息继续支持归档、已完成及时间窗口，不限制只读 Agent 必须读最近十天。
- 待办读取保留授权来源的已完成和归档关联记录，用于汇总和去重；沿用机器 API 语义，不照搬网页待办隐藏归档项的规则。
- 不新增会自动标记已读的接口；GET 正文和历史版本不会改变任何业务状态。

调用方恢复约定写入 `/api/docs` 及接入示例：仅收到 `cursor_scope_changed` 时，丢弃该次翻页积累的结果与游标，以原筛选条件自动重读第一页；一次读取流程最多自动重启一次，连续变更则返回明确提示，避免循环请求。重新读取若因显式 agent_id 被撤权返回 404，应停止，不自动扩大筛选范围。其他 400 提示参数错误，401/403 停止并检查凭证，429 按 Retry-After 退避。

这些接口首先由外部 Agent 使用，Hub 不能保证第三方遵守重试约定；授权始终由服务端执行。若 Hub 前端或后续 SDK 调用这些列表，也必须实现相同的一次性自动重拉逻辑，不能让页面停在失效游标上。

### 5.4 私有图片

沿用 `/api/v1/media/:attachment_id`，先用同一授权条件查询附件元数据，再读取私有 R2 对象。无权访问时不能返回图片、对象地址、文件名或大小。

不能返回长期公开链接，也不能因为消息正文中出现图片 URL 就跳过附件本身的 owner 检查。响应继续使用 private/no-store。若 HEAD 可用，也必须执行同等授权检查。

### 5.5 限流与配额边界

首版增加独立 `READER_RATE_LIMITER`，建议初始配置为每 reader 每 60 秒 120 次请求，按部署配置调整，不新增管理页面。按已认证的 reader Agent ID 计数，同一身份的不同密钥共用额度；不按 key ID 分桶。reader 的 API、发现文档及图片 GET/HEAD 都经过此限制，不能通过切换密钥或路径绕过；已认证 reader 对其他业务命名空间的请求也经过相同中间件。

执行顺序为认证 → reader 限流 → 操作/资源授权 → 读取。超限返回 `429 rate_limited` 及保守的 `Retry-After: 60`；绑定缺失或调用异常返回 503 并记录运维错误，不能悄悄取消限制。本地与生产配置均显式绑定；现有登录限流保持独立，不能当作机器 API 限流。

Workers Rate Limiting 是按 Cloudflare 地点计数、最终一致的保护，**不是全球精确额度**。首版不做每日/月度硬配额、流量计费、跨地点精确限流或每 reader 定制配额；保留现有分页、响应大小与图片大小约束。[Rate Limiting 文档](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)

### 5.6 访问日志与留存边界

首版记录可检索的结构化访问日志，复用 Workers Logs，不新增 D1 逐请求日志表、Hub 审计页面或日志导出服务。它是尽力记录的运维日志，不承诺完整、不可丢失的合规审计。

- 范围：已认证 reader 的成功读取、拒绝、限流和服务端错误；管理员变更 reader 授权另记配置变更事件。认证失败不能把客户端声称的 key ID 当作已验证身份。
- 字段：时间、request_id、reader_agent_id、已验证 key_id、HTTP 方法、路由模板、单项请求的资源 ID、状态码、错误码、权限版本。授权变更记录目标 reader、旧/新 revision、mode、授权数量及结果，管理员标记为 admin，不写原始 Session 凭证。
- 禁止记录：Bearer/密钥、Cookie、密钥哈希、完整请求或响应体、消息正文、原始搜索词及完整查询串；首版也不主动收集 IP。日志只能证明请求及服务端结果，不能证明对方是否保存或阅读了内容。
- 查看：由有 Cloudflare 项目权限的维护者在 Workers Logs 按 reader_agent_id、key_id、request_id、时间和状态过滤；reader API 不返回日志。
- 留存：依平台套餐保留，当前官方文档为 Free 3 天、Paid 7 天。本轮未核验生产套餐；发布前确认日志启用、采样配置、实际留存及配额，并写入部署记录，不能声称保留 30 天或长期可追溯。当前配置虽有 head_sampling_rate=1，仍需验证真实访问事件可查询。超出留存或平台采集限制的记录不可保证恢复。

若以后需要固定 30 天留存或 Hub 内查询，应另行设计持久化、访问权限、费用及清理机制，不在本版顺带引入。[Workers Logs 留存与限制](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)

## 6. HTTP 接口

### 6.1 管理员接口

沿用 `POST /api/v1/admin/agents`，增加新的角色输入。推荐请求示例：

```json
{
  "name": "每日摘要助手",
  "description": "读取指定来源并生成摘要",
  "role": "reader",
  "read_access": {
    "mode": "selected",
    "agent_ids": ["agent-wechat-example", "agent-news-example"]
  },
  "key_expires_at": null
}
```

示例 ID 为占位值。全部范围使用 `"read_access": {"mode": "all"}`；all 与非空 agent_ids 同时出现时拒绝，不静默忽略。

旧创建请求只含 scope 时仍接受并映射到原有普通/总管身份；新请求 role 与旧 scope 不允许同时提交。创建和更新非只读角色时拒绝 read_access 字段。

新增管理员专用接口：

| 方法和路径 | 内容 |
| --- | --- |
| GET `/api/v1/admin/agents/:id/read-access` | 读取 mode、授权来源及 revision |
| PUT `/api/v1/admin/agents/:id/read-access` | 接收 `{base_revision, mode, agent_ids?}` 完整替换；成功返回新配置，版本冲突返回 409 |

沿用 Session + 同源 Origin 校验。名称/说明修改、密钥签发撤销、启停/移除/恢复沿用原管理接口。角色不可通过普通 PATCH 修改。后台可返回授权目标的缺失/删除状态用于管理员维护，不能把此管理信息暴露给外部只读身份。

### 6.2 只读 Agent 接口

独立使用 `/api/v1/reader` 命名空间。只登记读取路由，不提供 report、上传及任何业务写入路由。

| 方法和路径 | 结果 |
| --- | --- |
| GET `/api/v1/reader` | 当前身份基础配置、role、mode、权限版本，不返回密钥或全站身份列表 |
| GET `/api/v1/reader/agents` | 分页列出可访问的内容来源，仅返回下述 ReaderSourceDto 白名单字段 |
| GET `/api/v1/reader/entries` | 授权范围内消息；复用 agent_id、view、query、时间、归档、完成、阅读状态和分页筛选 |
| GET `/api/v1/reader/entries/:id` | 当前消息正文 |
| GET `/api/v1/reader/entries/:id/versions` | 历史版本摘要目录 |
| GET `/api/v1/reader/entries/:id/versions/:version` | 指定历史版本正文 |
| GET `/api/v1/reader/tasks` | 授权范围内待办，支持 agent_id、done、limit、cursor |
| GET `/api/v1/media/:attachment_id` | 授权图片，复用公共媒体路由并新增只读鉴权 |
| GET `/api`、`/api/docs` | 仅列出只读身份可用接口、授权语义和分页约定 |

不新增全站 counts 或附件枚举接口。若未来添加聚合计数，也必须按相同授权集合统计。通过认证和限流后，所有已存在的业务写接口（含其他身份命名空间）对 reader 返回 403；认证失败、超限与限流服务异常按前述 401/429/503 处理。未知资源按既有路由规则处理，不对只读身份开放管理、密钥和通行密钥接口。

`ReaderSourceDto` 固定白名单：`id`、`name`、`description`、`display_mode`、`status`、`main_entry_id`。不得直接序列化管理侧 AgentDto 或数据库整行，明确排除 `last_note`、`last_result`、`last_report_at`、密钥信息、其他 reader 的授权配置及管理字段。`main_entry_id` 仅在对应消息存在且同属该授权 owner 时返回，否则返回 null；取得 ID 后读取正文仍需重新鉴权。自身 `ReaderSelfDto` 同样显式构造，仅含 `id`、`name`、`description`、`role`、`mode`、`permissions_revision`。

## 7. 模块与函数改动清单

继续沿用 routes → service → repository/storage。readers 模块只负责 reader 调用的读取入口；授权配置的读取和写入归 agents 管理侧，不复制条目、待办和附件业务实现。

| 文件 / 模块 | 拟新增或修改函数 | 职责 |
| --- | --- | --- |
| shared/contracts.ts、validation.ts | AgentRole、ReadAccessInput/Dto、ReaderSelfDto、ReaderSourceDto 及对应 Schema | 明确角色、模式、revision、创建/更新兼容和参数互斥 |
| server/env.ts | AgentActor 角色判别联合、共用角色类型 | 移除运行时 scope/access_mode，编译时阻止旧鉴权分支继续使用 |
| auth/repository.ts | findKeyWithAgent | 认证时一并读取访问模式、范围模式和权限版本 |
| auth/service.ts、middleware.ts | decodeAgentRole、roleOf、authenticateBearer、requireAgentRole、requireReaderKey | 验证数据库角色组合；替换 requireAgentKey(scope)，明确各路由角色名单 |
| shared/authorize.ts | requireReaderActor、assertCanReadOwner、assertCanWriteOwner、resolveReadScope、resolveReaderReadScope | 读写默认拒绝；reader 仅通过显式授权范围读取 |
| shared/reader-rate-limit.ts（新）、wrangler.jsonc | enforceReaderRateLimit、READER_RATE_LIMITER | 按 reader 身份统一限流，绑定异常拒绝服务 |
| shared/access-log.ts（新）、server/app.ts | recordReaderAccess、recordReaderAccessChange | 在统一响应/错误链记录脱敏访问结果，保证拒绝和限流也覆盖 |
| shared/read-access.ts（新） | appendReadAccessPredicate | 以静态 owner 列和参数化绑定生成共用 SQL 条件 |
| readers/routes.ts（新） | registerReaderRoutes | 注册自述及读取路由、解析参数，委托已有 read service |
| readers/service.ts（新） | getReaderSelf、listReadableAgents | 只读身份自述及来源读取，构造字段白名单 DTO |
| readers/repository.ts（新） | listReadableAgentRows | 对授权来源执行 SQL 分页，不提供配置写入函数 |
| agents/read-access.ts（新，管理 service）、agents/routes.ts | getReaderAccess、replaceReaderAccess、validateReadTargets | 配置读写均要求 AdminActor；校验输入，解释事务结果，记录变更事件 |
| agents/repository.ts | findReaderAccess、replaceReaderAccessBatch、prepareReaderGrants、buildReaderAccessGuard | 管理侧配置读取、参数化事务和共用 G 谓词；支持创建事务 |
| agents/service.ts、repository.ts | createAgent、listAgents、createAgentAndKeyBatch | 创建角色、授权、密钥事务；管理列表显示角色；不泄露其他 reader 配置给总管 |
| agents/lifecycle.ts | beginAgentPurge、finalizeAgentPurge 等 | reader 删除只清理自身密钥及 grant；来源删除清理反向 grant；不删除它能读取的来源内容 |
| entries/service.ts、repository.ts | assertAudience、normalizeEntryQuery、getEntry、listEntries、listEntryVersions、getEntryVersion、addScopeWhere | 新增 reader audience，所有列表和详情查询使用相同范围 |
| tasks/service.ts、repository.ts | assertSupportedTaskActor、listTasks 及写函数入口 | 区分只读准入与写入准入，扩展列表 scope，禁止复用读取许可执行写入 |
| attachments/service.ts、repository.ts | getAttachmentMedia、findAttachment、requireActiveUploadTarget | 元数据查询加 scope；分离读写权限，上传必须显式验证写权限 |
| server/app.ts、discovery/content.ts | 路由装配、discoveryRole、routesFor、getQuickStart、getFullApiDocs | 新角色快速说明不再要求上报或写回；不绕过全局认证 |
| web/api.ts、AgentsPage.tsx | 类型、readAccess API、创建/编辑表单、身份筛选 | 只读身份及来源多选，处理 revision 冲突和错误 |
| web/components/AppShell.tsx | visibleAgents | 只保留普通内容分区，reader 不显示为内容栏目 |

先删除运行时 scope 并完成类型迁移，再定向检查数据库 scope SQL、旧契约映射、内容 owner、批量写入、生命周期和共享媒体入口。编译检查与集成测试是必要门槛，文本检索仅补充查找编译器无法覆盖的 SQL 等路径。

## 8. 管理页面交互

创建表单的身份选项为“普通 Agent / 总管 Agent / 只读 Agent”。选择只读后隐藏默认展示方式，显示读取范围：

- “指定 Agent”：可搜索、多选普通来源及手动记录，展示已选数量；新建至少选一个。
- “全部内容分区”：明确显示“包含手动记录及未来新增的 Agent 内容”。

列表卡片显示“只读”标签和“全部来源 / 指定 N 个来源 / 未授权任何来源”，最近使用时间取其密钥记录，不伪装成最近上报。提供“编辑读取范围”，保存后同一密钥的后续请求生效。

编辑器加载当前 revision；遇到 409 保留用户选择、提示重新加载并确认，不静默覆盖另一页面的修改。现有停用和撤销操作继续使用原确认交互。

## 9. 测试与验收

新建 `tests/integration/readonly-agents.test.ts`，用真实 Worker、D1 和 R2 隔离环境验证：

1. 管理员创建指定/全部只读身份，签发密钥，列表展示；可创建多个且不挤占总管唯一名额。
2. 指定 A/C 时，来源列表、消息搜索、待办列表仅包含 A/C；多页混合数据没有越权或被过滤后的假空页。
3. 猜测 B 的条目 ID、历史版本 ID、附件 ID、agent_id 均不能读取；未授权与不存在返回相同 404。
4. 直接访问普通/总管/管理员接口，尝试消息创建/追加、标记状态、一键已读、任务修改/删除、上传、report、生命周期及密钥管理，全部失败且业务数据无变化。
5. service 层直接传入 reader actor 调用写函数同样拒绝，避免只测试路由。
6. GET 正文、归档、历史、待办、图片不会改变已读/完成/归档状态；允许更新 key 使用时间。
7. 时间窗口、摘要/全文、归档/完成、搜索、排序、分页在授权集合内正确工作。
8. 管理员收回 B 后，原密钥和旧图片地址不能再读 B；旧游标失效，伪造游标也不能扩大权限。
9. 指定空清单返回空页；all 自动包含新内容来源；selected 不自动包含。缺少权限配置时拒绝，不默认 all。
10. reader 停用、移除、密钥撤销/过期后不可读取；普通来源停用仍可读历史，deleting 不可读，永久删除清理 grant，同名重建不继承授权。
11. 创建身份与密钥/授权原子提交；授权更新并发 CAS、无效目标、目标同时删除，不出现半更新和意外扩大范围。
12. 删除 reader 不改变任何授权来源内容；普通/总管/管理员已有能力和 Passkey 登录回归通过。
13. 非法数据库角色组合认证失败；旧通用读取 helper 接收 reader 时拒绝；类型检查不允许 AgentActor.scope，也不允许以类型断言补回。检查所有已有路由的角色名单，未知角色无隐式放行。
14. 两个请求带相同 base_revision 并发替换时恰好一个成功；失败者不得删除或插入任何 grant。专测当前版本恰为 base_revision+1、all/selected/空清单切换、末条 SQL 报错回滚和目标生命周期竞争。
15. ReaderSourceDto/ReaderSelfDto 严格字段白名单，运行备注和密钥字段缺失；无效或跨 owner 的 main_entry_id 返回 null。
16. 区分 cursor_scope_changed 与 invalid_cursor；接入示例中的调用方只自动重启一次并丢弃旧页结果，第二次失效停止；401/403/404/其他 400 不触发无界重试。
17. 模拟限流绑定验证同一 reader 的多密钥、不同 API 和图片共用计数；429 含 Retry-After，绑定异常返回 503。线上仅验证绑定与响应接入，不把近似限流测试成全球精确计数器。
18. 成功/拒绝/限流/错误日志均含正确身份和结果，授权配置日志仅由管理操作产生；用测试密钥及敏感内容断言日志中没有凭证、正文或搜索词。发布时验证 Workers Logs 实际可查询及留存配置。

浏览器验证创建、来源多选/搜索、编辑范围、空权限提示、全部范围说明、卡片显示与窄屏布局；用两个不同只读密钥完成隔离验证。需要实测 R2 字节响应及 HEAD（若支持），不能只验证 JSON 列表。

## 10. 实施顺序与发布边界

1. 落实契约和数据迁移，兼容旧 scope 请求；移除运行时 scope，用编译错误逐处完成角色隔离，先写权限模型及事务测试。
2. 改造身份识别、共享 SQL 范围和业务写入拒绝，再接入只读路由及媒体权限。
3. 加入管理员授权接口与页面、字段白名单、游标恢复说明、reader 限流和结构化日志；同步分角色 API 文档。
4. 完成 typecheck、lint、完整测试、构建和本地浏览器验证。
5. 发布前记录 D1 恢复点，核对已有 Agent、密钥及业务数据基线、生产 reader 限流绑定和日志实际留存/配额；先迁移后部署。
6. 新 Worker 上线前不创建只读身份。上线后以临时只读身份做最小读取/越权检查，完成后撤销测试密钥。

回滚注意：旧 Worker 会把 scope=all 误识别为可写总管，因此不能带着有效的 reader 密钥直接回滚旧代码。优先修复前滚；确需回滚时，先撤销所有 reader 密钥并验证无法认证，再回滚 Worker。新增表列可保留，避免为回滚破坏现有数据。

本次交付包括代码实现、回归测试与本文档更新。生产部署与数据库迁移仍需单独执行。
