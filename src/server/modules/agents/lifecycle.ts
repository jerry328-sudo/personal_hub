import type { PurgeProgressDto } from "../../../shared/contracts";
import type { ServiceContext } from "../../env";
import { conflict, forbidden } from "../../shared/errors";
import { nowIso } from "../../shared/ids";
import {
  beginAgentDeletionBatch,
  countAgentAttachments,
  finalizeAgentDeletionBatch,
  findAgent,
} from "./repository";

const ATTACHMENT_PURGE_BATCH_SIZE = 50;

export interface AgentPurgeDependencies {
  purgeAttachmentsStep(
    ctx: ServiceContext,
    agentId: string,
    limit: number,
  ): Promise<PurgeProgressDto>;
}

function requireAdmin(ctx: ServiceContext): void {
  if (ctx.actor.type !== "admin") throw forbidden("只有管理员可以永久删除 Agent");
}

export async function beginAgentPurge(ctx: ServiceContext, agentId: string): Promise<boolean> {
  requireAdmin(ctx);
  const agent = await findAgent(ctx.env.DB, agentId);
  if (agent === null) return false;
  if (agent.id === "manual") throw forbidden("手动记录分区不能删除");
  if (agent.status === "deleting") return true;

  const changed = await beginAgentDeletionBatch(ctx.env.DB, agentId, nowIso());
  if (changed) return true;

  const current = await findAgent(ctx.env.DB, agentId);
  if (current === null) return false;
  if (current.status === "deleting") return true;
  throw conflict("Agent 状态已变化，请刷新后重试");
}

export async function finalizeAgentPurge(
  ctx: ServiceContext,
  agentId: string,
  removedObjects: number,
): Promise<PurgeProgressDto> {
  requireAdmin(ctx);
  const remainingObjects = await countAgentAttachments(ctx.env.DB, agentId);
  if (remainingObjects > 0) {
    return { agent_id: agentId, status: "pending", removed_objects: removedObjects, remaining_objects: remainingObjects };
  }

  const deleted = await finalizeAgentDeletionBatch(ctx.env.DB, agentId);
  if (deleted) {
    return { agent_id: agentId, status: "done", removed_objects: removedObjects, remaining_objects: 0 };
  }

  const current = await findAgent(ctx.env.DB, agentId);
  if (current === null) {
    return { agent_id: agentId, status: "done", removed_objects: removedObjects, remaining_objects: 0 };
  }
  if (current.status !== "deleting") throw conflict("Agent 状态已变化，请刷新后重试");

  return { agent_id: agentId, status: "pending", removed_objects: removedObjects, remaining_objects: 0 };
}

export async function purgeAgentStep(
  ctx: ServiceContext,
  agentId: string,
  dependencies: AgentPurgeDependencies,
): Promise<PurgeProgressDto> {
  const exists = await beginAgentPurge(ctx, agentId);
  if (!exists) {
    return {
      agent_id: agentId,
      status: "done",
      removed_objects: 0,
      remaining_objects: 0,
    };
  }

  const attachmentProgress = await dependencies.purgeAttachmentsStep(
    ctx,
    agentId,
    ATTACHMENT_PURGE_BATCH_SIZE,
  );
  if (attachmentProgress.remaining_objects > 0) {
    return {
      agent_id: agentId,
      status: "pending",
      removed_objects: attachmentProgress.removed_objects,
      remaining_objects: attachmentProgress.remaining_objects,
    };
  }

  return finalizeAgentPurge(ctx, agentId, attachmentProgress.removed_objects);
}
