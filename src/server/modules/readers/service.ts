import type { Page, ReaderSelfDto, ReaderSourceDto } from "../../../shared/contracts";
import { LIMITS } from "../../../shared/limits";
import type { ServiceContext } from "../../env";
import { readerScopeOf, requireReaderActor } from "../../shared/authorize";
import { badRequest, notFound } from "../../shared/errors";
import { cursorScopeFor, decodeCursor, encodeCursor, queryFingerprint } from "../../shared/pagination";
import { listReadableAgentRows, findReaderIdentity, type ReadableSourceRow } from "./repository";

export interface ReaderSourceQuery {
  cursor?: string;
  limit?: number;
}

/** 显式构造白名单字段，绝不直接序列化 AgentDto 或数据库整行。 */
function toReaderSourceDto(row: ReadableSourceRow): ReaderSourceDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    display_mode: row.display_mode,
    status: row.status,
    main_entry_id: row.main_entry_id,
  };
}

export async function getReaderSelf(ctx: ServiceContext): Promise<ReaderSelfDto> {
  const actor = ctx.actor;
  requireReaderActor(actor);
  const row = await findReaderIdentity(ctx.env.DB, actor.agentId);
  if (!row) throw notFound("身份不存在");
  return {
    id: actor.agentId,
    name: row.name,
    description: row.description,
    role: "reader",
    mode: actor.readMode,
    permissions_revision: actor.permissionsRevision,
  };
}

export async function listReadableAgents(
  ctx: ServiceContext,
  query: ReaderSourceQuery,
): Promise<Page<ReaderSourceDto>> {
  const actor = ctx.actor;
  requireReaderActor(actor);
  if (query.cursor && query.cursor.length > 2_048) throw badRequest("分页游标过长");

  const limit = Math.min(query.limit ?? LIMITS.defaultPageSize, LIMITS.maxPageSize);
  const fingerprint = queryFingerprint({ resource: "reader_sources", limit });
  const cursor = decodeCursor(query.cursor, fingerprint, cursorScopeFor(actor));
  if (cursor !== null && cursor.length !== 1) throw badRequest("分页游标内容无效");

  const result = await listReadableAgentRows(ctx.env.DB, readerScopeOf(actor), {
    ...(cursor?.[0] === undefined ? {} : { afterId: cursor[0] }),
    limit,
  });
  const last = result.items.at(-1);
  return {
    items: result.items.map(toReaderSourceDto),
    next_cursor: result.hasMore && last
      ? encodeCursor([last.id], fingerprint, cursorScopeFor(actor))
      : null,
  };
}
