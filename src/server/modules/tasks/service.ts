import type {
  CreateTaskInput,
  Page,
  PatchTaskInput,
  TaskDto,
} from "../../../shared/contracts";
import { LIMITS } from "../../../shared/limits";
import type { TaskQuery } from "../../../shared/validation";
import type { ServiceContext } from "../../env";
import {
  assertCanWriteOwner,
  readerScopeOf,
  requireAdminActor,
  requireManagerActor,
  requireOwnAgentActor,
  requireReaderActor,
  resolveReadScope,
  type ReaderScope,
} from "../../shared/authorize";
import { badRequest, conflict, forbidden, notFound } from "../../shared/errors";
import { newEntityId, nowIso } from "../../shared/ids";
import { cursorScopeFor, decodeCursor, encodeCursor, queryFingerprint } from "../../shared/pagination";
import { findReadableSource } from "../readers/repository";
import {
  deleteTask as deleteTaskRecord,
  findEntryOwner,
  findTask,
  insertTask,
  listTasks as listTaskRecords,
  patchTask,
  taskDto,
} from "./repository";

/** 只读身份不能复用这个入口：待办写入一律要求可写角色。 */
function assertSupportedTaskActor(ctx: ServiceContext): void {
  if (ctx.actor.type === "admin") return;
  if (ctx.actor.role === "reader") throw forbidden("只读身份不能修改业务数据");
  if (ctx.actor.role === "agent") {
    requireOwnAgentActor(ctx.actor);
    return;
  }
  requireManagerActor(ctx.actor);
}

/**
 * 待办读取的只读分支。显式指定来源时必须落在授权范围内，越权与不存在
 * 返回同样的 404，不通过错误消息透露来源名称。
 */
async function readerAccessForList(
  ctx: ServiceContext,
  requestedAgentId: string | undefined,
): Promise<ReaderScope | null> {
  const actor = ctx.actor;
  if (actor.type !== "agent" || actor.role !== "reader") return null;
  requireReaderActor(actor);
  const reader = readerScopeOf(actor);
  if (requestedAgentId !== undefined) {
    const readable = await findReadableSource(ctx.env.DB, reader, requestedAgentId);
    if (!readable) throw notFound("来源不存在");
  }
  return reader;
}

function effectiveOwnerForRead(ctx: ServiceContext, requestedAgentId?: string): string | undefined {
  assertSupportedTaskActor(ctx);
  if (
    ctx.actor.type === "agent"
    && ctx.actor.role === "agent"
    && requestedAgentId !== undefined
    && requestedAgentId !== ctx.actor.agentId
  ) {
    throw forbidden();
  }
  const scope = resolveReadScope(ctx.actor, requestedAgentId);
  return scope.agentId;
}

export async function listTasks(ctx: ServiceContext, query: TaskQuery): Promise<Page<TaskDto>> {
  const readerAccess = await readerAccessForList(ctx, query.agent_id);
  // 只读身份不用单个 owner 过滤；授权范围由 SQL 谓词决定。
  const agentId = readerAccess === null ? effectiveOwnerForRead(ctx, query.agent_id) : query.agent_id;
  const done = query.done === "yes" ? true : query.done === "no" ? false : undefined;
  const limit = query.limit ?? LIMITS.defaultPageSize;
  // 只读身份保留授权来源的已完成和归档关联记录，便于汇总与去重，
  // 因此只有管理员才按网页规则隐藏归档条目。
  const excludeArchivedEntries = ctx.actor.type === "admin";
  const fingerprint = queryFingerprint({
    agentId: agentId ?? null,
    done: query.done ?? "all",
    excludeArchivedEntries,
    order: "id_asc",
  });
  const cursor = decodeCursor(query.cursor, fingerprint, cursorScopeFor(ctx.actor));
  if (cursor !== null && cursor.length !== 1) throw badRequest("分页游标无效");

  const rows = await listTaskRecords(ctx.env.DB, {
    excludeArchivedEntries,
    ...(agentId === undefined ? {} : { agentId }),
    ...(readerAccess === null ? {} : { readerAccess }),
    ...(done === undefined ? {} : { done }),
    ...(cursor?.[0] === undefined ? {} : { afterId: cursor[0] }),
    limit: limit + 1,
  });
  const hasMore = rows.length > limit;
  const visibleRows = hasMore ? rows.slice(0, limit) : rows;
  const last = visibleRows.at(-1);

  return {
    items: visibleRows.map(taskDto),
    next_cursor: hasMore && last
      ? encodeCursor([last.id], fingerprint, cursorScopeFor(ctx.actor))
      : null,
  };
}

async function resolveCreateOwner(
  ctx: ServiceContext,
  input: CreateTaskInput,
): Promise<{ ownerId: string; entryId: string | null }> {
  assertSupportedTaskActor(ctx);
  const entryId = input.entry_id ?? null;
  if (entryId !== null) {
    const ownOwner = ctx.actor.type === "agent" && ctx.actor.role === "agent"
      ? ctx.actor.agentId
      : undefined;
    const entry = await findEntryOwner(ctx.env.DB, entryId, ownOwner);
    if (!entry) throw notFound("关联条目不存在");
    if (input.agent_id !== undefined && input.agent_id !== entry.agent_id) {
      throw badRequest("待办归属必须与关联条目一致");
    }
    assertCanWriteOwner(ctx.actor, entry.agent_id);
    return { ownerId: entry.agent_id, entryId };
  }

  if (ctx.actor.type === "admin") {
    const ownerId = input.agent_id ?? "manual";
    assertCanWriteOwner(ctx.actor, ownerId);
    return { ownerId, entryId: null };
  }
  if (ctx.actor.role === "agent") {
    if (input.agent_id !== undefined && input.agent_id !== ctx.actor.agentId) throw forbidden();
    assertCanWriteOwner(ctx.actor, ctx.actor.agentId);
    return { ownerId: ctx.actor.agentId, entryId: null };
  }
  if (input.agent_id === undefined) {
    throw badRequest("总管创建独立待办时必须指定 agent_id");
  }
  assertCanWriteOwner(ctx.actor, input.agent_id);
  return { ownerId: input.agent_id, entryId: null };
}

export async function createTask(ctx: ServiceContext, input: CreateTaskInput): Promise<TaskDto> {
  const { ownerId, entryId } = await resolveCreateOwner(ctx, input);
  const row = await insertTask(ctx.env.DB, {
    id: newEntityId("task"),
    agentId: ownerId,
    entryId,
    title: input.title,
    dueAt: input.due_at ?? null,
    createdAt: nowIso(),
  }, ctx.actor.type === "admin");
  if (!row) {
    throw conflict("目标 Agent 或关联条目的状态已变化，请刷新后重试");
  }
  return taskDto(row);
}

function taskOwnerFilter(ctx: ServiceContext): string | undefined {
  assertSupportedTaskActor(ctx);
  return ctx.actor.type === "agent" && ctx.actor.role === "agent"
    ? ctx.actor.agentId
    : undefined;
}

export async function updateTask(
  ctx: ServiceContext,
  id: string,
  input: PatchTaskInput,
): Promise<TaskDto> {
  if (Object.keys(input).length === 0) throw badRequest("至少提供一个待办修改字段");
  const ownerFilter = taskOwnerFilter(ctx);
  const existing = await findTask(ctx.env.DB, id, ownerFilter);
  if (!existing) throw notFound("待办不存在");
  assertCanWriteOwner(ctx.actor, existing.agent_id);

  const row = await patchTask(ctx.env.DB, id, ownerFilter, {
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.due_at === undefined ? {} : { dueAt: input.due_at }),
    ...(input.done === undefined ? {} : { done: input.done }),
  }, ctx.actor.type === "admin" ? "not_deleting" : "active");
  if (!row) throw conflict("待办或所属 Agent 的状态已变化，请刷新后重试");
  return taskDto(row);
}

export async function deleteTask(ctx: ServiceContext, id: string): Promise<void> {
  if (ctx.actor.type === "agent" && ctx.actor.role === "manager") {
    throw forbidden("总管 Agent 不能删除待办");
  }
  if (ctx.actor.type === "admin") {
    requireAdminActor(ctx.actor);
  } else {
    requireOwnAgentActor(ctx.actor);
  }
  const ownerId = ctx.actor.type === "agent" ? ctx.actor.agentId : undefined;
  const deleted = await deleteTaskRecord(
    ctx.env.DB,
    id,
    ownerId,
    ctx.actor.type === "admin" ? "not_deleting" : "active",
  );
  if (!deleted) throw notFound("待办不存在");
}
