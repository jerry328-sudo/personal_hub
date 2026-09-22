import type {
  ReadAccessDto,
  ReadAccessSourceDto,
  UpdateReadAccessInput,
} from "../../../shared/contracts";
import type { ServiceContext } from "../../env";
import type { AgentAccessMode, AgentReadMode, AgentScope, AgentStatus } from "../../env";
import { recordReaderAccessChange } from "../../shared/access-log";
import { requireAdminActor } from "../../shared/authorize";
import { badRequest, conflict, notFound } from "../../shared/errors";
import { nowIso } from "../../shared/ids";
import {
  findReaderAccessRow,
  listReadAccessSources,
  replaceReaderAccessBatch,
  type ReadAccessSourceRow,
} from "./repository";

type TargetRow = {
  id: string;
  scope: AgentScope;
  access_mode: AgentAccessMode;
  read_mode: AgentReadMode | null;
  status: AgentStatus;
};

/** 规范化目标清单：去重并排序，让授权表的写入顺序稳定可复现。 */
export function normalizeReadTargets(mode: AgentReadMode, agentIds: readonly string[]): string[] {
  if (mode === "all") return [];
  return [...new Set(agentIds)].sort();
}

/**
 * 授权目标必须是在存、可写的普通内容分区（含 manual），
 * 不能是总管或其他只读身份，也不能是正在永久删除的来源。
 * 这里是提交前的快速反馈，事务内的同名校验才是最终保证。
 */
export async function validateReadTargets(
  db: D1Database,
  targetIds: readonly string[],
): Promise<void> {
  if (targetIds.length === 0) return;
  const result = await db.prepare(`
    SELECT a.id, a.scope, a.access_mode, a.read_mode, a.status
    FROM json_each(?) AS target
    INNER JOIN agents AS a ON a.id = target.value
  `).bind(JSON.stringify(targetIds)).all<TargetRow>();

  const byId = new Map(result.results.map((row) => [row.id, row]));
  const invalid: string[] = [];
  for (const id of targetIds) {
    const row = byId.get(id);
    if (!row) {
      invalid.push(id);
      continue;
    }
    const writablePartition =
      row.scope === "own" && row.access_mode === "read_write" && row.read_mode === null;
    if (!writablePartition || row.status === "deleting") invalid.push(id);
  }
  if (invalid.length > 0) {
    throw badRequest("授权的来源无效或不可授权", { agents: invalid.slice(0, 10) });
  }
}

function toSourceDto(row: ReadAccessSourceRow): ReadAccessSourceDto {
  return { id: row.id, name: row.name, status: row.status };
}

export async function getReaderAccess(ctx: ServiceContext, readerId: string): Promise<ReadAccessDto> {
  requireAdminActor(ctx.actor);
  const row = await findReaderAccessRow(ctx.env.DB, readerId);
  if (row === null) throw notFound("Agent 不存在");
  if (row.access_mode !== "read_only") throw conflict("该身份不是只读 Agent");
  if (row.read_mode !== "selected" && row.read_mode !== "all") {
    throw conflict("该只读身份缺少读取范围配置");
  }
  const sources = await listReadAccessSources(ctx.env.DB, readerId);
  return {
    agent_id: readerId,
    mode: row.read_mode,
    revision: row.permissions_revision,
    sources: sources.map(toSourceDto),
  };
}

export async function replaceReaderAccess(
  ctx: ServiceContext,
  readerId: string,
  input: UpdateReadAccessInput,
): Promise<ReadAccessDto> {
  requireAdminActor(ctx.actor);
  const targetIds = normalizeReadTargets(input.mode, input.agent_ids ?? []);
  await validateReadTargets(ctx.env.DB, targetIds);

  const previous = await findReaderAccessRow(ctx.env.DB, readerId);
  const outcome = await replaceReaderAccessBatch(ctx.env.DB, {
    readerId,
    baseRevision: input.base_revision,
    readMode: input.mode,
    targetIds,
    createdAt: nowIso(),
  });

  const logRejection = (result: "rejected"): void => {
    recordReaderAccessChange({
      requestId: ctx.requestId,
      readerAgentId: readerId,
      previousRevision: previous?.permissions_revision ?? null,
      revision: input.base_revision,
      mode: input.mode,
      sourceCount: targetIds.length,
      result,
    });
  };

  switch (outcome.status) {
    case "not_found":
      logRejection("rejected");
      throw notFound("Agent 不存在");
    case "not_reader":
      logRejection("rejected");
      throw conflict("该身份不是可配置的只读 Agent");
    case "revision_conflict":
      logRejection("rejected");
      throw conflict("读取范围已被其他操作修改，请重新加载后再保存");
    case "invalid_target":
      logRejection("rejected");
      throw badRequest("授权的来源状态已变化，请刷新后重试");
    default:
      break;
  }

  recordReaderAccessChange({
    requestId: ctx.requestId,
    readerAgentId: readerId,
    previousRevision: previous?.permissions_revision ?? null,
    revision: outcome.revision,
    mode: outcome.readMode,
    sourceCount: outcome.sources.length,
    result: "updated",
  });
  return {
    agent_id: readerId,
    mode: outcome.readMode,
    revision: outcome.revision,
    sources: outcome.sources.map(toSourceDto),
  };
}
