import type { AgentKeyMetadataDto } from "../../../shared/contracts";
import type { AgentScope, AgentStatus } from "../../env";
import { conflict } from "../../shared/errors";

const MAX_LIVE_KEYS_PER_AGENT = 2;

export type AgentKeyInsert = {
  id: string;
  agentId: string;
  secretHash: string;
  createdAt: string;
  expiresAt: string | null;
};

export type AgentKeyWithAgent = AgentKeyInsert & {
  revokedAt: string | null;
  lastUsedAt: string | null;
  scope: AgentScope;
  status: AgentStatus;
};

export type AgentKeyTarget = {
  id: string;
  scope: AgentScope;
  status: AgentStatus;
};

export type AdminSessionInsert = {
  id: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  credentialRevision?: number;
};

export type AdminSessionRecord = AdminSessionInsert & {
  revokedAt: string | null;
};

type AgentKeyWithAgentRow = {
  id: string;
  agent_id: string;
  secret_hash: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  agent_scope: AgentScope;
  agent_status: AgentStatus;
};

type AgentKeyMetadataRow = {
  id: string;
  agent_id: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
};

type AdminSessionRow = {
  id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
};

type IdRow = {
  id: string;
};

function mapKeyWithAgent(row: AgentKeyWithAgentRow): AgentKeyWithAgent {
  return {
    id: row.id,
    agentId: row.agent_id,
    secretHash: row.secret_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    scope: row.agent_scope,
    status: row.agent_status,
  };
}

function mapKeyMetadata(row: AgentKeyMetadataRow): AgentKeyMetadataDto {
  return {
    id: row.id,
    agent_id: row.agent_id,
    created_at: row.created_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    last_used_at: row.last_used_at,
  };
}

function mapSession(row: AdminSessionRow): AdminSessionRecord {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

export async function findAgentKeyTarget(
  db: D1Database,
  agentId: string,
): Promise<AgentKeyTarget | null> {
  return db
    .prepare(
      `SELECT id, scope, status
       FROM agents
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(agentId)
    .first<AgentKeyTarget>();
}

export async function findKeyWithAgent(
  db: D1Database,
  keyId: string,
): Promise<AgentKeyWithAgent | null> {
  const row = await db
    .prepare(
      `SELECT
         key_record.id,
         key_record.agent_id,
         key_record.secret_hash,
         key_record.created_at,
         key_record.expires_at,
         key_record.revoked_at,
         key_record.last_used_at,
         agent.scope AS agent_scope,
         agent.status AS agent_status
       FROM agent_keys AS key_record
       INNER JOIN agents AS agent ON agent.id = key_record.agent_id
       WHERE key_record.id = ?
       LIMIT 1`,
    )
    .bind(keyId)
    .first<AgentKeyWithAgentRow>();

  return row === null ? null : mapKeyWithAgent(row);
}

/**
 * Builds the first-key insert for the outer "create Agent + key" D1 batch.
 * Constraint failures make the batch fail and roll back instead of committing
 * an Agent without its first credential.
 */
export function prepareInsertKey(db: D1Database, record: AgentKeyInsert): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO agent_keys (
         id,
         agent_id,
         secret_hash,
         created_at,
         expires_at,
         revoked_at,
         last_used_at
       )
       VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
    )
    .bind(
      record.id,
      record.agentId,
      record.secretHash,
      record.createdAt,
      record.expiresAt,
    );
}

export async function insertKey(db: D1Database, record: AgentKeyInsert): Promise<void> {
  const result = await db
    .prepare(
      `INSERT INTO agent_keys (
         id,
         agent_id,
         secret_hash,
         created_at,
         expires_at,
         revoked_at,
         last_used_at
       )
       SELECT ?, ?, ?, ?, ?, NULL, NULL
       WHERE EXISTS (
         SELECT 1
         FROM agents
         WHERE id = ?
           AND id <> 'manual'
           AND status IN ('active', 'disabled')
       )
       AND (
         SELECT COUNT(*)
         FROM agent_keys
         WHERE agent_id = ?
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)
       ) < ?`,
    )
    .bind(
      record.id,
      record.agentId,
      record.secretHash,
      record.createdAt,
      record.expiresAt,
      record.agentId,
      record.agentId,
      record.createdAt,
      MAX_LIVE_KEYS_PER_AGENT,
    )
    .run();

  if ((result.meta.changes ?? 0) !== 1) {
    throw conflict("无法签发密钥：Agent 当前状态不允许，或已有两把有效密钥");
  }
}

export async function listKeyMetadata(
  db: D1Database,
  agentId: string,
): Promise<AgentKeyMetadataDto[]> {
  const result = await db
    .prepare(
      `SELECT id, agent_id, created_at, expires_at, revoked_at, last_used_at
       FROM agent_keys
       WHERE agent_id = ?
       ORDER BY created_at DESC, id DESC`,
    )
    .bind(agentId)
    .all<AgentKeyMetadataRow>();

  return result.results.map(mapKeyMetadata);
}

export async function revokeKey(
  db: D1Database,
  agentId: string,
  keyId: string,
  revokedAt: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `UPDATE agent_keys
       SET revoked_at = COALESCE(revoked_at, ?)
       WHERE id = ? AND agent_id = ?
       RETURNING id`,
    )
    .bind(revokedAt, keyId, agentId)
    .first<IdRow>();

  return row !== null;
}

export async function revokeAgentKeys(
  db: D1Database,
  agentId: string,
  revokedAt: string,
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE agent_keys
       SET revoked_at = ?
       WHERE agent_id = ? AND revoked_at IS NULL`,
    )
    .bind(revokedAt, agentId)
    .run();

  return result.meta.changes ?? 0;
}

export async function touchKeyUsage(
  db: D1Database,
  keyId: string,
  usedAt: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `UPDATE agent_keys
       SET last_used_at = CASE
         WHEN last_used_at IS NULL OR last_used_at < ? THEN ?
         ELSE last_used_at
       END
       WHERE id = ?
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)
       RETURNING id`,
    )
    .bind(usedAt, usedAt, keyId, usedAt)
    .first<IdRow>();

  return row !== null;
}

export async function insertSession(db: D1Database, record: AdminSessionInsert): Promise<void> {
  const inserted = await db
    .prepare(
      `INSERT INTO admin_sessions (id, token_hash, created_at, expires_at, credential_revision)
       SELECT ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM admin_credentials WHERE id = 1 AND revision = ?)
       RETURNING id`,
    )
    .bind(record.id, record.tokenHash, record.createdAt, record.expiresAt,
      record.credentialRevision ?? 0, record.credentialRevision ?? 0)
    .first<IdRow>();
  if (!inserted) throw conflict("登录密钥已变更，请使用新密钥重新登录");
}

export async function findSession(
  db: D1Database,
  sessionId: string,
): Promise<AdminSessionRecord | null> {
  const row = await db
    .prepare(
      `SELECT id, token_hash, created_at, expires_at, revoked_at
       FROM admin_sessions
       WHERE id = ? AND credential_revision = (SELECT revision FROM admin_credentials WHERE id = 1)
       LIMIT 1`,
    )
    .bind(sessionId)
    .first<AdminSessionRow>();

  return row === null ? null : mapSession(row);
}

export async function revokeSession(
  db: D1Database,
  sessionId: string,
  revokedAt: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `UPDATE admin_sessions
       SET revoked_at = COALESCE(revoked_at, ?)
       WHERE id = ?
       RETURNING id`,
    )
    .bind(revokedAt, sessionId)
    .first<IdRow>();

  return row !== null;
}

export async function deleteExpiredSessions(db: D1Database, expiredAt: string): Promise<number> {
  const result = await db
    .prepare("DELETE FROM admin_sessions WHERE expires_at <= ?")
    .bind(expiredAt)
    .run();

  return result.meta.changes ?? 0;
}

export interface AdminCredentialRecord {
  secret_hash: string | null;
  revision: number;
}

export async function findAdminCredential(db: D1Database): Promise<AdminCredentialRecord> {
  const row = await db.prepare("SELECT secret_hash, revision FROM admin_credentials WHERE id = 1")
    .first<AdminCredentialRecord>();
  if (!row) throw new Error("管理员凭据配置缺失，请检查数据库迁移");
  return row;
}

export async function rotateAdminCredential(
  db: D1Database, sessionId: string, revision: number, digest: string, now: string,
): Promise<boolean> {
  const results = await db.batch<{ revision: number }>([
    db.prepare(`UPDATE admin_credentials SET secret_hash = ?, revision = revision + 1, updated_at = ?
      WHERE id = 1 AND revision = ? AND EXISTS (
        SELECT 1 FROM admin_sessions WHERE id = ? AND revoked_at IS NULL
        AND expires_at > ? AND credential_revision = ?
      ) RETURNING revision`).bind(digest, now, revision, sessionId, now, revision),
    db.prepare(`UPDATE admin_sessions SET revoked_at = COALESCE(revoked_at, ?)
      WHERE credential_revision < (SELECT revision FROM admin_credentials WHERE id = 1)`).bind(now),
  ]);
  return results[0]?.results.length === 1;
}
