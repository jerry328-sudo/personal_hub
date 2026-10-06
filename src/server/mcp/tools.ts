import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import * as validation from "../../shared/validation";
import { LIMITS } from "../../shared/limits";
import type { ServiceContext } from "../env";
import * as entries from "../modules/entries/service";
import { entryCounts } from "../modules/entries/repository";
import * as tasks from "../modules/tasks/service";
import * as agents from "../modules/agents/service";
import * as keys from "../modules/auth/service";
import { listPasskeys, revokePasskey } from "../modules/auth/passkey-management";
import * as readers from "../modules/readers/service";
import { getReaderAccess, replaceReaderAccess } from "../modules/agents/read-access";
import { purgeAgentStep } from "../modules/agents/lifecycle";
import { getAttachmentMedia, purgeAgentAttachmentsStep, uploadAttachment } from "../modules/attachments/service";
import { getFullApiDocs } from "../discovery/content";
import { badRequest, forbidden, normalizeError } from "../shared/errors";
import { recordReaderAccess } from "../shared/access-log";
import { principalFor, resolvePrincipal, scopeAllows, type McpPrincipal, type McpScope } from "./identity";
import { PANEL_RESOURCE_URI, PANEL_TOOL_NAME, type PanelSnapshot } from "../../shared/panel";
import type { OpenAIUiToolMetadata } from "@openai/mcp-extensions/server";
import { registerPanelResource } from "./panel";
import { HUB_ICONS } from "../../shared/hub-icon";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const empty = z.object({}).strict();
const byId = z.object({ id }).strict();
const page = z.object({ cursor: z.string().min(1).max(2048).optional(), limit: z.number().int().min(1).max(100).optional() }).strict();
const agentQuery = page.extend({ status: z.enum(["active", "disabled", "removed", "deleting", "all"]).optional(), scope: z.enum(["own", "all"]).optional() });
const versionsQuery = page.extend({ id });
const entryVersionQuery = byId.extend({ version: z.number().int().positive() });
const createEntryInput = z.object({ agent_id: id.optional(), entry: validation.createEntrySchema }).strict();
const appendEntryInput = z.object({ id, entry: validation.appendVersionSchema }).strict();
const updateEntryStateInput = z.object({ id, state: validation.patchEntryStateSchema }).strict();
const updateTaskInput = z.object({ id, task: validation.patchTaskSchema }).strict();
const updateAgentInput = z.object({ id, agent: validation.updateAgentSchema }).strict();
const setAgentStatusInput = byId.extend({ action: z.enum(["enable", "disable", "remove", "restore"]) });
const issueKeyInput = z.object({ id, key: validation.issueKeySchema }).strict();
const revokeKeyInput = byId.extend({ key_id: id });
const setReadAccessInput = z.object({ id, access: validation.updateReadAccessSchema }).strict();
const uploadImageInput = z.object({
  agent_id: id.optional(), filename: z.string().min(1).max(255),
  content_type: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  data: z.string().min(1).max(Math.ceil(LIMITS.imageBytes / 3) * 4),
}).strict();
const oauthGrantsQuery = page.extend({ user_id: z.string().min(1).max(200).optional() });
const revokeOAuthGrantInput = z.object({ grant_id: z.string().min(1).max(200), user_id: z.string().min(1).max(200) }).strict();

// Share only immutable schema data. Servers, callbacks, identities and results remain request-local.
const jsonSchemas = new WeakMap<z.ZodType, Tool["inputSchema"]>();
const jsonSchemaValidator = new AjvJsonSchemaValidator();
function inputJsonSchema(schema: z.ZodType): Tool["inputSchema"] {
  let converted = jsonSchemas.get(schema);
  if (!converted) {
    converted = z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as Tool["inputSchema"];
    jsonSchemas.set(schema, converted);
  }
  return converted;
}
type Role = "admin" | "agent" | "manager" | "reader";
const all: Role[] = ["admin", "agent", "manager", "reader"];
const managers: Role[] = ["admin", "manager"];
const writers: Role[] = ["admin", "agent", "manager"];

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: { result: value } };
}

// Role-specific documentation is public static code, never user data.
// Cache its JSON encoding while preserving both response formats for clients.
const documentationResults = new Map<Role, CallToolResult>();
function documentationResult(ctx: ServiceContext): CallToolResult {
  const role = ctx.actor.type === "admin" ? "admin" : ctx.actor.role;
  let result = documentationResults.get(role);
  if (!result) { result = jsonResult(getFullApiDocs(ctx.actor)); documentationResults.set(role, result); }
  return result;
}

export function createMcpServer(ctx: ServiceContext, scopes: readonly string[], oauth?: OAuthHelpers, principal: McpPrincipal = principalFor(ctx.actor), request?: Request): McpServer {
  const server = new McpServer({ name: "personal-hub", title: "Personal Hub", version: "1.0.0", icons: HUB_ICONS }, { jsonSchemaValidator });
  const visibleTools: Tool[] = [];
  const role: Role = ctx.actor.type === "admin" ? "admin" : ctx.actor.role;
  function add<S extends z.ZodType>(name: string, description: string, schema: S, roles: Role[], scope: McpScope,
    run: (input: z.output<S>) => Promise<unknown>, destructive = false, raw = false,
    metadata?: Record<string, unknown>, title?: string) {
    if (!roles.includes(role) || !scopeAllows(scopes, scope)) return;
    const inputSchema: z.ZodType = schema;
    const annotations = { readOnlyHint: scope === "hub:read", destructiveHint: destructive, openWorldHint: false };
    visibleTools.push({
      name, description, inputSchema: inputJsonSchema(schema), annotations,
      execution: { taskSupport: "forbidden" },
      ...(metadata ? { _meta: metadata } : {}), ...(title ? { title } : {}),
      ...(name === PANEL_TOOL_NAME ? { icons: HUB_ICONS } : {}),
    });
    server.registerTool(name, {
      description, inputSchema, ...(metadata ? { _meta: metadata } : {}), ...(title ? { title } : {}),
      annotations,
    }, async (input: unknown): Promise<CallToolResult> => {
      let status = 200; let code = "ok";
      try {
        // Recheck after transport body parsing, before any business operation.
        ctx = { ...ctx, actor: await resolvePrincipal(ctx.env, principal) };
        // The SDK already validates, refines and applies defaults to inputSchema before this callback.
        const result = await run(input as z.output<S>);
        return raw ? result as CallToolResult : jsonResult(result ?? { success: true });
      } catch (error) {
        const normalized = normalizeError(error); status = normalized.status; code = normalized.code;
        return { ...jsonResult({ error: { code, message: normalized.message,
          ...(normalized.details === undefined ? {} : { details: normalized.details }) } }), isError: true };
      } finally {
        if (ctx.actor.type === "agent" && ctx.actor.role === "reader") recordReaderAccess({
          requestId: ctx.requestId, readerAgentId: ctx.actor.agentId, keyId: ctx.actor.keyId,
          method: "MCP", route: name, status, code, permissionsRevision: ctx.actor.permissionsRevision,
        });
      }
    });
  }
  const owner = (target?: string): string => {
    if (ctx.actor.type === "agent" && ctx.actor.role === "agent") {
      if (target && target !== ctx.actor.agentId) throw forbidden();
      return ctx.actor.agentId;
    }
    if (!target) throw badRequest("此身份必须指定 agent_id");
    return target;
  };
  if (scopeAllows(scopes, "hub:read")) {
    registerPanelResource(server, async () => { ctx = { ...ctx, actor: await resolvePrincipal(ctx.env, principal) }; }, ctx.env);
    add(PANEL_TOOL_NAME, "打开 Personal Hub 面板，阅读来源、条目与版本，管理待办，将选中内容附到当前对话。", empty, all, "hub:read", async () => {
      const [sources, inbox] = await Promise.all([
        role === "reader" ? readers.listReadableAgents(ctx, { limit: 100 })
          : role === "agent" ? agents.getSelfAgent(ctx).then((item) => ({ items: [item], next_cursor: null }))
            : agents.listAgents(ctx, { status: "all", limit: 100 }, "admin"),
        entries.listEntries(ctx, { view: "brief", archived: "no", order: "updated_desc", limit: 50 }, role),
      ]);
      const first = inbox.items[0];
      const snapshot: PanelSnapshot = {
        identity: { role, agent_id: ctx.actor.type === "agent" ? ctx.actor.agentId : null,
          can_write: writers.includes(role) && scopeAllows(scopes, "hub:write"),
          can_manage_entries: managers.includes(role) && scopeAllows(scopes, "hub:write"),
          can_manage_sources: managers.includes(role) && scopeAllows(scopes, "hub:admin") },
        app_origin: ctx.env.APP_ORIGIN, sources, entries: inbox,
        entry: first ? await entries.getEntry(ctx, first.id) : null,
      };
      return { content: [{ type: "text", text: "Personal Hub 面板已打开。条目正文仅在用户选择附到聊天时传入对话。" }],
        structuredContent: { role, loaded_entries: inbox.items.length }, _meta: { personalHub: snapshot } } satisfies CallToolResult;
    }, false, true, {
      ui: { resourceUri: PANEL_RESOURCE_URI, visibility: ["model", "app"] },
      "openai/ui": { entrypoints: [{ type: "global" }, { type: "thread" }] } satisfies OpenAIUiToolMetadata,
    }, "Personal Hub");
  }
  add("get_identity", "读取当前身份与 MCP 授权范围。", empty, all, "hub:read", async () =>
    role === "reader" ? { ...await readers.getReaderSelf(ctx), scopes }
      : { role, agent_id: ctx.actor.type === "agent" ? ctx.actor.agentId : null, scopes });
  add("get_api_documentation", "获取当前角色的业务规则、字段和 API 文档。", empty, all, "hub:read", async () => documentationResult(ctx), false, true);
  add("list_agents", "分页读取当前身份可见的来源；普通 Agent 仅返回自身。", agentQuery, all, "hub:read", async (input) => {
    if (role === "reader") {
      if (input.status || input.scope) throw badRequest("只读身份仅支持 cursor 和 limit");
      return readers.listReadableAgents(ctx, input);
    }
    if (role === "agent") return { items: [await agents.getSelfAgent(ctx)], next_cursor: null };
    return agents.listAgents(ctx, input, "admin");
  });
  add("list_entries", "分页读取条目。更新前先读取当前 version，正文更新须提交完整快照。", validation.entryQuerySchema, all, "hub:read", async (input) => entries.listEntries(ctx, input, role));
  add("get_entry", "读取授权范围内条目的当前版本。", byId, all, "hub:read", async ({ id }) => entries.getEntry(ctx, id));
  add("list_entry_versions", "分页读取条目的历史版本目录。", versionsQuery, all, "hub:read", async ({ id, ...query }) => entries.listEntryVersions(ctx, id, query));
  add("get_entry_version", "读取指定历史版本完整快照。", entryVersionQuery, all, "hub:read", async ({ id, version }) => entries.getEntryVersion(ctx, id, version));
  add("create_entry", "创建条目和版本 1。普通 Agent 自动归属自身；总管和管理员须指定 agent_id。", createEntryInput, writers, "hub:write", async ({ agent_id, entry }) => entries.createEntry(ctx, owner(agent_id), entry));
  add("append_entry_version", "追加完整快照；base_version 必须匹配当前版本，冲突后重新读取。", appendEntryInput, writers, "hub:write", async ({ id, entry }) => entries.appendEntryVersion(ctx, id, entry));
  add("get_entry_counts", "读取管理员收件箱统计。", empty, managers, "hub:read", async () => entryCounts(ctx.env.DB));
  add("mark_entries_read", "将全部匹配条目标记为已读，覆盖分页范围。", validation.markReadQuerySchema, managers, "hub:write", async (input) => entries.markEntriesRead(ctx, input));
  add("update_entry_state", "修改已读、归档、条目完成状态；待办完成状态独立。", updateEntryStateInput, managers, "hub:write", async ({ id, state }) => entries.updateEntryState(ctx, id, state));
  add("delete_entry", "永久删除条目及全部版本，关联待办保留。", byId, managers, "hub:write", async ({ id }) => entries.deleteEntry(ctx, id), true);
  add("list_tasks", "分页读取授权范围内的待办。", validation.taskQuerySchema, all, "hub:read", async (input) => tasks.listTasks(ctx, input));
  add("clear_completed_tasks", "清除当前来源范围内全部已完成待办，包括归档关联项；保留未完成待办及原始条目。调用前应确认清除范围。", validation.completedTasksScopeSchema, writers, "hub:write", async (input) => tasks.clearCompletedTasks(ctx, input), true);
  add("create_task", "创建待办；归属和关联条目按现有权限校验。", validation.createTaskSchema, writers, "hub:write", async (input) => tasks.createTask(ctx, input));
  add("update_task", "更新待办标题、截止时间或完成状态。", updateTaskInput, writers, "hub:write", async ({ id, task }) => tasks.updateTask(ctx, id, task));
  add("delete_task", "删除待办。普通 Agent 仅可删除自身待办；总管和管理员可跨来源删除。", byId, writers, "hub:write", async ({ id }) => tasks.deleteTask(ctx, id), true);
  add("report_run", "上报 Agent 本次运行结果。", validation.reportSchema, ["agent", "manager"], "hub:write", async (input) => agents.reportRun(ctx, input));
  add("create_agent", "创建普通、总管或只读 Agent，首把密钥仅在本次响应展示。", validation.createAgentSchema, managers, "hub:admin", async (input) => agents.createAgent(ctx, input));
  add("update_agent", "修改 Agent 名称、说明或展示设置。", updateAgentInput, managers, "hub:admin", async ({ id, agent }) => agents.updateAgent(ctx, id, agent));
  add("set_agent_status", "启用、停用、移除或恢复 Agent；移除会撤销其密钥。", setAgentStatusInput, managers, "hub:admin", async ({ id, action }) => {
    const actions = { enable: agents.enableAgent, disable: agents.disableAgent, remove: agents.removeAgent, restore: agents.restoreAgent };
    return actions[action](ctx, id);
  }, true);
  add("purge_agent", "永久删除 Agent。若 status=pending，继续调用直到 done。", byId, managers, "hub:admin", async ({ id }) => purgeAgentStep(ctx, id, { purgeAttachmentsStep: purgeAgentAttachmentsStep }), true);
  add("list_agent_keys", "读取 Agent 密钥元数据，不返回密钥明文。", byId, managers, "hub:admin", async ({ id }) => keys.listAgentKeys(ctx, id));
  add("issue_agent_key", "签发 Agent 密钥，明文仅在本次响应展示。", issueKeyInput, managers, "hub:admin", async ({ id, key }) => keys.issueAgentKey(ctx, id, key));
  add("revoke_agent_key", "撤销指定 Agent 密钥及其派生 OAuth 访问。", revokeKeyInput, managers, "hub:admin", async ({ id, key_id }) => keys.revokeAgentKey(ctx, id, key_id), true);
  add("get_read_access", "读取只读 Agent 的来源授权和 revision。", byId, managers, "hub:admin", async ({ id }) => getReaderAccess(ctx, id));
  add("set_read_access", "完整替换来源授权，必须携带当前 base_revision。", setReadAccessInput, managers, "hub:admin", async ({ id, access }) => replaceReaderAccess(ctx, id, access));
  add("list_passkeys", "读取通行密钥绑定元数据；注册和设备验证通过原有网页完成。", empty, managers, "hub:admin", async () => listPasskeys(ctx));
  add("revoke_passkey", "移除通行密钥绑定，并使通过该绑定取得的网页登录和 OAuth 访问失效。", byId, managers, "hub:admin", async ({ id }) => revokePasskey(ctx, id), true);
  add("change_admin_secret", "修改管理员登录密钥。需当前密钥；会使所有旧会话、通行密钥和管理员授权的 MCP 连接失效。", validation.changeAdminSecretSchema, managers, "hub:admin", async (input) => {
    if (!request) throw forbidden();
    await keys.changeAdminSecret(ctx, request, input);
    return { success: true, reauthorization_required: true };
  }, true);
  add("upload_image", "上传 Base64 编码的 PNG/JPEG/WebP/GIF，最大 10 MiB，返回受保护图片地址。", uploadImageInput, writers, "hub:write", async ({ agent_id, filename, content_type, data }) => {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw badRequest("图片 Base64 无效");
    const binary = atob(data);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const body = new FormData(); body.append("file", new Blob([bytes], { type: content_type }), filename);
    return uploadAttachment(ctx, owner(agent_id), new Request(`${ctx.env.APP_ORIGIN}/mcp`, { method: "POST", body }));
  });
  add("get_image", "读取私有图片并返回 MCP 图片内容，按当前身份校验归属。", byId, all, "hub:read", async ({ id }) => {
    const response = await getAttachmentMedia(ctx, id);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return { content: [{ type: "image", data: btoa(binary), mimeType: response.headers.get("Content-Type") ?? "image/png" }] } satisfies CallToolResult;
  }, false, true);
  if (oauth) {
    add("list_oauth_grants", "分页读取 OAuth 客户端授权。user_id 默认为 admin；Agent 身份为 agent_<id>。", oauthGrantsQuery, managers, "hub:admin", async ({ user_id, ...query }) => oauth.listUserGrants(user_id ?? "admin", query));
    add("revoke_oauth_grant", "撤销 OAuth 授权及关联令牌，不影响原有 API 密钥或网页登录。", revokeOAuthGrantInput, managers, "hub:admin", async ({ grant_id, user_id }) => oauth.revokeGrant(grant_id, user_id), true);
  }
  // SDK 1.31 recomputes every schema and omits icons in its default discovery handler.
  // Keep SDK validation/execution, and return our request-filtered catalog through its public API.
  if (visibleTools.length) server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: visibleTools }));
  return server;
}
