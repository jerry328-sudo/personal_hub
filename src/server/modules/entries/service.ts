import type {
  AppendVersionInput,
  CreateEntryInput,
  EntryBriefDto,
  EntryFullDto,
  EntryStateDto,
  EntryVersionBriefDto,
  EntryVersionDto,
  Page,
  PatchEntryStateInput,
} from "../../../shared/contracts";
import { LIMITS, utf8Size } from "../../../shared/limits";
import type { EntryQuery } from "../../../shared/validation";
import type { Actor, ServiceContext } from "../../env";
import {
  assertCanWriteOwner,
  createdByActor,
  requireAdminActor,
  requireManagerActor,
  requireOwnAgentActor,
  resolveReadScope,
} from "../../shared/authorize";
import { isUniqueConstraintError } from "../../shared/db";
import { AppError, badRequest, conflict, forbidden, notFound } from "../../shared/errors";
import { newEntityId, nowIso } from "../../shared/ids";
import { decodeCursor, encodeCursor, queryFingerprint } from "../../shared/pagination";
import { validateEntryAttachments } from "../attachments/service";
import {
  createEntryBatch,
  deleteEntryBatch,
  findCurrentEntry,
  findCurrentVersionNumber,
  findEntryOwnerStatus,
  findEntryState,
  findEntryWriteInfo,
  findOwnerWriteInfo,
  findVersion,
  insertVersionIfCurrent,
  listCurrentEntries,
  markMatchingEntriesRead,
  listVersions,
  patchEntryState,
  prepareCreateEntry,
  prepareCreateInitialVersion,
  type CurrentEntryQuery,
  type EntryListOrder,
  type EntryListView,
  type EntryWriteInfo,
  type OwnerWriteInfo,
} from "./repository";

export type EntryAudience = "agent" | "manager" | "admin";

export interface EntryMutationResult {
  id: string;
  version: number;
}

export interface VersionPageQuery {
  cursor?: string;
  limit?: number;
}

function assertAudience(actor: Actor, audience: EntryAudience): void {
  if (audience === "agent") requireOwnAgentActor(actor);
  else if (audience === "manager") requireManagerActor(actor);
  else requireAdminActor(actor);
}

function assertActiveEntryReader(actor: Actor): void {
  if (actor.type === "admin") return;
  if (actor.scope === "own") requireOwnAgentActor(actor);
  else requireManagerActor(actor);
}

function ensureWritableOwner(owner: OwnerWriteInfo | null): asserts owner is OwnerWriteInfo {
  if (!owner) throw notFound("目标 Agent 不存在");
  if (owner.scope !== "own") throw forbidden("总管身份不能作为内容归属");
  if (owner.status !== "active") throw forbidden("目标 Agent 当前不可写入");
}

function ensureWritableEntry(info: EntryWriteInfo | null): asserts info is EntryWriteInfo {
  if (!info) throw notFound("条目不存在");
  if (info.agentScope !== "own") throw forbidden("总管身份不能作为内容归属");
  if (info.agentStatus !== "active") throw forbidden("条目所属 Agent 当前不可写入");
}

function normalizeEntryQuery(
  actor: Actor,
  raw: EntryQuery,
  audience: EntryAudience,
): {
  query: CurrentEntryQuery;
  fingerprint: string;
} {
  const view: EntryListView = raw.view ?? (audience === "agent" ? "full" : "brief");
  const order: EntryListOrder = raw.order ?? (audience === "admin" ? "updated_desc" : "id_asc");
  const completion = raw.completion ?? "all";
  const archived = raw.archived ?? "all";
  const important = raw.important ?? "all";
  const limit = raw.limit ?? LIMITS.defaultPageSize;
  const search = raw.query?.trim() || undefined;
  const read = raw.read ?? "all";
  const time_field = raw.time_field ?? "updated";
  const start = raw.start ? new Date(raw.start).toISOString() : undefined;
  const end = raw.end ? new Date(raw.end).toISOString() : undefined;
  const requestedAgentId = raw.agent_id;

  if (raw.cursor && raw.cursor.length > 2_048) throw badRequest("分页游标过长");

  if (audience === "agent" && actor.type === "agent" && requestedAgentId && requestedAgentId !== actor.agentId) {
    throw forbidden();
  }

  const scope = resolveReadScope(actor, requestedAgentId);
  const fingerprint = queryFingerprint({
    resource: "entries",
    scope: scope.kind,
    owner: scope.kind === "own" ? scope.agentId : scope.agentId ?? null,
    view,
    order,
    completion,
    archived,
    important,
    query: search ?? null,
    read, time_field, start: start ?? null, end: end ?? null,
  });
  const cursor = decodeCursor(raw.cursor, fingerprint);
  const expectedCursorLength = order === "id_asc" ? 1 : 2;
  if (cursor && cursor.length !== expectedCursorLength) throw badRequest("分页游标格式无效");

  return {
    fingerprint,
    query: {
      view,
      order,
      completion,
      archived,
      important,
      read, time_field, start, end,
      // Full rows can each contain 256 KiB of Markdown. Keep the D1 result
      // bounded before applying the exact serialized-response budget below.
      limit: view === "full" ? Math.min(limit, 7) : limit,
      ...(search ? { query: search } : {}),
      cursor,
    },
  };
}

function entryCursor(item: EntryBriefDto | EntryFullDto, order: EntryListOrder): string[] {
  if (order === "id_asc") return [item.id];
  if (order === "created_asc") return [item.created_at, item.id];
  return [item.updated_at, item.id];
}

function fitResponseBudget<T>(items: T[]): { items: T[]; truncated: boolean } {
  const kept: T[] = [];
  // Reserve room for the response envelope and encoded continuation cursor.
  let bytes = 4_096;
  for (const item of items) {
    const itemBytes = utf8Size(JSON.stringify(item)) + 1;
    if (kept.length > 0 && bytes + itemBytes > LIMITS.responseBytes) break;
    kept.push(item);
    bytes += itemBytes;
  }
  return { items: kept, truncated: kept.length < items.length };
}

function readScopeFor(ctx: ServiceContext) {
  assertActiveEntryReader(ctx.actor);
  return resolveReadScope(ctx.actor);
}

export async function listEntries(
  ctx: ServiceContext,
  rawQuery: EntryQuery,
  audience: EntryAudience,
): Promise<Page<EntryBriefDto | EntryFullDto>> {
  assertAudience(ctx.actor, audience);
  const normalized = normalizeEntryQuery(ctx.actor, rawQuery, audience);
  const scope = resolveReadScope(ctx.actor, rawQuery.agent_id);
  const result = await listCurrentEntries(ctx.env.DB, scope, normalized.query);
  const fitted = fitResponseBudget(result.items);
  const hasMore = result.hasMore || fitted.truncated;
  const last = fitted.items.at(-1);
  return {
    items: fitted.items,
    next_cursor: hasMore && last
      ? encodeCursor(entryCursor(last, normalized.query.order), normalized.fingerprint)
      : null,
  };
}

export async function getEntry(ctx: ServiceContext, entryId: string): Promise<EntryFullDto> {
  const entry = await findCurrentEntry(ctx.env.DB, readScopeFor(ctx), entryId);
  if (!entry) throw notFound("条目不存在");
  return entry;
}

export async function markEntriesRead(ctx: ServiceContext, filters: EntryQuery): Promise<{ updated: number }> {
  requireAdminActor(ctx.actor);
  const { query } = normalizeEntryQuery(ctx.actor, filters, "admin");
  return { updated: await markMatchingEntriesRead(ctx.env.DB, resolveReadScope(ctx.actor, filters.agent_id), query) };
}

export async function createEntry(
  ctx: ServiceContext,
  targetAgentId: string,
  input: CreateEntryInput,
): Promise<EntryMutationResult> {
  assertCanWriteOwner(ctx.actor, targetAgentId);
  const owner = await findOwnerWriteInfo(ctx.env.DB, targetAgentId);
  ensureWritableOwner(owner);
  await validateEntryAttachments(ctx, targetAgentId, input.content);

  const id = newEntityId("entry");
  const createdAt = nowIso();
  const statements: [D1PreparedStatement, D1PreparedStatement] = [
    prepareCreateEntry(ctx.env.DB, id, targetAgentId, createdAt),
    prepareCreateInitialVersion(
      ctx.env.DB,
      id,
      targetAgentId,
      input,
      createdByActor(ctx.actor),
      createdAt,
    ),
  ];
  const result = await createEntryBatch(ctx.env.DB, statements);
  if (result.entryChanges !== 1 || result.versionChanges !== 1) {
    const currentOwner = await findOwnerWriteInfo(ctx.env.DB, targetAgentId);
    ensureWritableOwner(currentOwner);
    throw new AppError(500, "entry_create_failed", "条目未能完整创建");
  }
  return { id, version: 1 };
}

async function diagnoseAppendFailure(
  ctx: ServiceContext,
  entryId: string,
  baseVersion: number,
): Promise<never> {
  const current = await findEntryWriteInfo(ctx.env.DB, resolveReadScope(ctx.actor), entryId);
  ensureWritableEntry(current);
  if (current.currentVersion !== baseVersion) {
    throw conflict("条目已有新版本，请重新读取后再提交", { current_version: current.currentVersion });
  }
  throw conflict("条目版本在提交时发生变化", { current_version: current.currentVersion });
}

export async function appendEntryVersion(
  ctx: ServiceContext,
  entryId: string,
  input: AppendVersionInput,
): Promise<EntryMutationResult> {
  const scope = readScopeFor(ctx);
  const current = await findEntryWriteInfo(ctx.env.DB, scope, entryId);
  ensureWritableEntry(current);
  assertCanWriteOwner(ctx.actor, current.agentId);
  if (current.currentVersion !== input.base_version) {
    throw conflict("条目已有新版本，请重新读取后再提交", { current_version: current.currentVersion });
  }
  await validateEntryAttachments(ctx, current.agentId, input.content);

  try {
    const inserted = await insertVersionIfCurrent(
      ctx.env.DB,
      scope,
      entryId,
      input,
      createdByActor(ctx.actor),
      nowIso(),
    );
    if (!inserted) return await diagnoseAppendFailure(ctx, entryId, input.base_version);
  } catch (error) {
    if (isUniqueConstraintError(error)) return await diagnoseAppendFailure(ctx, entryId, input.base_version);
    throw error;
  }
  return { id: entryId, version: input.base_version + 1 };
}

export async function listEntryVersions(
  ctx: ServiceContext,
  entryId: string,
  page: VersionPageQuery,
): Promise<Page<EntryVersionBriefDto>> {
  const scope = readScopeFor(ctx);
  const visible = await findEntryWriteInfo(ctx.env.DB, scope, entryId);
  if (!visible) throw notFound("条目不存在");
  const limit = page.limit ?? LIMITS.defaultPageSize;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.maxPageSize) {
    throw badRequest("分页数量无效");
  }
  const fingerprint = queryFingerprint({ resource: "entry_versions", entry_id: entryId, order: "version_desc" });
  if (page.cursor && page.cursor.length > 2_048) throw badRequest("分页游标过长");
  const decoded = decodeCursor(page.cursor, fingerprint);
  if (decoded && decoded.length !== 1) throw badRequest("分页游标格式无效");
  const beforeVersion = decoded ? Number(decoded[0]) : null;
  if (beforeVersion !== null && (!Number.isSafeInteger(beforeVersion) || beforeVersion < 1)) {
    throw badRequest("分页游标格式无效");
  }
  const result = await listVersions(ctx.env.DB, scope, entryId, beforeVersion, limit);
  const last = result.items.at(-1);
  return {
    items: result.items,
    next_cursor: result.hasMore && last ? encodeCursor([String(last.version)], fingerprint) : null,
  };
}

export async function getEntryVersion(
  ctx: ServiceContext,
  entryId: string,
  version: number,
): Promise<EntryVersionDto> {
  const item = await findVersion(ctx.env.DB, readScopeFor(ctx), entryId, version);
  if (!item) throw notFound("条目或版本不存在");
  return item;
}

export async function updateEntryState(
  ctx: ServiceContext,
  entryId: string,
  input: PatchEntryStateInput,
): Promise<EntryStateDto> {
  requireAdminActor(ctx.actor);
  if (input.read_version !== undefined) {
    const currentVersion = await findCurrentVersionNumber(ctx.env.DB, entryId);
    if (currentVersion === null) throw notFound("条目不存在");
    if (input.read_version > currentVersion) {
      throw badRequest("已读版本不能超过当前版本", { current_version: currentVersion });
    }
  }
  const changed = await patchEntryState(ctx.env.DB, entryId, input, nowIso());
  if (!changed) {
    const state = await findEntryState(ctx.env.DB, entryId);
    if (!state) throw notFound("条目不存在");
    const ownerStatus = await findEntryOwnerStatus(ctx.env.DB, entryId);
    if (ownerStatus === "deleting") {
      throw conflict("条目所属 Agent 正在删除，不能修改处理状态");
    }
    throw conflict("条目状态在提交时发生变化，请刷新后重试");
  }
  const state = await findEntryState(ctx.env.DB, entryId);
  if (!state) throw notFound("条目不存在");
  return state;
}

export async function deleteEntry(ctx: ServiceContext, entryId: string): Promise<void> {
  requireAdminActor(ctx.actor);
  const state = await findEntryState(ctx.env.DB, entryId);
  if (!state) throw notFound("条目不存在");
  const deleted = await deleteEntryBatch(ctx.env.DB, entryId);
  if (!deleted) throw notFound("条目不存在");
}
