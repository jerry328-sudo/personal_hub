import type {
  AppendVersionInput,
  CreateEntryInput,
  EntryBriefDto,
  EntryFullDto,
  EntryStateDto,
  EntryVersionBriefDto,
  EntryVersionDto,
} from "../../../shared/contracts";
import type { ReadScope } from "../../shared/authorize";
import { boolFromDb } from "../../shared/db";
import { appendReadAccessPredicate } from "../../shared/read-access";
import { visibleTaskClause } from "../tasks/repository";

export type EntryListOrder = "id_asc" | "updated_desc" | "created_asc";
export type EntryListView = "brief" | "full";
export type TernaryFilter = "all" | "yes" | "no";

export interface CurrentEntryQuery {
  view: EntryListView;
  completion: "all" | "open" | "done";
  archived: TernaryFilter;
  important: TernaryFilter;
  order: EntryListOrder;
  query?: string;
  read?: "all" | "unread" | "updated" | "read";
  start?: string;
  end?: string;
  time_field?: "updated" | "created" | "archived" | "completed";
  cursor: string[] | null;
  limit: number;
}

export interface CurrentEntryPageRows {
  items: Array<EntryBriefDto | EntryFullDto>;
  hasMore: boolean;
}

export interface EntryWriteInfo {
  id: string;
  agentId: string;
  agentScope: "own" | "all";
  agentStatus: "active" | "disabled" | "removed" | "deleting";
  currentVersion: number;
}

export interface OwnerWriteInfo {
  id: string;
  scope: "own" | "all";
  status: "active" | "disabled" | "removed" | "deleting";
}

type CurrentEntryRow = {
  id: string;
  agent_id: string;
  entry_created_at: string;
  archived: number;
  archived_at: string | null;
  read_version: number;
  completed: number;
  completed_at: string | null;
  version: number;
  title: string;
  content: string;
  url: string | null;
  important: number;
  updated_at: string;
  created_by_agent_id: string;
};

type VersionRow = {
  entry_id: string;
  version: number;
  created_by_agent_id: string;
  title: string;
  content: string;
  url: string | null;
  important: number;
  created_at: string;
  archived: number;
  archived_at: string | null;
  read_version: number;
  completed: number;
  completed_at: string | null;
};

type VersionBriefRow = Omit<VersionRow, "content" | "url" | "archived" | "archived_at" | "read_version" | "completed" | "completed_at">;

type EntryWriteRow = {
  id: string;
  agent_id: string;
  agent_scope: "own" | "all";
  agent_status: "active" | "disabled" | "removed" | "deleting";
  current_version: number;
};

type OwnerWriteRow = {
  id: string;
  scope: "own" | "all";
  status: "active" | "disabled" | "removed" | "deleting";
};

type StateRow = {
  archived: number;
  archived_at: string | null;
  read_version: number;
  completed: number;
  completed_at: string | null;
};

function addScopeWhere(scope: ReadScope, where: string[], bindings: unknown[]): void {
  if (scope.kind === "reader") {
    // 只读身份：显式来源过滤，外加实时授权条件（身份仍启用、权限版本一致、
    // owner 是可读写的普通分区，且属于 all 模式或存在授权关系）。
    if (scope.agentId) {
      where.push("e.agent_id = ?");
      bindings.push(scope.agentId);
    }
    appendReadAccessPredicate("e.agent_id", scope.reader, where, bindings);
    return;
  }
  const agentId = scope.agentId;
  if (agentId) {
    where.push("e.agent_id = ?");
    bindings.push(agentId);
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function mapState(row: StateRow): EntryStateDto {
  return {
    archived: boolFromDb(row.archived),
    archived_at: row.archived_at,
    read_version: row.read_version,
    completed: boolFromDb(row.completed),
    completed_at: row.completed_at,
  };
}

function mapCurrentRow(row: CurrentEntryRow, view: EntryListView): EntryBriefDto | EntryFullDto {
  const brief: EntryBriefDto = {
    id: row.id,
    agent_id: row.agent_id,
    created_at: row.entry_created_at,
    version: row.version,
    title: row.title,
    important: boolFromDb(row.important),
    updated_at: row.updated_at,
    created_by_agent_id: row.created_by_agent_id,
    ...mapState(row),
  };
  if (view === "brief") return brief;
  return { ...brief, content: row.content, url: row.url };
}

function mapVersionRow(row: VersionRow): EntryVersionDto {
  return {
    entry_id: row.entry_id,
    version: row.version,
    created_by_agent_id: row.created_by_agent_id,
    title: row.title,
    content: row.content,
    url: row.url,
    important: boolFromDb(row.important),
    created_at: row.created_at,
    state: mapState(row),
  };
}

function entryFilters(
  scope: ReadScope,
  query: CurrentEntryQuery,
): { where: string[]; bindings: unknown[] } {
  const where: string[] = [];
  const bindings: unknown[] = [];
  addScopeWhere(scope, where, bindings);

  if (query.completion !== "all") {
    where.push("e.completed = ?");
    bindings.push(query.completion === "done" ? 1 : 0);
  }
  if (query.archived !== "all") {
    where.push("e.archived = ?");
    bindings.push(query.archived === "yes" ? 1 : 0);
  }
  if (query.important !== "all") {
    where.push("v.important = ?");
    bindings.push(query.important === "yes" ? 1 : 0);
  }
  if (query.query) {
    const pattern = `%${escapeLike(query.query)}%`;
    where.push("(v.title LIKE ? ESCAPE '\\' OR v.content LIKE ? ESCAPE '\\')");
    bindings.push(pattern, pattern);
  }

  if (query.read === "unread") where.push("e.read_version < v.version");
  if (query.read === "updated") where.push("e.read_version > 0 AND e.read_version < v.version");
  if (query.read === "read") where.push("e.read_version >= v.version");
  const timeColumn = { updated: "v.created_at", created: "e.created_at", archived: "e.archived_at", completed: "e.completed_at" }[query.time_field ?? "updated"];
  if (query.start) { where.push(`${timeColumn} >= ?`); bindings.push(query.start); }
  if (query.end) { where.push(`${timeColumn} < ?`); bindings.push(query.end); }
  return { where, bindings };
}

export async function markMatchingEntriesRead(db: D1Database, scope: ReadScope, query: CurrentEntryQuery): Promise<number> {
  const { where, bindings } = entryFilters(scope, query);
  where.push("e.read_version < v.version", "a.status <> 'deleting'");
  // One atomic statement captures current versions; later versions remain unread.
  const result = await db.prepare(`
    UPDATE entries SET read_version = (SELECT MAX(version) FROM entry_versions WHERE entry_id = entries.id)
    WHERE id IN (
      SELECT e.id FROM entries e JOIN agents a ON a.id = e.agent_id
      JOIN entry_versions v ON v.entry_id = e.id
        AND v.version = (SELECT MAX(version) FROM entry_versions WHERE entry_id = e.id)
      WHERE ${where.join(" AND ")}
    )
  `).bind(...bindings).run();
  return result.meta.changes ?? 0;
}

export async function entryCounts(db: D1Database) {
  return db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN e.archived = 0 AND e.read_version < v.version THEN 1 ELSE 0 END), 0) AS unread,
    COALESCE(SUM(CASE WHEN e.archived = 0 AND v.important = 1 AND e.read_version < v.version THEN 1 ELSE 0 END), 0) AS important_unread,
    COALESCE(SUM(e.archived), 0) AS archived,
    (SELECT COUNT(*) FROM tasks WHERE done = 0 AND ${visibleTaskClause}) AS open_tasks
    FROM entries e JOIN entry_versions v ON v.entry_id = e.id
      AND v.version = (SELECT MAX(version) FROM entry_versions WHERE entry_id = e.id)
  `).first<{ unread: number; important_unread: number; archived: number; open_tasks: number }>();
}

export async function listCurrentEntries(
  db: D1Database,
  scope: ReadScope,
  query: CurrentEntryQuery,
): Promise<CurrentEntryPageRows> {
  const { where, bindings } = entryFilters(scope, query);

  if (query.cursor) {
    if (query.order === "id_asc") {
      where.push("e.id > ?");
      bindings.push(query.cursor[0]!);
    } else if (query.order === "created_asc") {
      where.push("(e.created_at > ? OR (e.created_at = ? AND e.id > ?))");
      bindings.push(query.cursor[0]!, query.cursor[0]!, query.cursor[1]!);
    } else {
      where.push("(v.created_at < ? OR (v.created_at = ? AND e.id < ?))");
      bindings.push(query.cursor[0]!, query.cursor[0]!, query.cursor[1]!);
    }
  }

  const orderBy = query.order === "id_asc"
    ? "e.id ASC"
    : query.order === "created_asc"
      ? "e.created_at ASC, e.id ASC"
      : "v.created_at DESC, e.id DESC";
  const contentColumn = query.view === "full" ? "v.content" : "'' AS content";
  const sql = `
    SELECT
      e.id,
      e.agent_id,
      e.created_at AS entry_created_at,
      e.archived,
      e.archived_at,
      e.read_version,
      e.completed,
      e.completed_at,
      v.version,
      v.title,
      ${contentColumn},
      v.url,
      v.important,
      v.created_at AS updated_at,
      v.created_by_agent_id
    FROM entries e
    JOIN entry_versions v
      ON v.entry_id = e.id
     AND v.version = (
       SELECT MAX(v2.version)
       FROM entry_versions v2
       WHERE v2.entry_id = e.id
     )
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY ${orderBy}
    LIMIT ?
  `;
  bindings.push(query.limit + 1);
  const result = await db.prepare(sql).bind(...bindings).all<CurrentEntryRow>();
  const rows = result.results ?? [];
  return {
    items: rows.slice(0, query.limit).map((row) => mapCurrentRow(row, query.view)),
    hasMore: rows.length > query.limit,
  };
}

export async function findCurrentEntry(
  db: D1Database,
  scope: ReadScope,
  entryId: string,
): Promise<EntryFullDto | null> {
  const where = ["e.id = ?"];
  const bindings: unknown[] = [entryId];
  addScopeWhere(scope, where, bindings);
  const row = await db.prepare(`
    SELECT
      e.id,
      e.agent_id,
      e.created_at AS entry_created_at,
      e.archived,
      e.archived_at,
      e.read_version,
      e.completed,
      e.completed_at,
      v.version,
      v.title,
      v.content,
      v.url,
      v.important,
      v.created_at AS updated_at,
      v.created_by_agent_id
    FROM entries e
    JOIN entry_versions v
      ON v.entry_id = e.id
     AND v.version = (
       SELECT MAX(v2.version) FROM entry_versions v2 WHERE v2.entry_id = e.id
     )
    WHERE ${where.join(" AND ")}
  `).bind(...bindings).first<CurrentEntryRow>();
  return row ? mapCurrentRow(row, "full") as EntryFullDto : null;
}

export async function findOwnerWriteInfo(db: D1Database, ownerId: string): Promise<OwnerWriteInfo | null> {
  const row = await db.prepare("SELECT id, scope, status FROM agents WHERE id = ?")
    .bind(ownerId)
    .first<OwnerWriteRow>();
  return row;
}

export function prepareCreateEntry(
  db: D1Database,
  id: string,
  ownerId: string,
  createdAt: string,
): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO entries (id, agent_id, archived, read_version, completed, completed_at, created_at)
    SELECT ?, a.id, 0, 0, 0, NULL, ?
    FROM agents a
    WHERE a.id = ? AND a.scope = 'own' AND a.status = 'active'
  `).bind(id, createdAt, ownerId);
}

export function prepareCreateInitialVersion(
  db: D1Database,
  entryId: string,
  ownerId: string,
  input: CreateEntryInput,
  actorId: string,
  createdAt: string,
): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO entry_versions (
      entry_id, version, created_by_agent_id, title, content, url, important, created_at
    )
    SELECT e.id, 1, ?, ?, ?, ?, ?, ?
    FROM entries e
    JOIN agents a ON a.id = e.agent_id
    WHERE e.id = ? AND e.agent_id = ? AND a.scope = 'own' AND a.status = 'active'
  `).bind(
    actorId,
    input.title,
    input.content,
    input.url ?? null,
    input.important ? 1 : 0,
    createdAt,
    entryId,
    ownerId,
  );
}

export async function createEntryBatch(
  db: D1Database,
  statements: [D1PreparedStatement, D1PreparedStatement],
): Promise<{ entryChanges: number; versionChanges: number }> {
  const results = await db.batch(statements);
  return {
    entryChanges: results[0]?.meta.changes ?? 0,
    versionChanges: results[1]?.meta.changes ?? 0,
  };
}

export async function findEntryWriteInfo(
  db: D1Database,
  scope: ReadScope,
  entryId: string,
): Promise<EntryWriteInfo | null> {
  const where = ["e.id = ?"];
  const bindings: unknown[] = [entryId];
  addScopeWhere(scope, where, bindings);
  const row = await db.prepare(`
    SELECT
      e.id,
      e.agent_id,
      a.scope AS agent_scope,
      a.status AS agent_status,
      MAX(v.version) AS current_version
    FROM entries e
    JOIN agents a ON a.id = e.agent_id
    JOIN entry_versions v ON v.entry_id = e.id
    WHERE ${where.join(" AND ")}
    GROUP BY e.id, e.agent_id, a.scope, a.status
  `).bind(...bindings).first<EntryWriteRow>();
  return row ? {
    id: row.id,
    agentId: row.agent_id,
    agentScope: row.agent_scope,
    agentStatus: row.agent_status,
    currentVersion: row.current_version,
  } : null;
}

export async function insertVersionIfCurrent(
  db: D1Database,
  scope: ReadScope,
  entryId: string,
  input: AppendVersionInput,
  actorId: string,
  createdAt: string,
): Promise<boolean> {
  const where = [
    "e.id = ?",
    "a.scope = 'own'",
    "a.status = 'active'",
    "(SELECT MAX(v.version) FROM entry_versions v WHERE v.entry_id = e.id) = ?",
  ];
  const scopeBindings: unknown[] = [];
  addScopeWhere(scope, where, scopeBindings);
  const result = await db.prepare(`
    INSERT INTO entry_versions (
      entry_id, version, created_by_agent_id, title, content, url, important, created_at
    )
    SELECT e.id, ?, ?, ?, ?, ?, ?, ?
    FROM entries e
    JOIN agents a ON a.id = e.agent_id
    WHERE ${where.join(" AND ")}
  `).bind(
    input.base_version + 1,
    actorId,
    input.title,
    input.content,
    input.url ?? null,
    input.important ? 1 : 0,
    createdAt,
    entryId,
    input.base_version,
    ...scopeBindings,
  ).run();
  return (result.meta.changes ?? 0) === 1;
}

export async function listVersions(
  db: D1Database,
  scope: ReadScope,
  entryId: string,
  beforeVersion: number | null,
  limit: number,
): Promise<{ items: EntryVersionBriefDto[]; hasMore: boolean }> {
  const where = ["e.id = ?"];
  const bindings: unknown[] = [entryId];
  addScopeWhere(scope, where, bindings);
  if (beforeVersion !== null) {
    where.push("v.version < ?");
    bindings.push(beforeVersion);
  }
  bindings.push(limit + 1);
  const result = await db.prepare(`
    SELECT v.entry_id, v.version, v.title, v.important, v.created_by_agent_id, v.created_at
    FROM entries e
    JOIN entry_versions v ON v.entry_id = e.id
    WHERE ${where.join(" AND ")}
    ORDER BY v.version DESC
    LIMIT ?
  `).bind(...bindings).all<VersionBriefRow>();
  const rows = result.results ?? [];
  return {
    items: rows.slice(0, limit).map((row) => ({
      entry_id: row.entry_id,
      version: row.version,
      title: row.title,
      important: boolFromDb(row.important),
      created_by_agent_id: row.created_by_agent_id,
      created_at: row.created_at,
    })),
    hasMore: rows.length > limit,
  };
}

export async function findVersion(
  db: D1Database,
  scope: ReadScope,
  entryId: string,
  version: number,
): Promise<EntryVersionDto | null> {
  const where = ["e.id = ?", "v.version = ?"];
  const bindings: unknown[] = [entryId, version];
  addScopeWhere(scope, where, bindings);
  const row = await db.prepare(`
    SELECT
      v.entry_id,
      v.version,
      v.created_by_agent_id,
      v.title,
      v.content,
      v.url,
      v.important,
      v.created_at,
      e.archived,
      e.archived_at,
      e.read_version,
      e.completed,
      e.completed_at
    FROM entries e
    JOIN entry_versions v ON v.entry_id = e.id
    WHERE ${where.join(" AND ")}
  `).bind(...bindings).first<VersionRow>();
  return row ? mapVersionRow(row) : null;
}

export async function patchEntryState(
  db: D1Database,
  entryId: string,
  input: { archived?: boolean; read_version?: number; completed?: boolean },
  completedAt: string,
): Promise<boolean> {
  const set: string[] = [];
  const bindings: unknown[] = [];
  const where = [
    "id = ?",
    `EXISTS (
      SELECT 1
      FROM agents a
      WHERE a.id = entries.agent_id AND a.status <> 'deleting'
    )`,
  ];
  const whereBindings: unknown[] = [entryId];

  if (input.archived !== undefined) {
    set.push("archived = ?");
    bindings.push(input.archived ? 1 : 0);
    set.push("archived_at = CASE WHEN ? = 1 THEN COALESCE(archived_at, ?) ELSE NULL END");
    bindings.push(input.archived ? 1 : 0, completedAt);
  }
  if (input.read_version !== undefined) {
    set.push("read_version = MAX(read_version, ?)");
    bindings.push(input.read_version);
    where.push("? <= (SELECT MAX(v.version) FROM entry_versions v WHERE v.entry_id = entries.id)");
    whereBindings.push(input.read_version);
  }
  if (input.completed !== undefined) {
    set.push("completed = ?");
    bindings.push(input.completed ? 1 : 0);
    set.push("completed_at = CASE WHEN ? = 1 THEN COALESCE(completed_at, ?) ELSE NULL END");
    bindings.push(input.completed ? 1 : 0, completedAt);
  }

  const result = await db.prepare(`
    UPDATE entries SET ${set.join(", ")} WHERE ${where.join(" AND ")}
  `).bind(...bindings, ...whereBindings).run();
  return (result.meta.changes ?? 0) === 1;
}

export async function findEntryState(db: D1Database, entryId: string): Promise<EntryStateDto | null> {
  const row = await db.prepare(`
    SELECT archived, archived_at, read_version, completed, completed_at FROM entries WHERE id = ?
  `).bind(entryId).first<StateRow>();
  return row ? mapState(row) : null;
}

export async function findEntryOwnerStatus(
  db: D1Database,
  entryId: string,
): Promise<"active" | "disabled" | "removed" | "deleting" | null> {
  const row = await db.prepare(`
    SELECT a.status
    FROM entries e
    JOIN agents a ON a.id = e.agent_id
    WHERE e.id = ?
  `).bind(entryId).first<{ status: "active" | "disabled" | "removed" | "deleting" }>();
  return row?.status ?? null;
}

export async function findCurrentVersionNumber(db: D1Database, entryId: string): Promise<number | null> {
  const row = await db.prepare(`
    SELECT MAX(version) AS version FROM entry_versions WHERE entry_id = ?
  `).bind(entryId).first<{ version: number | null }>();
  return row?.version ?? null;
}

export async function deleteEntryBatch(db: D1Database, entryId: string): Promise<boolean> {
  const results = await db.batch<{ id: string }>([
    db.prepare("UPDATE agents SET main_entry_id = NULL WHERE main_entry_id = ?").bind(entryId),
    db.prepare("UPDATE tasks SET entry_id = NULL WHERE entry_id = ?").bind(entryId),
    db.prepare("DELETE FROM entries WHERE id = ? RETURNING id").bind(entryId),
  ]);
  // Cascading version deletions can increase meta.changes beyond one.
  return results[2]?.results.some((row) => row.id === entryId) ?? false;
}
