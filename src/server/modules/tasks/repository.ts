import type { TaskDto } from "../../../shared/contracts";
import type { ReaderScope } from "../../shared/authorize";
import { boolFromDb } from "../../shared/db";
import { appendReadAccessPredicate } from "../../shared/read-access";

export type TaskRow = {
  id: string;
  agent_id: string;
  entry_id: string | null;
  title: string;
  done: number | boolean;
  due_at: string | null;
  created_at: string;
};

export type TaskListScope = {
  agentId?: string;
  done?: boolean;
  excludeArchivedEntries?: boolean;
  readerAccess?: ReaderScope;
  afterId?: string;
  limit: number;
};

export type EntryOwnerRow = {
  agent_id: string;
};

export type InsertTaskRecord = {
  id: string;
  agentId: string;
  entryId: string | null;
  title: string;
  dueAt: string | null;
  createdAt: string;
};

export type PatchTaskRecord = {
  title?: string;
  dueAt?: string | null;
  done?: boolean;
};

export type TaskOwnerWritePolicy = "active" | "not_deleting";

function ownerLifecycleClause(policy: TaskOwnerWritePolicy): string {
  const statusClause = policy === "active"
    ? "a.status = 'active'"
    : "a.status <> 'deleting'";
  return ` AND EXISTS (
    SELECT 1 FROM agents a
    WHERE a.id = tasks.agent_id AND a.scope = 'own' AND ${statusClause}
  )`;
}

export function taskDto(row: TaskRow): TaskDto {
  return {
    id: row.id,
    agent_id: row.agent_id,
    entry_id: row.entry_id,
    title: row.title,
    done: boolFromDb(row.done),
    due_at: row.due_at,
    created_at: row.created_at,
  };
}

export const visibleTaskClause = "NOT EXISTS (SELECT 1 FROM entries source_entry WHERE source_entry.id = tasks.entry_id AND source_entry.archived = 1)";

export async function listTasks(db: D1Database, scope: TaskListScope): Promise<TaskRow[]> {
  const where: string[] = [];
  const bindings: unknown[] = [];
  if (scope.excludeArchivedEntries) where.push(visibleTaskClause);

  if (scope.agentId !== undefined) {
    where.push("agent_id = ?");
    bindings.push(scope.agentId);
  }
  if (scope.readerAccess !== undefined) {
    appendReadAccessPredicate("tasks.agent_id", scope.readerAccess, where, bindings);
  }
  if (scope.done !== undefined) {
    where.push("done = ?");
    bindings.push(scope.done ? 1 : 0);
  }
  if (scope.afterId !== undefined) {
    where.push("id > ?");
    bindings.push(scope.afterId);
  }

  const sql = `
    SELECT id, agent_id, entry_id, title, done, due_at, created_at
    FROM tasks
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY id ASC
    LIMIT ?
  `;
  bindings.push(scope.limit);

  const result = await db.prepare(sql).bind(...bindings).all<TaskRow>();
  return result.results;
}

export async function findTask(
  db: D1Database,
  id: string,
  ownerId?: string,
): Promise<TaskRow | null> {
  const statement = ownerId === undefined
    ? db.prepare(`
        SELECT id, agent_id, entry_id, title, done, due_at, created_at
        FROM tasks WHERE id = ?
      `).bind(id)
    : db.prepare(`
        SELECT id, agent_id, entry_id, title, done, due_at, created_at
        FROM tasks WHERE id = ? AND agent_id = ?
      `).bind(id, ownerId);
  return statement.first<TaskRow>();
}

export async function findEntryOwner(
  db: D1Database,
  entryId: string,
  ownerId?: string,
): Promise<EntryOwnerRow | null> {
  const statement = ownerId === undefined
    ? db.prepare("SELECT agent_id FROM entries WHERE id = ?").bind(entryId)
    : db.prepare("SELECT agent_id FROM entries WHERE id = ? AND agent_id = ?").bind(entryId, ownerId);
  return statement.first<EntryOwnerRow>();
}

/**
 * The conditional INSERT rechecks the target lifecycle at commit time. Tasks
 * may only belong to an own-scope Agent; managers are actors, not partitions.
 */
export async function insertTask(
  db: D1Database,
  record: InsertTaskRecord,
  allowDisabledOwner: boolean,
): Promise<TaskRow | null> {
  const writableStatus = allowDisabledOwner
    ? "a.status IN ('active', 'disabled')"
    : "a.status = 'active'";
  const statement = db.prepare(`
    INSERT INTO tasks (id, agent_id, entry_id, title, done, due_at, created_at)
    SELECT ?, ?, ?, ?, 0, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM agents a
      WHERE a.id = ? AND a.scope = 'own' AND ${writableStatus}
    )
    AND (
      ? IS NULL OR EXISTS (
        SELECT 1 FROM entries e WHERE e.id = ? AND e.agent_id = ?
      )
    )
    RETURNING id, agent_id, entry_id, title, done, due_at, created_at
  `).bind(
    record.id,
    record.agentId,
    record.entryId,
    record.title,
    record.dueAt,
    record.createdAt,
    record.agentId,
    record.entryId,
    record.entryId,
    record.agentId,
  );
  return statement.first<TaskRow>();
}

export async function patchTask(
  db: D1Database,
  id: string,
  ownerId: string | undefined,
  patch: PatchTaskRecord,
  ownerWritePolicy: TaskOwnerWritePolicy,
): Promise<TaskRow | null> {
  const assignments: string[] = [];
  const bindings: unknown[] = [];

  if (patch.title !== undefined) {
    assignments.push("title = ?");
    bindings.push(patch.title);
  }
  if (patch.dueAt !== undefined) {
    assignments.push("due_at = ?");
    bindings.push(patch.dueAt);
  }
  if (patch.done !== undefined) {
    assignments.push("done = ?");
    bindings.push(patch.done ? 1 : 0);
  }

  const ownerClause = ownerId === undefined ? "" : " AND agent_id = ?";
  const lifecycleClause = ownerLifecycleClause(ownerWritePolicy);
  bindings.push(id);
  if (ownerId !== undefined) bindings.push(ownerId);

  const statement = db.prepare(`
    UPDATE tasks
    SET ${assignments.join(", ")}
    WHERE id = ?${ownerClause}${lifecycleClause}
    RETURNING id, agent_id, entry_id, title, done, due_at, created_at
  `).bind(...bindings);
  return statement.first<TaskRow>();
}

export async function deleteTask(
  db: D1Database,
  id: string,
  ownerId?: string,
  ownerWritePolicy: TaskOwnerWritePolicy = "not_deleting",
): Promise<boolean> {
  const ownerClause = ownerId === undefined ? "" : " AND agent_id = ?";
  const lifecycleClause = ownerLifecycleClause(ownerWritePolicy);
  const bindings: unknown[] = [id];
  if (ownerId !== undefined) bindings.push(ownerId);
  const statement = db.prepare(
    `DELETE FROM tasks WHERE id = ?${ownerClause}${lifecycleClause}`,
  ).bind(...bindings);
  const result = await statement.run();
  return (result.meta.changes ?? 0) > 0;
}

export function prepareDetachEntryTasks(db: D1Database, entryId: string): D1PreparedStatement {
  return db.prepare("UPDATE tasks SET entry_id = NULL WHERE entry_id = ?").bind(entryId);
}

export function prepareMoveAgentTasksToManual(db: D1Database, agentId: string): D1PreparedStatement {
  return db.prepare(`
    UPDATE tasks
    SET agent_id = 'manual', entry_id = NULL
    WHERE agent_id = ?
  `).bind(agentId);
}
