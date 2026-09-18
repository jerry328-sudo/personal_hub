import type { AgentDto, AgentScope, AgentStatus, RunResult, UpdateAgentInput } from "../../../shared/contracts";

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
}

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

function toAgentDto(row: AgentRow): AgentDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    scope: row.scope,
    status: row.status,
    deleting_at: row.deleting_at,
    display_mode: row.display_mode,
    main_entry_id: row.main_entry_id,
    created_at: row.created_at,
    last_report_at: row.last_report_at,
    last_result: row.last_result,
    last_note: row.last_note,
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
    SELECT id, name, description, scope, status, deleting_at, display_mode,
           main_entry_id, created_at, last_report_at, last_result, last_note
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
    SELECT id, name, description, scope, status, deleting_at, display_mode,
           main_entry_id, created_at, last_report_at, last_result, last_note
    FROM agents
    WHERE id = ?
  `).bind(id).first<AgentRow>();
  return row === null ? null : toAgentDto(row);
}

export async function createAgentAndKeyBatch(
  db: D1Database,
  agent: AgentDto,
  keyInsert: D1PreparedStatement,
): Promise<void> {
  const agentInsert = db.prepare(`
    INSERT INTO agents (
      id, name, description, scope, status, deleting_at, display_mode,
      main_entry_id, created_at, last_report_at, last_result, last_note
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    agent.id,
    agent.name,
    agent.description,
    agent.scope,
    agent.status,
    agent.deleting_at,
    agent.display_mode,
    agent.main_entry_id,
    agent.created_at,
    agent.last_report_at,
    agent.last_result,
    agent.last_note,
  );

  await db.batch([agentInsert, keyInsert]);
}

export async function agentOwnsEntry(db: D1Database, agentId: string, entryId: string): Promise<boolean> {
  const row = await db.prepare(`
    SELECT 1 AS found
    FROM entries
    WHERE id = ? AND agent_id = ?
  `).bind(entryId, agentId).first<{ found: number }>();
  return row !== null;
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
