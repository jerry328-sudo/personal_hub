import type {
  AgentDto,
  AgentRole,
  AgentScope,
  AgentStatus,
  CreateAgentInput,
  IssuedKeyDto,
  Page,
  ReportInput,
  UpdateAgentInput,
} from "../../../shared/contracts";
import { LIMITS } from "../../../shared/limits";
import type { ServiceContext } from "../../env";
import { isUniqueConstraintError } from "../../shared/db";
import { badRequest, conflict, forbidden, notFound } from "../../shared/errors";
import { newEntityId, nowIso } from "../../shared/ids";
import { decodeCursor, encodeCursor, cursorScopeFor, queryFingerprint } from "../../shared/pagination";
import { prepareAgentKey } from "../auth/service";
import { normalizeReadTargets, validateReadTargets } from "./read-access";
import {
  agentOwnsEntry,
  createAgentAndKeyBatch,
  findAgent,
  listAgents as listAgentRows,
  prepareReaderGrants,
  removeAndRevokeBatch,
  setAgentStatus,
  updateAgentConfig,
  updateLastReport,
} from "./repository";

const ALL_STATUSES: readonly AgentStatus[] = ["active", "disabled", "removed", "deleting"];
const DEFAULT_ADMIN_STATUSES: readonly AgentStatus[] = ["active", "disabled"];
const MANAGER_VISIBLE_STATUSES: readonly AgentStatus[] = ["active", "disabled", "removed"];

export type AgentStatusFilter = AgentStatus | "all";

export interface AgentListQuery {
  status?: AgentStatusFilter;
  scope?: AgentScope;
  cursor?: string;
  limit?: number;
}

export interface CreateAgentResult {
  agent: AgentDto;
  key: IssuedKeyDto;
}

function requireAdmin(ctx: ServiceContext): void {
  if (ctx.actor.type !== "admin") throw forbidden("只有管理员可以管理 Agent");
}

/** 只读身份不能通过这里读写业务身份信息，即使路由层漏写角色名单。 */
function requireAgentActor(ctx: ServiceContext, role?: AgentRole): string {
  if (ctx.actor.type !== "agent") throw forbidden();
  if (ctx.actor.role === "reader") throw forbidden("只读身份不能执行此操作");
  if (role !== undefined && ctx.actor.role !== role) throw forbidden();
  return ctx.actor.agentId;
}

function requireActiveAgentActor(ctx: ServiceContext, role?: AgentRole): string {
  const agentId = requireAgentActor(ctx, role);
  if (ctx.actor.type !== "agent" || ctx.actor.status !== "active") {
    throw forbidden("Agent 已停用，不能执行此操作");
  }
  return agentId;
}

async function findRequiredAgent(ctx: ServiceContext, agentId: string): Promise<AgentDto> {
  const agent = await findAgent(ctx.env.DB, agentId);
  if (agent === null) throw notFound("Agent 不存在");
  return agent;
}

function statusesFor(audience: "admin" | "manager", filter: AgentStatusFilter | undefined): readonly AgentStatus[] {
  if (audience === "manager") {
    if (filter === "deleting") throw forbidden("总管 Agent 不能读取正在永久删除的身份");
    if (filter === undefined || filter === "all") return MANAGER_VISIBLE_STATUSES;
    return [filter];
  }
  if (filter === undefined) return DEFAULT_ADMIN_STATUSES;
  return filter === "all" ? ALL_STATUSES : [filter];
}

export async function listAgents(
  ctx: ServiceContext,
  query: AgentListQuery,
  audience: "admin" | "manager",
): Promise<Page<AgentDto>> {
  if (audience === "admin") {
    requireAdmin(ctx);
  } else {
    requireActiveAgentActor(ctx, "manager");
    if (query.scope === "all") throw forbidden("总管列表只包含内容归属分区");
  }

  const statuses = statusesFor(audience, query.status);
  const scope: AgentScope | undefined = audience === "manager" ? "own" : query.scope;
  const limit = Math.min(query.limit ?? LIMITS.defaultPageSize, LIMITS.maxPageSize);
  const fingerprint = queryFingerprint({ audience, statuses, scope: scope ?? null, limit });
  const cursorValue = decodeCursor(query.cursor, fingerprint, cursorScopeFor(ctx.actor));
  if (cursorValue !== null && cursorValue.length !== 1) throw badRequest("分页游标内容无效");

  const result = await listAgentRows(ctx.env.DB, {
    statuses,
    ...(scope === undefined ? {} : { scope }),
    ...(cursorValue?.[0] === undefined ? {} : { afterId: cursorValue[0] }),
    limit,
  });
  return {
    items: result.items,
    next_cursor: result.nextId === null
      ? null
      : encodeCursor([result.nextId], fingerprint, cursorScopeFor(ctx.actor)),
  };
}

export async function createAgent(ctx: ServiceContext, input: CreateAgentInput): Promise<CreateAgentResult> {
  requireAdmin(ctx);
  // 旧请求只含 scope 时映射到原有普通/总管身份；role 与 scope 已由校验层保证互斥。
  const role: AgentRole = input.role ?? (input.scope === "all" ? "manager" : "agent");
  const readMode = role === "reader" ? input.read_access?.mode ?? "selected" : null;
  const targetIds = role === "reader" && readMode !== null
    ? normalizeReadTargets(readMode, input.read_access?.agent_ids ?? [])
    : [];
  if (role === "reader") await validateReadTargets(ctx.env.DB, targetIds);

  const expiresAt = input.key_expires_at ?? null;
  const createdAt = nowIso();
  const agentId = newEntityId("agent");
  const preparedKey = await prepareAgentKey(ctx.env, agentId, expiresAt, createdAt);
  const targetIdsJson = JSON.stringify(targetIds);

  try {
    const results = await createAgentAndKeyBatch(
      ctx.env.DB,
      {
        id: agentId,
        name: input.name,
        description: input.description ?? "",
        role,
        readMode,
        displayMode: input.display_mode ?? "feed",
        createdAt,
      },
      preparedKey.prepareInsert(ctx.env.DB),
      role === "reader" ? prepareReaderGrants(ctx.env.DB, agentId, targetIdsJson, createdAt) : null,
      role === "reader" ? { targetIdsJson } : null,
    );
    // 事务内的目标校验不通过时整条语句影响 0 行，身份、授权与密钥都没有提交。
    if ((results[0]?.meta.changes ?? 0) !== 1) {
      await validateReadTargets(ctx.env.DB, targetIds);
      throw badRequest("只读身份未能创建，请重试");
    }
  } catch (error) {
    if (isUniqueConstraintError(error) && role === "manager") {
      throw conflict("已经存在启用中的总管 Agent，请先停用旧总管");
    }
    throw error;
  }

  return { agent: await findRequiredAgent(ctx, agentId), key: preparedKey.plaintext };
}

export async function updateAgent(ctx: ServiceContext, agentId: string, input: UpdateAgentInput): Promise<AgentDto> {
  requireAdmin(ctx);
  const current = await findRequiredAgent(ctx, agentId);
  if (current.status === "deleting") throw conflict("Agent 正在永久删除，不能修改配置");

  if (input.main_entry_id !== undefined && input.main_entry_id !== null) {
    const belongs = await agentOwnsEntry(ctx.env.DB, agentId, input.main_entry_id);
    if (!belongs) throw conflict("主报告必须是该 Agent 自己的条目");
  }

  const changed = await updateAgentConfig(ctx.env.DB, agentId, input);
  if (!changed) throw conflict("Agent 配置已变化，请刷新后重试");
  return findRequiredAgent(ctx, agentId);
}

async function transitionAgent(
  ctx: ServiceContext,
  agentId: string,
  from: AgentStatus,
  to: AgentStatus,
): Promise<AgentDto> {
  requireAdmin(ctx);
  const current = await findRequiredAgent(ctx, agentId);
  if (current.id === "manual") throw forbidden("手动记录分区不能启停或恢复");
  if (current.role === "reader" && to === "active" && current.read_mode === null) {
    throw conflict("只读身份缺少读取范围配置，不能启用");
  }
  if (current.status === to) return current;
  if (current.status !== from) throw conflict(`Agent 当前状态为 ${current.status}，不能切换为 ${to}`);

  try {
    const changed = await setAgentStatus(ctx.env.DB, agentId, from, to);
    if (!changed) throw conflict("Agent 状态已变化，请刷新后重试");
  } catch (error) {
    if (isUniqueConstraintError(error) && current.role === "manager" && to === "active") {
      throw conflict("已经存在启用中的总管 Agent，请先停用旧总管");
    }
    throw error;
  }
  return findRequiredAgent(ctx, agentId);
}

export function enableAgent(ctx: ServiceContext, agentId: string): Promise<AgentDto> {
  return transitionAgent(ctx, agentId, "disabled", "active");
}

export function disableAgent(ctx: ServiceContext, agentId: string): Promise<AgentDto> {
  return transitionAgent(ctx, agentId, "active", "disabled");
}

export async function removeAgent(ctx: ServiceContext, agentId: string): Promise<AgentDto> {
  requireAdmin(ctx);
  const current = await findRequiredAgent(ctx, agentId);
  if (current.id === "manual") throw forbidden("手动记录分区不能移除");
  if (current.status === "removed") return current;
  if (current.status === "deleting") throw conflict("Agent 正在永久删除");

  const changed = await removeAndRevokeBatch(ctx.env.DB, agentId, nowIso());
  if (!changed) throw conflict("Agent 状态已变化，请刷新后重试");
  return findRequiredAgent(ctx, agentId);
}

export function restoreAgent(ctx: ServiceContext, agentId: string): Promise<AgentDto> {
  return transitionAgent(ctx, agentId, "removed", "disabled");
}

export async function getSelfAgent(ctx: ServiceContext): Promise<AgentDto> {
  const agentId = requireAgentActor(ctx, "agent");
  return findRequiredAgent(ctx, agentId);
}

export async function reportRun(ctx: ServiceContext, input: ReportInput): Promise<AgentDto> {
  const agentId = requireActiveAgentActor(ctx);
  const changed = await updateLastReport(ctx.env.DB, agentId, input.result, input.note ?? null, nowIso());
  if (!changed) throw conflict("Agent 已停用或状态已变化");
  return findRequiredAgent(ctx, agentId);
}
