export interface AttachmentRow {
  id: string;
  agent_id: string;
  object_key: string;
  filename: string;
  content_type: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  size: number;
  created_by_agent_id: string;
  created_at: string;
}

export type NewAttachmentRow = AttachmentRow;

export interface AttachmentUploadLeaseRow {
  id: string;
  agent_id: string;
  object_key: string;
  created_at: string;
  expires_at: string;
}

export async function acquireAttachmentUploadLease(
  db: D1Database,
  lease: AttachmentUploadLeaseRow,
  writerAgentId: string | null,
): Promise<boolean> {
  const result = await db.prepare(`
    INSERT INTO attachment_upload_leases (
      id, agent_id, object_key, created_at, expires_at
    )
    SELECT ?, ?, ?, ?, ?
    FROM agents
    WHERE id = ? AND status = 'active' AND scope = 'own'
      AND (? IS NULL OR EXISTS (
        SELECT 1 FROM agents writer WHERE writer.id = ? AND writer.status = 'active'
      ))
  `).bind(
    lease.id,
    lease.agent_id,
    lease.object_key,
    lease.created_at,
    lease.expires_at,
    lease.agent_id,
    writerAgentId,
    writerAgentId,
  ).run();
  return (result.meta.changes ?? 0) === 1;
}

export interface CommitAttachmentResult {
  inserted: boolean;
  leaseReleased: boolean;
}

export async function commitAttachmentMetadata(
  db: D1Database,
  attachment: NewAttachmentRow,
  writerAgentId: string | null,
): Promise<CommitAttachmentResult> {
  const results = await db.batch([
    db.prepare(`
      INSERT INTO attachments (
        id, agent_id, object_key, filename, content_type, size, created_by_agent_id, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM agents
        WHERE id = ? AND status = 'active' AND scope = 'own'
      )
      AND (? IS NULL OR EXISTS (
        SELECT 1 FROM agents writer WHERE writer.id = ? AND writer.status = 'active'
      ))
      AND EXISTS (
        SELECT 1 FROM attachment_upload_leases
        WHERE id = ? AND agent_id = ? AND object_key = ?
      )
    `).bind(
      attachment.id,
      attachment.agent_id,
      attachment.object_key,
      attachment.filename,
      attachment.content_type,
      attachment.size,
      attachment.created_by_agent_id,
      attachment.created_at,
      attachment.agent_id,
      writerAgentId,
      writerAgentId,
      attachment.id,
      attachment.agent_id,
      attachment.object_key,
    ),
    db.prepare(`
      DELETE FROM attachment_upload_leases
      WHERE id = ? AND agent_id = ? AND object_key = ?
        AND EXISTS (
          SELECT 1 FROM attachments
          WHERE id = ? AND agent_id = ? AND object_key = ?
        )
    `).bind(
      attachment.id,
      attachment.agent_id,
      attachment.object_key,
      attachment.id,
      attachment.agent_id,
      attachment.object_key,
    ),
  ]);
  return {
    inserted: (results[0]?.meta.changes ?? 0) === 1,
    leaseReleased: (results[1]?.meta.changes ?? 0) === 1,
  };
}

export async function releaseAttachmentUploadLease(
  db: D1Database,
  lease: Pick<AttachmentUploadLeaseRow, "id" | "agent_id" | "object_key">,
): Promise<boolean> {
  const result = await db.prepare(`
    DELETE FROM attachment_upload_leases
    WHERE id = ? AND agent_id = ? AND object_key = ?
  `).bind(lease.id, lease.agent_id, lease.object_key).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function findAttachment(db: D1Database, id: string): Promise<AttachmentRow | null> {
  return db.prepare(`
    SELECT id, agent_id, object_key, filename, content_type, size, created_by_agent_id, created_at
    FROM attachments
    WHERE id = ?
  `).bind(id).first<AttachmentRow>();
}

export async function findAttachmentsByIds(
  db: D1Database,
  ids: readonly string[],
): Promise<AttachmentRow[]> {
  if (ids.length === 0) return [];
  const rows: AttachmentRow[] = [];
  const chunkSize = 50;
  for (let offset = 0; offset < ids.length; offset += chunkSize) {
    const chunk = ids.slice(offset, offset + chunkSize);
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await db.prepare(`
      SELECT id, agent_id, object_key, filename, content_type, size, created_by_agent_id, created_at
      FROM attachments
      WHERE id IN (${placeholders})
    `).bind(...chunk).all<AttachmentRow>();
    rows.push(...result.results);
  }
  return rows;
}

export async function listAgentAttachments(
  db: D1Database,
  agentId: string,
  limit: number,
): Promise<AttachmentRow[]> {
  const result = await db.prepare(`
    SELECT id, agent_id, object_key, filename, content_type, size, created_by_agent_id, created_at
    FROM attachments
    WHERE agent_id = ?
    ORDER BY id ASC
    LIMIT ?
  `).bind(agentId, limit).all<AttachmentRow>();
  return result.results;
}

export async function listPurgeableAgentAttachments(
  db: D1Database,
  agentId: string,
  now: string,
  limit: number,
): Promise<AttachmentRow[]> {
  const result = await db.prepare(`
    SELECT a.id, a.agent_id, a.object_key, a.filename, a.content_type, a.size,
           a.created_by_agent_id, a.created_at
    FROM attachments a
    WHERE a.agent_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM attachment_upload_leases lease
        WHERE lease.agent_id = a.agent_id
          AND lease.object_key = a.object_key
          AND lease.expires_at > ?
      )
    ORDER BY a.id ASC
    LIMIT ?
  `).bind(agentId, now, limit).all<AttachmentRow>();
  return result.results;
}

export async function listExpiredAttachmentUploadLeases(
  db: D1Database,
  agentId: string,
  now: string,
  limit: number,
): Promise<AttachmentUploadLeaseRow[]> {
  const result = await db.prepare(`
    SELECT id, agent_id, object_key, created_at, expires_at
    FROM attachment_upload_leases
    WHERE agent_id = ? AND expires_at <= ?
    ORDER BY expires_at ASC, id ASC
    LIMIT ?
  `).bind(agentId, now, limit).all<AttachmentUploadLeaseRow>();
  return result.results;
}

export async function findActiveUploadLeaseObjectKeys(
  db: D1Database,
  agentId: string,
  objectKeys: readonly string[],
  now: string,
): Promise<Set<string>> {
  const active = new Set<string>();
  const chunkSize = 50;
  for (let offset = 0; offset < objectKeys.length; offset += chunkSize) {
    const chunk = objectKeys.slice(offset, offset + chunkSize);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await db.prepare(`
      SELECT object_key
      FROM attachment_upload_leases
      WHERE agent_id = ? AND expires_at > ? AND object_key IN (${placeholders})
    `).bind(agentId, now, ...chunk).all<{ object_key: string }>();
    for (const row of result.results) active.add(row.object_key);
  }
  return active;
}

export async function cleanupDeletedAttachmentObject(
  db: D1Database,
  agentId: string,
  objectKey: string,
  now: string,
): Promise<void> {
  await db.batch([
    db.prepare(
      "DELETE FROM attachments WHERE object_key = ? AND agent_id = ?",
    ).bind(objectKey, agentId),
    db.prepare(`
      DELETE FROM attachment_upload_leases
      WHERE object_key = ? AND agent_id = ? AND expires_at <= ?
    `).bind(objectKey, agentId, now),
  ]);
}

export async function deleteAttachmentMetadata(
  db: D1Database,
  id: string,
  agentId: string,
): Promise<boolean> {
  const result = await db.prepare(
    "DELETE FROM attachments WHERE id = ? AND agent_id = ?",
  ).bind(id, agentId).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function deleteAttachmentMetadataByObjectKey(
  db: D1Database,
  objectKey: string,
  agentId: string,
): Promise<boolean> {
  const result = await db.prepare(
    "DELETE FROM attachments WHERE object_key = ? AND agent_id = ?",
  ).bind(objectKey, agentId).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function countAgentAttachments(db: D1Database, agentId: string): Promise<number> {
  const row = await db.prepare(
    "SELECT COUNT(*) AS count FROM attachments WHERE agent_id = ?",
  ).bind(agentId).first<{ count: number }>();
  return row?.count ?? 0;
}

export async function countAgentAttachmentUploadLeases(
  db: D1Database,
  agentId: string,
): Promise<number> {
  const row = await db.prepare(
    "SELECT COUNT(*) AS count FROM attachment_upload_leases WHERE agent_id = ?",
  ).bind(agentId).first<{ count: number }>();
  return row?.count ?? 0;
}

export interface AttachmentOwnerTarget {
  id: string;
  status: string;
  scope: string;
}

export async function findAttachmentOwnerTarget(
  db: D1Database,
  agentId: string,
): Promise<AttachmentOwnerTarget | null> {
  return db.prepare("SELECT id, status, scope FROM agents WHERE id = ?")
    .bind(agentId)
    .first<AttachmentOwnerTarget>();
}
