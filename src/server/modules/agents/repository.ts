import type {
  AgentAccessMode,
  AgentDto,
  AgentReadMode,
  AgentRole,
  AgentScope,
  AgentStatus,
  RunResult,
  UpdateAgentInput,
} from "../../../shared/contracts";

interface AgentRow {
  id: string;
  name: string;
  description: string;
  scope: AgentScope;
  status: AgentStatus;
  deleting_at: string | null;
  display_mode: AgentDto["display_mode"];
  main_entry_id: string | null;
  created_at: string;
  last_report_at: string | null;
  last_result: RunResult | null;
  last_note: string | null;
  access_mode: AgentAccessMode;
  read_mode: AgentReadMode | null;
  permissions_revision: number;
  read_source_count: number;
}

const AGENT_COLUMNS = `id, name, description, scope, status, deleting_at, display_mode,
           main_entry_id, created_at, last_report_at, last_result, last_note,
           access_mode, read_mode, permissions_revision,
           (SELECT COUNT(*) FROM agent_read_grants AS grant_count
            WHERE grant_count.reader_agent_id = agents.id) AS read_source_count`;

export interface AgentListOptions {
  statuses: readonly AgentStatus[];
  scope?: AgentScope;
  afterId?: string;
  limit: number;
}

export interface AgentListResult {
  items: AgentDto[];
  nextId: string | null;
}

/**
 * 仅供展示的角色映射。授权判定一律走 auth/service.ts 的 decodeAgentRole，
 * 那里对非法组合拒绝认证，这里不能因为一行数据异常就抛错。
 */
function roleForRow(row: AgentRow): AgentRole {
  if (row.access_mode === "read_only") return "reader";
  return row.scope === "all" ? "manager" : "agent";
}

function toAgentDto(row: AgentRow): AgentDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    role: roleForRow(row),
    status: row.status,
    deleting_at: row.deleting_at,
    display_mode: row.display_mode,
    main_entry_id: row.main_entry_id,
    created_at: row.created_at,
    last_report_at: row.last_report_at,
    last_result: row.last_result,
    last_note: row.last_note,
    read_mode: row.access_mode === "read_only" ? row.read_mode : null,
    read_source_count: row.access_mode === "read_only" ? row.read_source_count : null,
  };
}

export async function listAgents(db: D1Database, options: AgentListOptions): Promise<AgentListResult> {
  if (options.statuses.length === 0) return { items: [], nextId: null };

  const clauses = [`status IN (${options.statuses.map(() => "?").join(", ")})`];
  const values: unknown[] = [...options.statuses];

  if (options.scope !== undefined) {
    clauses.push("scope = ?");
    values.push(options.scope);
  }
  if (options.afterId !== undefined) {
    clauses.push("id > ?");
    values.push(options.afterId);
  }

  const fetchLimit = options.limit + 1;
  values.push(fetchLimit);
  const result = await db.prepare(`
    SELECT ${AGENT_COLUMNS}
    FROM agents
    WHERE ${clauses.join(" AND ")}
    ORDER BY id ASC
    LIMIT ?
  `).bind(...values).all<AgentRow>();

  const rows = result.results;
  const hasMore = rows.length > options.limit;
  const pageRows = hasMore ? rows.slice(0, options.limit) : rows;
  return {
    items: pageRows.map(toAgentDto),
    nextId: hasMore ? pageRows.at(-1)?.id ?? null : null,
  };
}

export async function findAgent(db: D1Database, id: string): Promise<AgentDto | null> {
  const row = await db.prepare(`
    SELECT ${AGENT_COLUMNS}
    FROM agents
    WHERE id = ?
  `).bind(id).first<AgentRow>();
  return row === null ? null : toAgentDto(row);
}

/** 新建身份的入库描述。role 是唯一权威输入，scope/access_mode 由此推导。 */
export type AgentInsertRecord = {
  id: string;
  name: string;
  description: string;
  role: AgentRole;
  readMode?: AgentReadMode | null;
  displayMode: AgentDto["display_mode"];
  createdAt: string;
};

export async function createAgentAndKeyBatch(
  db: D1Database,
  agent: AgentInsertRecord,
  keyInsert: D1PreparedStatement,
  grantInsert: D1PreparedStatement | null,
  targetValidity: { targetIdsJson: string } | null,
): Promise<D1Result[]> {
  const scope: AgentScope = agent.role === "agent" ? "own" : "all";
  const accessMode: AgentAccessMode = agent.role === "reader" ? "read_only" : "read_write";
  const readMode = agent.role === "reader" ? agent.readMode ?? null : null;
  const values = [
    agent.id,
    agent.name,
    agent.description,
    scope,
    "active",
    null,
    agent.displayMode,
    null,
    agent.createdAt,
    null,
    null,
    null,
    accessMode,
    readMode,
    0,
  ];
  const columns = `id, name, description, scope, status, deleting_at, display_mode,
          main_entry_id, created_at, last_report_at, last_result, last_note,
          access_mode, read_mode, permissions_revision`;
  // 只读身份的目标校验必须与身份插入处在同一事务里：不合法时整条语句影响 0 行，
  // 后续授权与密钥也随之为 0 行，因此不存在“提交了身份但缺少授权”的中间态。
  const agentInsert = targetValidity === null
    ? db.prepare(`INSERT INTO agents (${columns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(...values)
    : db.prepare(`INSERT INTO agents (${columns})
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE ${buildTargetValiditySql()}`)
        .bind(...values, targetValidity.targetIdsJson);

  const statements = grantInsert === null
    ? [agentInsert, keyInsert]
    : [agentInsert, grantInsert, keyInsert];
  return db.batch(statements);
}

export async function agentOwnsEntry(db: D1Database, agentId: string, entryId: string): Promise<boolean> {
  const row = await db.prepare(`
    SELECT 1 AS found
    FROM entries
    WHERE id = ? AND agent_id = ?
  `).bind(entryId, agentId).first<{ found: number }>();
  return row !== null;
}

// ---------------------------------------------------------------------------
// 只读授权
// ---------------------------------------------------------------------------

/**
 * 目标合法性：targets_json 里每个值都必须是在存、可写的普通内容分区，
 * 且没有进入永久删除。JSON 空数组表示 all 模式，天然通过。
 */
function buildTargetValiditySql(): string {
  return `NOT EXISTS (
    SELECT 1 FROM json_each(?) AS new_target
    WHERE NOT EXISTS (
      SELECT 1 FROM agents AS new_source
      WHERE new_source.id = new_target.value
        AND new_source.scope = 'own'
        AND new_source.access_mode = 'read_write'
        AND new_source.read_mode IS NULL
        AND new_source.status <> 'deleting'
    )
  )`;
}

/**
 * 授权替换事务共用的谓词。三条变更语句都展开同一段 SQL 并绑定相同参数，
 * 这样谓词为假时三条语句一致地不生效，不会出现“版本没变但授权被改掉”。
 * 绑定顺序：只读身份 ID、base_revision、目标 ID JSON。
 */
export function buildReaderAccessGuard(
  readerId: string,
  baseRevision: number,
  targetIdsJson: string,
): { sql: string; bindings: unknown[] } {
  return {
    sql: `EXISTS (
      SELECT 1 FROM agents AS guard_reader
      WHERE guard_reader.id = ?
        AND guard_reader.scope = 'all'
        AND guard_reader.access_mode = 'read_only'
        AND guard_reader.read_mode IN ('selected', 'all')
        AND guard_reader.status IN ('active', 'disabled')
        AND guard_reader.permissions_revision = ?
    )
    AND ${buildTargetValiditySql()}`,
    bindings: [readerId, baseRevision, targetIdsJson],
  };
}

/** 创建只读身份时的授权插入。依赖同一事务中刚插入的身份行。 */
export function prepareReaderGrants(
  db: D1Database,
  readerId: string,
  targetIdsJson: string,
  createdAt: string,
): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO agent_read_grants (reader_agent_id, target_agent_id, created_at)
    SELECT ?, new_target.value, ?
    FROM json_each(?) AS new_target
    WHERE EXISTS (
      SELECT 1 FROM agents AS new_reader
      WHERE new_reader.id = ?
        AND new_reader.scope = 'all'
        AND new_reader.access_mode = 'read_only'
    )
  `).bind(readerId, createdAt, targetIdsJson, readerId);
}

export type ReadAccessRow = {
  id: string;
  scope: AgentScope;
  access_mode: AgentAccessMode;
  read_mode: AgentReadMode | null;
  status: AgentStatus;
  permissions_revision: number;
};

export type ReadAccessSourceRow = {
  id: string;
  name: string;
  status: AgentStatus;
};

export async function findReaderAccessRow(
  db: D1Database,
  readerId: string,
): Promise<ReadAccessRow | null> {
  return db.prepare(`
    SELECT id, scope, access_mode, read_mode, status, permissions_revision
    FROM agents
    WHERE id = ?
  `).bind(readerId).first<ReadAccessRow>();
}

export async function listReadAccessSources(
  db: D1Database,
  readerId: string,
): Promise<ReadAccessSourceRow[]> {
  const result = await db.prepare(`
    SELECT grant_record.target_agent_id AS id, source.name AS name, source.status AS status
    FROM agent_read_grants AS grant_record
    INNER JOIN agents AS source ON source.id = grant_record.target_agent_id
    WHERE grant_record.reader_agent_id = ?
    ORDER BY grant_record.target_agent_id ASC
  `).bind(readerId).all<ReadAccessSourceRow>();
  return result.results;
}

export type ReplaceReaderAccessInput = {
  readerId: string;
  baseRevision: number;
  readMode: AgentReadMode;
  targetIds: readonly string[];
  createdAt: string;
};

export type ReplaceReaderAccessOutcome =
  | { status: "updated"; readMode: AgentReadMode; revision: number; sources: ReadAccessSourceRow[] }
  | { status: "not_found" }
  | { status: "not_reader" }
  | { status: "invalid_target" }
  | { status: "revision_conflict" };

type ReplaceDiagnosticsRow = ReadAccessRow & { invalid_targets: number };

/**
 * 完整替换授权。事务顺序固定为“所有变更检查旧版本，最后递增版本”，
 * 因为 D1 batch 里 UPDATE 影响 0 行既不会报错也不会中止后续语句，
 * 不能把 base_revision 当成自动的 CAS 保护。
 */
export async function replaceReaderAccessBatch(
  db: D1Database,
  input: ReplaceReaderAccessInput,
): Promise<ReplaceReaderAccessOutcome> {
  const targetIdsJson = JSON.stringify(input.targetIds);
  const guard = buildReaderAccessGuard(input.readerId, input.baseRevision, targetIdsJson);

  const results = await db.batch([
    db.prepare(`
      SELECT id, scope, access_mode, read_mode, status, permissions_revision,
        (SELECT COUNT(*) FROM json_each(?) AS diag_target
         WHERE NOT EXISTS (
           SELECT 1 FROM agents AS diag_source
           WHERE diag_source.id = diag_target.value
             AND diag_source.scope = 'own'
             AND diag_source.access_mode = 'read_write'
             AND diag_source.read_mode IS NULL
             AND diag_source.status <> 'deleting'
         )) AS invalid_targets
      FROM agents
      WHERE id = ?
    `).bind(targetIdsJson, input.readerId),
    db.prepare(`
      DELETE FROM agent_read_grants
      WHERE reader_agent_id = ? AND (${guard.sql})
    `).bind(input.readerId, ...guard.bindings),
    db.prepare(`
      INSERT INTO agent_read_grants (reader_agent_id, target_agent_id, created_at)
      SELECT ?, diag_target.value, ?
      FROM json_each(?) AS diag_target
      WHERE (${guard.sql})
    `).bind(input.readerId, input.createdAt, targetIdsJson, ...guard.bindings),
    db.prepare(`
      UPDATE agents
      SET read_mode = ?, permissions_revision = permissions_revision + 1
      WHERE id = ? AND (${guard.sql})
    `).bind(input.readMode, input.readerId, ...guard.bindings),
    db.prepare(`SELECT id, read_mode, permissions_revision FROM agents WHERE id = ?`)
      .bind(input.readerId),
    db.prepare(`
      SELECT grant_record.target_agent_id AS id, source.name AS name, source.status AS status
      FROM agent_read_grants AS grant_record
      INNER JOIN agents AS source ON source.id = grant_record.target_agent_id
      WHERE grant_record.reader_agent_id = ?
      ORDER BY grant_record.target_agent_id ASC
    `).bind(input.readerId),
  ]);

  if ((results[3]?.meta.changes ?? 0) !== 1) {
    const diagnostics = results[0]?.results?.[0] as ReplaceDiagnosticsRow | undefined;
    if (!diagnostics) return { status: "not_found" };
    const readableModes = diagnostics.read_mode === "selected" || diagnostics.read_mode === "all";
    const mutableStatus = diagnostics.status === "active" || diagnostics.status === "disabled";
    if (
      diagnostics.scope !== "all"
      || diagnostics.access_mode !== "read_only"
      || !readableModes
      || !mutableStatus
    ) {
      return { status: "not_reader" };
    }
    if (diagnostics.permissions_revision !== input.baseRevision) return { status: "revision_conflict" };
    if ((diagnostics.invalid_targets ?? 0) > 0) return { status: "invalid_target" };
    return { status: "revision_conflict" };
  }

  const finalRow = results[4]?.results?.[0] as { read_mode: AgentReadMode; permissions_revision: number } | undefined;
  return {
    status: "updated",
    readMode: finalRow?.read_mode ?? input.readMode,
    revision: finalRow?.permissions_revision ?? input.baseRevision + 1,
    sources: (results[5]?.results ?? []) as ReadAccessSourceRow[],
  };
}

export async function updateAgentConfig(
  db: D1Database,
  agentId: string,
  input: UpdateAgentInput,
): Promise<boolean> {
  const assignments: string[] = [];
  const values: unknown[] = [];

  if (input.name !== undefined) {
    assignments.push("name = ?");
    values.push(input.name);
  }
  if (input.description !== undefined) {
    assignments.push("description = ?");
    values.push(input.description);
  }
  if (input.display_mode !== undefined) {
    assignments.push("display_mode = ?");
    values.push(input.display_mode);
  }
  if (input.main_entry_id !== undefined) {
    assignments.push("main_entry_id = ?");
    values.push(input.main_entry_id);
  }
  if (assignments.length === 0) return false;

  values.push(agentId);
  const ownershipClause = input.main_entry_id === undefined || input.main_entry_id === null
    ? ""
    : "AND EXISTS (SELECT 1 FROM entries WHERE id = ? AND agent_id = agents.id)";
  if (input.main_entry_id !== undefined && input.main_entry_id !== null) values.push(input.main_entry_id);

  const result = await db.prepare(`
    UPDATE agents
    SET ${assignments.join(", ")}
    WHERE id = ?
      AND status <> 'deleting'
      ${ownershipClause}
  `).bind(...values).run();
  return (result.meta.changes ?? 0) === 1;
}

export async function setAgentStatus(
  db: D1Database,
  agentId: string,
  from: AgentStatus,
  to: AgentStatus,
): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE agents
    SET status = ?, deleting_at = NULL
    WHERE id = ? AND status = ? AND id <> 'manual'
  `).bind(to, agentId, from).run();
  return (result.meta.changes ?? 0) === 1;
}

export async function removeAndRevokeBatch(db: D1Database, agentId: string, now: string): Promise<boolean> {
  const results = await db.batch([
    db.prepare(`
      UPDATE agents
      SET status = 'removed', deleting_at = NULL
      WHERE id = ? AND status IN ('active', 'disabled') AND id <> 'manual'
    `).bind(agentId),
    db.prepare(`
      UPDATE agent_keys
      SET revoked_at = COALESCE(revoked_at, ?)
      WHERE agent_id = ?
        AND EXISTS (SELECT 1 FROM agents WHERE id = ? AND status = 'removed')
    `).bind(now, agentId, agentId),
  ]);
  return (results[0]?.meta.changes ?? 0) === 1;
}

export async function beginAgentDeletionBatch(db: D1Database, agentId: string, now: string): Promise<boolean> {
  const results = await db.batch([
    db.prepare(`
      UPDATE agents
      SET status = 'deleting', deleting_at = ?
      WHERE id = ? AND status <> 'deleting' AND id <> 'manual'
    `).bind(now, agentId),
    db.prepare(`
      UPDATE agent_keys
      SET revoked_at = COALESCE(revoked_at, ?)
      WHERE agent_id = ?
        AND EXISTS (SELECT 1 FROM agents WHERE id = ? AND status = 'deleting')
    `).bind(now, agentId, agentId),
  ]);
  return (results[0]?.meta.changes ?? 0) === 1;
}

export async function updateLastReport(
  db: D1Database,
  agentId: string,
  result: RunResult,
  note: string | null,
  now: string,
): Promise<boolean> {
  const update = await db.prepare(`
    UPDATE agents
    SET last_report_at = ?, last_result = ?, last_note = ?
    WHERE id = ? AND status = 'active' AND id <> 'manual'
  `).bind(now, result, note, agentId).run();
  return (update.meta.changes ?? 0) === 1;
}

export async function countAgentAttachments(db: D1Database, agentId: string): Promise<number> {
  const row = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM attachments
    WHERE agent_id = ?
  `).bind(agentId).first<{ count: number }>();
  return row?.count ?? 0;
}

export async function finalizeAgentDeletionBatch(db: D1Database, agentId: string): Promise<boolean> {
  const guard = `EXISTS (
    SELECT 1 FROM agents target
    WHERE target.id = ? AND target.status = 'deleting' AND target.id <> 'manual'
      AND NOT EXISTS (SELECT 1 FROM attachments WHERE agent_id = target.id)
      AND NOT EXISTS (SELECT 1 FROM attachment_upload_leases WHERE agent_id = target.id)
  )`;

  const results = await db.batch([
    db.prepare(`
      UPDATE tasks
      SET entry_id = NULL, agent_id = 'manual'
      WHERE agent_id = ? AND ${guard}
    `).bind(agentId, agentId),
    db.prepare(`
      UPDATE agents
      SET main_entry_id = NULL
      WHERE main_entry_id IN (SELECT id FROM entries WHERE agent_id = ?)
        AND ${guard}
    `).bind(agentId, agentId),
    db.prepare(`
      DELETE FROM entries
      WHERE agent_id = ? AND ${guard}
    `).bind(agentId, agentId),
    db.prepare(`
      DELETE FROM agent_keys
      WHERE agent_id = ? AND ${guard}
    `).bind(agentId, agentId),
    db.prepare(`
      DELETE FROM agents
      WHERE id = ? AND status = 'deleting' AND id <> 'manual'
        AND NOT EXISTS (SELECT 1 FROM attachments WHERE agent_id = ?)
        AND NOT EXISTS (SELECT 1 FROM attachment_upload_leases WHERE agent_id = ?)
        AND NOT EXISTS (SELECT 1 FROM entries WHERE agent_id = ?)
        AND NOT EXISTS (SELECT 1 FROM tasks WHERE agent_id = ?)
    `).bind(agentId, agentId, agentId, agentId, agentId),
  ]);

  return (results[4]?.meta.changes ?? 0) === 1;
}
