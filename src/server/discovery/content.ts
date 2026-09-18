import type { Actor } from "../env";

export type DiscoveryRole = "agent" | "manager" | "admin";

export type RouteSummary = {
  method: string;
  path: string;
  purpose: string;
};

export type QuickStartDocument = {
  service: "Personal Hub";
  purpose: string;
  api_version: "v1";
  credential_role: DiscoveryRole;
  authentication: string;
  available_routes: RouteSummary[];
  workflow: string[];
  pagination: {
    request: string;
    response: string;
    rule: string;
  };
  full_documentation: "/api/docs";
};

const AGENT_ROUTES: RouteSummary[] = [
  { method: "GET", path: "/api/v1/agent", purpose: "读取自身配置和最近上报状态" },
  { method: "GET", path: "/api/v1/agent/entries", purpose: "分页读取自身当前条目" },
  { method: "POST", path: "/api/v1/agent/entries", purpose: "创建自身条目和版本 1" },
  { method: "GET", path: "/api/v1/agent/entries/{id}", purpose: "读取自身单个条目" },
  { method: "POST", path: "/api/v1/agent/entries/{id}/versions", purpose: "追加完整版本" },
  { method: "GET", path: "/api/v1/agent/entries/{id}/versions", purpose: "读取版本目录" },
  { method: "GET", path: "/api/v1/agent/entries/{id}/versions/{version}", purpose: "读取指定版本" },
  { method: "GET, POST", path: "/api/v1/agent/tasks", purpose: "读取或创建自身待办" },
  { method: "PATCH, DELETE", path: "/api/v1/agent/tasks/{id}", purpose: "修改或删除自身待办" },
  { method: "POST", path: "/api/v1/agent/attachments", purpose: "上传自身条目使用的图片" },
  { method: "GET", path: "/api/v1/media/{attachment_id}", purpose: "读取自身私有图片" },
  { method: "POST", path: "/api/v1/agent/report", purpose: "上报本轮结果" },
];

const MANAGER_ROUTES: RouteSummary[] = [
  { method: "GET", path: "/api/v1/manager/agents", purpose: "读取可管理 Agent 的基本状态" },
  { method: "GET", path: "/api/v1/manager/entries", purpose: "跨 Agent 分页查询当前条目" },
  { method: "POST", path: "/api/v1/manager/agents/{agent_id}/entries", purpose: "为目标 Agent 创建条目" },
  { method: "GET", path: "/api/v1/manager/entries/{id}", purpose: "读取任意可管理条目" },
  { method: "POST", path: "/api/v1/manager/entries/{id}/versions", purpose: "为原条目追加完整版本" },
  { method: "GET", path: "/api/v1/manager/entries/{id}/versions", purpose: "读取版本目录" },
  { method: "GET", path: "/api/v1/manager/entries/{id}/versions/{version}", purpose: "读取指定版本" },
  { method: "GET, POST", path: "/api/v1/manager/tasks", purpose: "跨 Agent 读取或创建待办" },
  { method: "PATCH", path: "/api/v1/manager/tasks/{id}", purpose: "修改可管理待办；总管不能删除" },
  { method: "POST", path: "/api/v1/manager/agents/{agent_id}/attachments", purpose: "为目标 Agent 上传图片" },
  { method: "GET", path: "/api/v1/media/{attachment_id}", purpose: "读取可管理的私有图片" },
  { method: "POST", path: "/api/v1/manager/report", purpose: "上报总管本轮结果" },
];

const ADMIN_ROUTES: RouteSummary[] = [
  { method: "GET, POST", path: "/api/v1/admin/agents", purpose: "列出或创建 Agent" },
  { method: "PATCH", path: "/api/v1/admin/agents/{id}", purpose: "修改 Agent 配置" },
  { method: "POST", path: "/api/v1/admin/agents/{id}/enable", purpose: "启用 Agent" },
  { method: "POST", path: "/api/v1/admin/agents/{id}/disable", purpose: "停用 Agent" },
  { method: "POST", path: "/api/v1/admin/agents/{id}/remove", purpose: "移除 Agent 并撤销密钥" },
  { method: "POST", path: "/api/v1/admin/agents/{id}/restore", purpose: "将移除状态恢复为停用" },
  { method: "DELETE", path: "/api/v1/admin/agents/{id}", purpose: "分步清理并永久删除 Agent" },
  { method: "GET, POST", path: "/api/v1/admin/agents/{id}/keys", purpose: "列出元数据或签发新密钥" },
  { method: "DELETE", path: "/api/v1/admin/agents/{id}/keys/{key_id}", purpose: "撤销密钥" },
  { method: "GET", path: "/api/v1/admin/entries", purpose: "跨 Agent 分页读取条目" },
  { method: "POST", path: "/api/v1/admin/agents/{agent_id}/entries", purpose: "为目标 Agent 创建条目" },
  { method: "GET", path: "/api/v1/admin/entries/{id}", purpose: "读取单个条目" },
  { method: "GET, POST", path: "/api/v1/admin/entries/{id}/versions", purpose: "读取版本目录或追加版本" },
  { method: "GET", path: "/api/v1/admin/entries/{id}/versions/{version}", purpose: "读取指定版本" },
  { method: "PATCH", path: "/api/v1/admin/entries/{id}/state", purpose: "修改已读、归档或完成状态" },
  { method: "DELETE", path: "/api/v1/admin/entries/{id}", purpose: "永久删除条目" },
  { method: "GET, POST", path: "/api/v1/admin/tasks", purpose: "跨 Agent 读取或创建待办" },
  { method: "PATCH, DELETE", path: "/api/v1/admin/tasks/{id}", purpose: "修改或删除待办" },
  { method: "POST", path: "/api/v1/admin/agents/{agent_id}/attachments", purpose: "为目标 Agent 上传图片" },
  { method: "GET", path: "/api/v1/media/{attachment_id}", purpose: "读取私有图片" },
  { method: "GET", path: "/api/v1/auth/session", purpose: "读取管理员会话" },
  { method: "POST", path: "/api/v1/auth/logout", purpose: "撤销当前管理员会话" },
];

function discoveryRole(actor: Actor): DiscoveryRole {
  if (actor.type === "admin") return "admin";
  return actor.scope === "all" ? "manager" : "agent";
}

function routesFor(role: DiscoveryRole): RouteSummary[] {
  if (role === "admin") return ADMIN_ROUTES;
  return role === "manager" ? MANAGER_ROUTES : AGENT_ROUTES;
}

function authenticationFor(role: DiscoveryRole): string {
  return role === "admin"
    ? "管理员 Session Cookie；写操作还必须来自配置的同源页面"
    : "Authorization: Bearer <该 Agent 的独立密钥>";
}

export function getQuickStart(actor: Actor): QuickStartDocument {
  const role = discoveryRole(actor);
  return {
    service: "Personal Hub",
    purpose: "保存外部 Agent 产生的条目、完整历史版本、简单待办和私有图片。平台不执行语义去重。",
    api_version: "v1",
    credential_role: role,
    authentication: authenticationFor(role),
    available_routes: routesFor(role),
    workflow: [
      "先读取当前凭据可见的全部已有条目，包括已完成和归档内容。",
      "持续请求 next_cursor，直到它为 null，再在调用方比较和去重。",
      "同一件事没有新事实时，不创建条目、不追加相同版本，也不重复生成待办。",
      "确有新进展时，携带刚读取的 base_version 向原条目追加完整版本；完成状态会保留。",
      "只有新的独立事项才创建新条目。写请求结果未知时先读取确认，不要盲目重试。",
    ],
    pagination: {
      request: "使用 limit 和可选 cursor；切换筛选条件后从无 cursor 的第一页重新开始。",
      response: "列表响应为 { items, next_cursor }。",
      rule: "next_cursor 不为 null 时继续读取，不能把单页结果当成全部数据。",
    },
    full_documentation: "/api/docs",
  };
}

const COMMON_DOCS = `# Personal Hub API v1

所有私有数据接口都要求认证。机器身份使用 \`Authorization: Bearer <独立密钥>\`；管理员使用 HttpOnly Session Cookie，且管理员写操作必须通过同源检查。不要把密钥放进 URL、正文或日志。

## 固定工作约定

1. 先读取可见的全部当前条目，包括已完成与归档条目，并读完所有分页。
2. 平台不做语义去重。已完成的同一件事没有新事实时，不再创建条目、追加相同内容或重复生成待办。
3. 有新事实时向原条目追加完整版本，并提交刚读取的 \`base_version\`。追加版本不会清除完成、归档或已读状态。
4. 新的独立事项才创建新条目。请求超时或连接中断后先读取确认结果，不盲目重试写操作。

## 通用格式

- 请求和响应字段使用 snake_case，时间为 UTC ISO 8601。
- 分页列表返回 \`{ "items": [...], "next_cursor": string | null }\`。继续把 \`next_cursor\` 原样作为下一次 \`cursor\`，直到为 null。
- 修改筛选条件后丢弃旧 cursor。cursor 只代表分页位置，不赋予额外权限。
- 错误返回 \`{ "error": { "code", "message", "request_id", "details"? } }\`。
- 常见状态码：400 输入错误，401 凭据无效，403 权限不足，404 资源不存在或不属于当前身份，409 并发冲突，413 请求过大，415 图片类型不支持，429 登录尝试过多。
- 条目列表支持的核心筛选：\`completion=all|open|done\`、\`archived=all|yes|no\`、\`view=brief|full\`、\`limit\`、\`cursor\`。普通 Agent 默认 full，并默认包含已完成和归档。
- 待办列表支持 \`agent_id\`（仅跨 Agent 身份）、\`done=all|yes|no\`、\`limit\`、\`cursor\`。

## 待办请求体

- 创建：\`{ "title": string, "entry_id"?: string | null, "agent_id"?: string, "due_at"?: string | null }\`。
- 修改：\`{ "title"?: string, "due_at"?: string | null, "done"?: boolean }\`，至少一个字段。
- 关联条目时，归属始终由条目决定；提交不一致的 agent_id 会被拒绝。
- 创建返回 201 和完整 TaskDto；修改返回 200；删除成功返回 204。
`;

const AGENT_DOCS = `## 当前凭据角色：普通 Agent

只可使用 \`/api/v1/agent\` 前缀，owner 始终由密钥确定。

- \`GET /api/v1/agent\`：自身配置和最近上报。
- \`GET /api/v1/agent/entries\`：自身条目列表。
- \`POST /api/v1/agent/entries\`：请求体至少包含 \`title\`、\`content\`，成功返回 201。
- \`GET /api/v1/agent/entries/{id}\`：当前完整内容。
- \`GET /api/v1/agent/entries/{id}/versions[/{version}]\`：版本目录或指定版本。
- \`POST /api/v1/agent/entries/{id}/versions\`：完整新快照，包含 \`base_version\`。
- \`GET|POST /api/v1/agent/tasks\`；\`PATCH|DELETE /api/v1/agent/tasks/{id}\`：自身待办。
- \`POST /api/v1/agent/attachments\`：multipart 图片上传，仅 PNG/JPEG/WebP/GIF。
- \`POST /api/v1/agent/report\`：\`{ "result": "success"|"failed", "note"?: string|null }\`。

普通 Agent 不能修改条目的已读、归档和完成状态，也不能访问其他 Agent 的资源。
`;

const MANAGER_DOCS = `## 当前凭据角色：总管 Agent

只可使用 \`/api/v1/manager\` 前缀。总管能跨 Agent 读取和写入业务内容，但不能管理密钥、管理员会话、Agent 生命周期或永久删除。

- \`GET /api/v1/manager/agents\`：Agent 基本状态。
- \`GET /api/v1/manager/entries\`：跨 Agent 列表；用 \`agent_id\` 限定目标，用 \`view=full\` 取得完整正文。
- \`POST /api/v1/manager/agents/{agent_id}/entries\`：为目标 Agent 创建条目。
- \`GET /api/v1/manager/entries/{id}\`：当前完整内容。
- \`GET /api/v1/manager/entries/{id}/versions[/{version}]\`：版本目录或指定版本。
- \`POST /api/v1/manager/entries/{id}/versions\`：向原归属条目追加完整版本。
- \`GET|POST /api/v1/manager/tasks\`；\`PATCH /api/v1/manager/tasks/{id}\`：跨 Agent 待办。独立待办必须指定 agent_id；总管不能删除待办。
- \`POST /api/v1/manager/agents/{agent_id}/attachments\`：为目标 Agent 上传图片。
- \`POST /api/v1/manager/report\`：上报本轮结果。

总管创建和更新内容时，目标 Agent 仍是资源 owner，总管仅记录为实际操作者。
`;

const ADMIN_DOCS = `## 当前凭据角色：管理员

使用 \`/api/v1/admin\` 前缀。所有 POST、PATCH、DELETE 都要求请求 Origin 与 APP_ORIGIN 相同。

- \`GET|POST /api/v1/admin/agents\`；\`PATCH /api/v1/admin/agents/{id}\`：列出、创建和配置 Agent。
- \`POST /api/v1/admin/agents/{id}/enable|disable|remove|restore\`；\`DELETE /api/v1/admin/agents/{id}\`：生命周期和分步删除。
- \`GET|POST /api/v1/admin/agents/{id}/keys\`；\`DELETE /api/v1/admin/agents/{id}/keys/{key_id}\`：密钥轮换。新密钥明文只返回一次。
- \`GET /api/v1/admin/entries\`；\`POST /api/v1/admin/agents/{agent_id}/entries\`：跨 Agent 读取或创建条目。
- \`GET /api/v1/admin/entries/{id}\`；\`GET|POST /api/v1/admin/entries/{id}/versions\`；\`GET /api/v1/admin/entries/{id}/versions/{version}\`：详情与版本。
- \`PATCH /api/v1/admin/entries/{id}/state\`：修改 archived、read_version、completed；完成时间由服务器生成。
- \`DELETE /api/v1/admin/entries/{id}\`：永久删除整条记录；关联待办保留并解除来源。
- \`GET|POST /api/v1/admin/tasks\`；\`PATCH|DELETE /api/v1/admin/tasks/{id}\`：全部待办。无来源且未指定 agent_id 时归入 manual。
- \`POST /api/v1/admin/agents/{agent_id}/attachments\`：为目标 Agent 上传图片。
- \`GET /api/v1/auth/session\`、\`POST /api/v1/auth/logout\`：当前会话和退出。
`;

export function getFullApiDocs(actor: Actor): string {
  const role = discoveryRole(actor);
  const roleDocs = role === "admin" ? ADMIN_DOCS : role === "manager" ? MANAGER_DOCS : AGENT_DOCS;
  return `${COMMON_DOCS}\n${roleDocs}`;
}
