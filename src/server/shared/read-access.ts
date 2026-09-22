import type { ReaderScope } from "./authorize";

/**
 * 只接受代码内定义的 owner 列，不接受调用方传入的 SQL 标识符。
 * 这样共享谓词永远无法被用户输入影响。
 */
export type OwnerColumn =
  | "e.agent_id"
  | "tasks.agent_id"
  | "a.agent_id"
  | "a.id";

const READER_IDENTITY_SQL = `EXISTS (
    SELECT 1 FROM agents AS reader_identity
    WHERE reader_identity.id = ?
      AND reader_identity.scope = 'all'
      AND reader_identity.access_mode = 'read_only'
      AND reader_identity.status = 'active'
      AND reader_identity.permissions_revision = ?
  )`;

function readerSourceSql(ownerColumn: OwnerColumn): string {
  return `EXISTS (
    SELECT 1 FROM agents AS reader_source
    WHERE reader_source.id = ${ownerColumn}
      AND reader_source.scope = 'own'
      AND reader_source.access_mode = 'read_write'
      AND reader_source.read_mode IS NULL
      AND reader_source.status <> 'deleting'
  )`;
}

function readerGrantSql(ownerColumn: OwnerColumn): string {
  return `(
    ? = 'all'
    OR EXISTS (
      SELECT 1 FROM agent_read_grants AS reader_grant
      WHERE reader_grant.reader_agent_id = ?
        AND reader_grant.target_agent_id = ${ownerColumn}
    )
  )`;
}

/**
 * 把只读授权条件下推到 SQL，在分页之前过滤。
 * 绑定顺序依次为：只读身份 ID、请求时的权限版本、读取模式、只读身份 ID。
 */
export function appendReadAccessPredicate(
  ownerColumn: OwnerColumn,
  reader: ReaderScope,
  where: string[],
  bindings: unknown[],
): void {
  where.push(READER_IDENTITY_SQL, readerSourceSql(ownerColumn), readerGrantSql(ownerColumn));
  bindings.push(reader.readerAgentId, reader.permissionsRevision, reader.readMode, reader.readerAgentId);
}

/** 单个 owner 是否在当前授权范围内。用于“显式指定来源”时的 404 语义。 */
export function appendSingleOwnerPredicate(
  ownerColumn: OwnerColumn,
  reader: ReaderScope,
  ownerId: string,
  where: string[],
  bindings: unknown[],
): void {
  where.push(`${ownerColumn} = ?`);
  bindings.push(ownerId);
  appendReadAccessPredicate(ownerColumn, reader, where, bindings);
}
