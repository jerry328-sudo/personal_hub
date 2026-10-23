import type { Page, TaskTagDto } from "../../../shared/contracts";
import type { ServiceContext } from "../../env";
import { readerScopeOf, requireManagementActor, requireOwnAgentActor, requireReaderActor } from "../../shared/authorize";
import { appendReadAccessPredicate } from "../../shared/read-access";
import { badRequest, conflict, notFound } from "../../shared/errors";
import { newEntityId, nowIso } from "../../shared/ids";
import { cursorScopeFor, decodeCursor, encodeCursor, queryFingerprint } from "../../shared/pagination";

export async function listTaskTags(ctx: ServiceContext, query: { cursor?: string; limit?: number }): Promise<Page<TaskTagDto>> {
  const where: string[] = [];
  const bindings: unknown[] = [];
  if (ctx.actor.type === "agent" && ctx.actor.role === "reader") {
    requireReaderActor(ctx.actor);
    const access: string[] = [];
    appendReadAccessPredicate("tasks.agent_id", readerScopeOf(ctx.actor), access, bindings);
    where.push(`EXISTS (SELECT 1 FROM task_tag_links l JOIN tasks ON tasks.id = l.task_id WHERE l.tag_id = task_tags.id AND ${access.join(" AND ")})`);
  } else if (ctx.actor.type === "agent" && ctx.actor.role === "agent") {
    requireOwnAgentActor(ctx.actor);
  } else requireManagementActor(ctx.actor);
  const fingerprint = queryFingerprint({ kind: "task_tags", order: "id_asc" });
  const cursor = decodeCursor(query.cursor, fingerprint, cursorScopeFor(ctx.actor));
  if (cursor && cursor.length !== 1) throw badRequest("分页游标无效");
  if (cursor) { where.push("id > ?"); bindings.push(cursor[0]); }
  const limit = query.limit ?? 100;
  const result = await ctx.env.DB.prepare(`SELECT id, name, created_at FROM task_tags ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id LIMIT ?`)
    .bind(...bindings, limit + 1).all<TaskTagDto>();
  const items = result.results.slice(0, limit);
  return { items, next_cursor: result.results.length > limit ? encodeCursor([items.at(-1)!.id], fingerprint, cursorScopeFor(ctx.actor)) : null };
}

function tagName(name: string) {
  const value = name.normalize("NFKC").trim();
  if (!value || value.length > 40) throw badRequest("标签名称须为 1–40 个字符");
  return { name: value, key: value.toLowerCase() };
}

export async function createTaskTag(ctx: ServiceContext, input: { name: string }): Promise<TaskTagDto> {
  requireManagementActor(ctx.actor);
  const name = tagName(input.name);
  const row = await ctx.env.DB.prepare(`INSERT INTO task_tags (id, name, name_key, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(name_key) DO NOTHING RETURNING id, name, created_at`)
    .bind(newEntityId("tag"), name.name, name.key, nowIso()).first<TaskTagDto>();
  if (!row) throw conflict("已存在同名标签");
  return row;
}

export async function updateTaskTag(ctx: ServiceContext, id: string, input: { name: string }): Promise<TaskTagDto> {
  requireManagementActor(ctx.actor);
  const name = tagName(input.name);
  try {
    const row = await ctx.env.DB.prepare("UPDATE task_tags SET name = ?, name_key = ? WHERE id = ? RETURNING id, name, created_at")
      .bind(name.name, name.key, id).first<TaskTagDto>();
    if (!row) throw notFound("标签不存在");
    return row;
  } catch (error) {
    if (String(error).includes("UNIQUE constraint")) throw conflict("已存在同名标签");
    throw error;
  }
}

export async function deleteTaskTag(ctx: ServiceContext, id: string): Promise<void> {
  requireManagementActor(ctx.actor);
  const result = await ctx.env.DB.prepare("DELETE FROM task_tags WHERE id = ?").bind(id).run();
  if (!result.meta.changes) throw notFound("标签不存在");
}

export async function validateTaskTags(db: D1Database, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const rows = await db.prepare(`SELECT id FROM task_tags WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<{ id: string }>();
  if (rows.results.length !== ids.length) throw notFound("部分标签已删除，请刷新后重试");
}

export async function tagsForTasks(db: D1Database, taskIds: string[]): Promise<Map<string, TaskTagDto[]>> {
  const tags = new Map<string, TaskTagDto[]>();
  if (!taskIds.length) return tags;
  const rows = await db.prepare(`SELECT l.task_id, t.id, t.name, t.created_at FROM task_tag_links l JOIN task_tags t ON t.id = l.tag_id WHERE l.task_id IN (${taskIds.map(() => "?").join(",")}) ORDER BY t.name_key, t.id`)
    .bind(...taskIds).all<TaskTagDto & { task_id: string }>();
  for (const { task_id, ...tag } of rows.results) {
    const current = tags.get(task_id) ?? []; current.push(tag); tags.set(task_id, current);
  }
  return tags;
}
