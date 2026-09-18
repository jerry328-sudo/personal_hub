import type { AttachmentDto, PurgeProgressDto } from "../../../shared/contracts";
import { attachmentIdFromUrl } from "../../../shared/markdown";
import type { Actor, ServiceContext } from "../../env";
import { badRequest, conflict, forbidden, notFound } from "../../shared/errors";
import { applyPrivateHeaders } from "../../shared/http";
import { newEntityId, nowIso } from "../../shared/ids";
import {
  acquireAttachmentUploadLease,
  cleanupDeletedAttachmentObject,
  commitAttachmentMetadata,
  countAgentAttachments,
  countAgentAttachmentUploadLeases,
  findActiveUploadLeaseObjectKeys,
  findAttachment,
  findAttachmentOwnerTarget,
  findAttachmentsByIds,
  listExpiredAttachmentUploadLeases,
  listPurgeableAgentAttachments,
  releaseAttachmentUploadLease,
  type AttachmentRow,
  type AttachmentUploadLeaseRow,
} from "./repository";
import {
  compensateFailedUpload,
  deleteImage,
  getImage,
  listAgentObjects,
  makeObjectKey,
  putImage,
} from "./storage";
import { extractMarkdownImageUrls, readImageUpload } from "./validation";

const MAX_ENTRY_IMAGE_REFERENCES = 100;
export const ATTACHMENT_UPLOAD_LEASE_TTL_MS = 5 * 60 * 1000;

function attachmentDto(row: AttachmentRow): AttachmentDto {
  return {
    id: row.id,
    agent_id: row.agent_id,
    url: `/api/v1/media/${row.id}`,
    filename: row.filename,
    content_type: row.content_type,
    size: row.size,
    created_at: row.created_at,
  };
}

function assertActiveAgentActor(actor: Actor): void {
  if (actor.type === "agent" && actor.status !== "active") {
    throw forbidden("当前 Agent 已停用，不能访问附件");
  }
}

function assertOwnerAccess(actor: Actor, ownerId: string): void {
  assertActiveAgentActor(actor);
  if (actor.type === "agent" && actor.scope === "own" && actor.agentId !== ownerId) {
    throw forbidden();
  }
}

function createdBy(actor: Actor): string {
  return actor.type === "admin" ? "manual" : actor.agentId;
}

async function requireActiveUploadTarget(
  ctx: ServiceContext,
  ownerId: string,
): Promise<void> {
  assertOwnerAccess(ctx.actor, ownerId);
  const target = await findAttachmentOwnerTarget(ctx.env.DB, ownerId);
  if (target === null) throw notFound("目标 Agent 不存在");
  if (target.scope !== "own") throw forbidden("附件只能归属普通 Agent");
  if (target.status !== "active") throw conflict("目标 Agent 当前不可写入附件");
}

async function releaseLeaseAfterObjectCleanup(
  ctx: ServiceContext,
  lease: AttachmentUploadLeaseRow,
): Promise<void> {
  const cleaned = await compensateFailedUpload(
    ctx.env.MEDIA,
    lease.object_key,
    ctx.requestId,
  );
  if (!cleaned) return;
  try {
    await releaseAttachmentUploadLease(ctx.env.DB, lease);
  } catch {
    console.error(JSON.stringify({
      event: "attachment_upload_lease_release_failed",
      attachment_id: lease.id,
      object_key: lease.object_key,
      request_id: ctx.requestId,
    }));
  }
}

async function uploadStateChangedError(ctx: ServiceContext, ownerId: string): Promise<Error> {
  const target = await findAttachmentOwnerTarget(ctx.env.DB, ownerId);
  if (target === null) return notFound("目标 Agent 不存在");
  if (target.scope !== "own") return forbidden("附件只能归属普通 Agent");
  return conflict("目标 Agent 状态已变化，附件没有保存");
}

export async function uploadAttachment(
  ctx: ServiceContext,
  ownerId: string,
  request: Request,
): Promise<AttachmentDto> {
  await requireActiveUploadTarget(ctx, ownerId);
  const image = await readImageUpload(request);
  const createdAt = nowIso();
  const id = newEntityId("att");
  const objectKey = makeObjectKey(ownerId);
  const lease: AttachmentUploadLeaseRow = {
    id,
    agent_id: ownerId,
    object_key: objectKey,
    created_at: createdAt,
    expires_at: new Date(Date.parse(createdAt) + ATTACHMENT_UPLOAD_LEASE_TTL_MS).toISOString(),
  };
  const row: AttachmentRow = {
    id,
    agent_id: ownerId,
    object_key: objectKey,
    filename: image.filename,
    content_type: image.contentType,
    size: image.size,
    created_by_agent_id: createdBy(ctx.actor),
    created_at: createdAt,
  };

  const leased = await acquireAttachmentUploadLease(
    ctx.env.DB,
    lease,
    ctx.actor.type === "agent" ? ctx.actor.agentId : null,
  );
  if (!leased) throw await uploadStateChangedError(ctx, ownerId);

  let stored: boolean;
  try {
    stored = await putImage(ctx.env.MEDIA, objectKey, image);
  } catch (error) {
    await releaseLeaseAfterObjectCleanup(ctx, lease);
    throw error;
  }
  if (!stored) {
    await releaseAttachmentUploadLease(ctx.env.DB, lease);
    throw conflict("图片对象键冲突，请重新上传");
  }

  let committed: Awaited<ReturnType<typeof commitAttachmentMetadata>>;
  try {
    committed = await commitAttachmentMetadata(
      ctx.env.DB,
      row,
      ctx.actor.type === "agent" ? ctx.actor.agentId : null,
    );
  } catch (error) {
    const existing = await findAttachment(ctx.env.DB, id);
    if (existing === null) await releaseLeaseAfterObjectCleanup(ctx, lease);
    throw error;
  }
  if (!committed.inserted) {
    await releaseLeaseAfterObjectCleanup(ctx, lease);
    throw await uploadStateChangedError(ctx, ownerId);
  }
  if (!committed.leaseReleased) {
    console.error(JSON.stringify({
      event: "attachment_committed_lease_retained",
      attachment_id: id,
      object_key: objectKey,
      request_id: ctx.requestId,
    }));
  }
  return attachmentDto(row);
}

export async function getAttachmentMedia(ctx: ServiceContext, id: string): Promise<Response> {
  const attachment = await findAttachment(ctx.env.DB, id);
  if (!attachment) throw notFound("图片不存在");
  if (
    ctx.actor.type === "agent"
    && ctx.actor.scope === "own"
    && ctx.actor.agentId !== attachment.agent_id
  ) {
    throw notFound("图片不存在");
  }
  assertOwnerAccess(ctx.actor, attachment.agent_id);

  const object = await getImage(ctx.env.MEDIA, attachment.object_key);
  if (!object) {
    console.error(JSON.stringify({
      event: "attachment_object_missing",
      attachment_id: attachment.id,
      object_key: attachment.object_key,
      request_id: ctx.requestId,
    }));
    throw notFound("图片不存在");
  }

  const headers = new Headers({
    "Content-Type": attachment.content_type,
    "Content-Length": String(object.size),
  });
  applyPrivateHeaders(headers);
  return new Response(object.body, { status: 200, headers });
}

export async function validateEntryAttachments(
  ctx: ServiceContext,
  ownerId: string,
  markdown: string,
): Promise<void> {
  assertOwnerAccess(ctx.actor, ownerId);
  const imageUrls = extractMarkdownImageUrls(markdown);
  if (imageUrls.length > MAX_ENTRY_IMAGE_REFERENCES) {
    throw badRequest(`单篇正文最多引用 ${MAX_ENTRY_IMAGE_REFERENCES} 张图片`);
  }
  const unsupported = imageUrls.filter((url) => attachmentIdFromUrl(url) === null);
  if (unsupported.length > 0) {
    throw badRequest("正文图片只能引用本站已上传附件", { urls: unsupported.slice(0, 5) });
  }

  const ids = [...new Set(
    imageUrls.map(attachmentIdFromUrl).filter((id): id is string => id !== null),
  )];
  if (ids.length === 0) return;
  const attachments = await findAttachmentsByIds(ctx.env.DB, ids);
  const allowed = new Set(
    attachments.filter((attachment) => attachment.agent_id === ownerId).map((attachment) => attachment.id),
  );
  if (ids.some((id) => !allowed.has(id))) {
    throw badRequest("正文引用了不存在或不属于目标 Agent 的图片");
  }
}

async function deleteObjectAndRecords(
  ctx: ServiceContext,
  agentId: string,
  objectKey: string,
  now: string,
  event: string,
  attachmentId?: string,
): Promise<boolean> {
  try {
    await deleteImage(ctx.env.MEDIA, objectKey);
    await cleanupDeletedAttachmentObject(ctx.env.DB, agentId, objectKey, now);
    return true;
  } catch {
    console.error(JSON.stringify({
      event,
      ...(attachmentId ? { attachment_id: attachmentId } : {}),
      object_key: objectKey,
      request_id: ctx.requestId,
    }));
    return false;
  }
}

async function removeExpiredLeases(
  ctx: ServiceContext,
  agentId: string,
  now: string,
  limit: number,
): Promise<number> {
  const leases = await listExpiredAttachmentUploadLeases(ctx.env.DB, agentId, now, limit);
  let removed = 0;
  for (const lease of leases) {
    if (await deleteObjectAndRecords(
      ctx,
      agentId,
      lease.object_key,
      now,
      "attachment_expired_lease_purge_failed",
      lease.id,
    )) removed += 1;
  }
  return removed;
}

async function removeMetadataBackedObjects(
  ctx: ServiceContext,
  agentId: string,
  now: string,
  limit: number,
): Promise<number> {
  const attachments = await listPurgeableAgentAttachments(ctx.env.DB, agentId, now, limit);
  let removed = 0;
  for (const attachment of attachments) {
    if (await deleteObjectAndRecords(
      ctx,
      agentId,
      attachment.object_key,
      now,
      "attachment_purge_failed",
      attachment.id,
    )) removed += 1;
  }
  return removed;
}

async function removeObjectsByPrefix(
  ctx: ServiceContext,
  agentId: string,
  now: string,
  limit: number,
): Promise<number> {
  if (limit < 1) return 0;
  const page = await listAgentObjects(ctx.env.MEDIA, agentId, limit);
  const protectedKeys = await findActiveUploadLeaseObjectKeys(
    ctx.env.DB,
    agentId,
    page.keys,
    now,
  );
  let removed = 0;
  for (const objectKey of page.keys) {
    if (protectedKeys.has(objectKey)) continue;
    if (await deleteObjectAndRecords(
      ctx,
      agentId,
      objectKey,
      now,
      "attachment_orphan_purge_failed",
    )) removed += 1;
  }
  return removed;
}

export async function purgeAgentAttachmentsStep(
  ctx: ServiceContext,
  agentId: string,
  limit: number,
): Promise<PurgeProgressDto> {
  if (ctx.actor.type !== "admin") throw forbidden();
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw badRequest("单次附件清理数量必须在 1 到 100 之间");
  }
  const target = await findAttachmentOwnerTarget(ctx.env.DB, agentId);
  if (target === null) throw notFound("Agent 不存在");
  if (target.status !== "deleting") throw conflict("只有正在删除的 Agent 可以清理附件");

  const now = nowIso();
  let removed = await removeExpiredLeases(ctx, agentId, now, limit);
  removed += await removeMetadataBackedObjects(ctx, agentId, now, limit - removed);
  removed += await removeObjectsByPrefix(ctx, agentId, now, limit - removed);

  const metadataRemaining = await countAgentAttachments(ctx.env.DB, agentId);
  const leaseRemaining = await countAgentAttachmentUploadLeases(ctx.env.DB, agentId);
  const objectProbe = await listAgentObjects(ctx.env.MEDIA, agentId, 1000);
  const objectRemaining = objectProbe.keys.length + (objectProbe.truncated ? 1 : 0);
  const remaining = Math.max(metadataRemaining, leaseRemaining, objectRemaining);
  return {
    agent_id: agentId,
    status: remaining === 0 ? "done" : "pending",
    removed_objects: removed,
    remaining_objects: remaining,
  };
}
