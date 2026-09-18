import type { ValidatedImageUpload } from "./validation";

export interface AgentObjectPage {
  keys: string[];
  truncated: boolean;
  cursor: string | null;
}

export function agentObjectPrefix(agentId: string): string {
  return `agents/${encodeURIComponent(agentId)}/`;
}

export function makeObjectKey(agentId: string): string {
  return `${agentObjectPrefix(agentId)}${crypto.randomUUID()}`;
}

export async function putImage(
  bucket: R2Bucket,
  objectKey: string,
  image: ValidatedImageUpload,
): Promise<boolean> {
  const stored = await bucket.put(objectKey, image.bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: {
      contentType: image.contentType,
      cacheControl: "private, no-store",
    },
  });
  return stored !== null;
}

export function getImage(bucket: R2Bucket, objectKey: string): Promise<R2ObjectBody | null> {
  return bucket.get(objectKey);
}

export function deleteImage(bucket: R2Bucket, objectKey: string): Promise<void> {
  return bucket.delete(objectKey);
}

export async function listAgentObjects(
  bucket: R2Bucket,
  agentId: string,
  limit: number,
  cursor?: string,
): Promise<AgentObjectPage> {
  const result = await bucket.list({
    prefix: agentObjectPrefix(agentId),
    limit,
    ...(cursor ? { cursor } : {}),
  });
  return {
    keys: result.objects.map((object) => object.key),
    truncated: result.truncated,
    cursor: result.truncated ? result.cursor : null,
  };
}

export async function compensateFailedUpload(
  bucket: R2Bucket,
  objectKey: string,
  requestId: string,
): Promise<boolean> {
  try {
    await deleteImage(bucket, objectKey);
    return true;
  } catch {
    console.error(JSON.stringify({
      event: "attachment_upload_compensation_failed",
      object_key: objectKey,
      request_id: requestId,
    }));
    return false;
  }
}
