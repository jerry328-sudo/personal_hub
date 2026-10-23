import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../../src/server/app";
import worker from "../../src/server/index";
import type { AgentDto, IssuedKeyDto, Page, TaskDto, TaskTagDto } from "../../src/shared/contracts";

const origin = "http://localhost:5173";
type Created = { agent: AgentDto; key: IssuedKeyDto };
type Auth = { cookie?: string; token?: string };
async function request(path: string, auth: Auth, method = "GET", body?: unknown) {
  const headers = new Headers({ Origin: origin, "CF-Connecting-IP": crypto.randomUUID() });
  if (auth.cookie) headers.set("Cookie", auth.cookie);
  if (auth.token) headers.set("Authorization", `Bearer ${auth.token}`);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return app.request(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, env);
}
async function setup() {
  const login = await request("/api/v1/auth/login", {}, "POST", { secret: "test-admin-secret-with-sufficient-entropy" });
  expect(login.status).toBe(200);
  const admin = { cookie: login.headers.get("Set-Cookie")!.split(";")[0]! };
  const create = async (extra: Record<string, unknown> = {}) => {
    const response = await request("/api/v1/admin/agents", admin, "POST", { name: "Tag source", ...extra });
    expect(response.status).toBe(201); return response.json<Created>();
  };
  const source = await create(); const other = await create(); const manager = await create({ role: "manager" });
  return { admin, source, other, manager, create };
}
async function tag(admin: Auth, name: string = crypto.randomUUID()) {
  const response = await request("/api/v1/admin/task-tags", admin, "POST", { name });
  expect(response.status).toBe(201); return response.json<TaskTagDto>();
}
async function task(token: string, tag_ids?: string[]) {
  const response = await request("/api/v1/agent/tasks", { token }, "POST", { title: "Keep this task", ...(tag_ids ? { tag_ids } : {}) });
  expect(response.status).toBe(201); return response.json<TaskDto>();
}
async function list(token: string, query = "") {
  const response = await request(`/api/v1/agent/tasks${query}`, { token });
  expect(response.status).toBe(200); return response.json<Page<TaskDto>>();
}
beforeEach(async () => { await env.DB.prepare("UPDATE agents SET status = 'disabled' WHERE scope = 'all' AND access_mode = 'read_write'").run(); });

describe("task tags", () => {
  it("deleting a tag preserves tasks, completion, source and other tags", async () => {
    const { admin, source } = await setup(); const a = await tag(admin); const b = await tag(admin);
    const value = await task(source.key.secret, [a.id, b.id]);
    const auth = { token: source.key.secret };
    expect(value.tags.map(t => t.id).sort()).toEqual([a.id, b.id].sort());
    const marked = await request(`/api/v1/agent/tasks/${value.id}`, auth, "PATCH", { done: true });
    expect((await marked.json<TaskDto>()).tags).toHaveLength(2);
    expect((await request(`/api/v1/admin/task-tags/${a.id}`, admin, "DELETE")).status).toBe(204);
    const kept = (await list(source.key.secret)).items[0]!;
    expect(kept).toMatchObject({ id: value.id, agent_id: source.agent.id, title: value.title, done: true });
    expect(kept.tags.map(t => t.id)).toEqual([b.id]);
    await request(`/api/v1/admin/task-tags/${b.id}`, admin, "DELETE");
    expect((await list(source.key.secret, "?untagged=yes")).items[0]?.id).toBe(value.id);
  });

  it("ordinary agents use existing tags only on their own tasks; managers manage all", async () => {
    const { admin, source, other, manager } = await setup(); const a = await tag(admin); const b = await tag(admin);
    const value = await task(source.key.secret, [a.id]); const auth = { token: source.key.secret };
    expect((await request("/api/v1/agent/task-tags", auth)).status).toBe(200);
    for (const method of ["POST", "PATCH", "DELETE"]) {
      const suffix = method === "POST" ? "" : `/${a.id}`;
      expect((await request(`/api/v1/admin/task-tags${suffix}`, auth, method, method === "DELETE" ? undefined : { name: "Blocked" })).status).toBe(403);
      expect((await request(`/api/v1/agent/task-tags${suffix}`, auth, method, method === "DELETE" ? undefined : { name: "Blocked" })).status).toBe(404);
    }
    expect((await request(`/api/v1/agent/tasks/${value.id}`, { token: other.key.secret }, "PATCH", { add_tag_ids: [b.id] })).status).toBe(404);
    const changed = await request(`/api/v1/agent/tasks/${value.id}`, auth, "PATCH", { add_tag_ids: [b.id], remove_tag_ids: [a.id] });
    expect((await changed.json<TaskDto>()).tags.map(t => t.id)).toEqual([b.id]);
    const renamed = await request(`/api/v1/manager/task-tags/${b.id}`, { token: manager.key.secret }, "PATCH", { name: `Renamed ${crypto.randomUUID().slice(0, 8)}` });
    expect(renamed.status).toBe(200);
    expect((await request(`/api/v1/manager/tasks/${value.id}`, { token: manager.key.secret }, "PATCH", { add_tag_ids: [a.id] })).status).toBe(200);
  });

  it("filters before pagination and binds cursors to the selected tag", async () => {
    const { admin, source } = await setup(); const a = await tag(admin); const b = await tag(admin);
    const first = await task(source.key.secret, [a.id, b.id]); const second = await task(source.key.secret, [a.id]); await task(source.key.secret);
    const page = await list(source.key.secret, `?tag_id=${a.id}&limit=1`);
    expect(page.items).toHaveLength(1); expect(page.next_cursor).toBeTruthy();
    const next = await list(source.key.secret, `?tag_id=${a.id}&limit=1&cursor=${encodeURIComponent(page.next_cursor!)}`);
    expect([page.items[0]!.id, next.items[0]!.id].sort()).toEqual([first.id, second.id].sort()); expect(next.next_cursor).toBeNull();
    expect((await request(`/api/v1/agent/tasks?tag_id=${b.id}&limit=1&cursor=${encodeURIComponent(page.next_cursor!)}`, { token: source.key.secret })).status).toBe(400);
    expect((await list(source.key.secret, "?untagged=yes")).items).toHaveLength(1);
    expect((await request(`/api/v1/agent/tasks?tag_id=${a.id}&untagged=yes`, { token: source.key.secret })).status).toBe(400);
  });

  it("clears completed tasks only inside source and label scope", async () => {
    const { admin, source, other } = await setup(); const a = await tag(admin); const b = await tag(admin);
    const completed = await task(source.key.secret, [a.id]); const keep = await task(source.key.secret, [b.id]); const pending = await task(source.key.secret, [a.id]); const peer = await task(other.key.secret, [a.id]);
    for (const item of [completed, keep, peer]) await request(`/api/v1/admin/tasks/${item.id}`, admin, "PATCH", { done: true });
    const result = await request("/api/v1/admin/tasks/completed/clear", admin, "POST", { agent_id: source.agent.id, tag_id: a.id });
    expect(await result.json()).toEqual({ cleared: 1 });
    expect((await list(source.key.secret)).items.map(t => t.id).sort()).toEqual([keep.id, pending.id].sort());
    expect((await list(other.key.secret)).items[0]?.id).toBe(peer.id);
    expect(await env.DB.prepare("SELECT * FROM task_tag_links WHERE task_id = ?").bind(completed.id).first()).toBeNull();
    expect((await request("/api/v1/admin/task-tags", admin)).status).toBe(200);
  });

  it("readers see only tags attached to currently authorized tasks", async () => {
    const { admin, source, other, create } = await setup(); const a = await tag(admin); const b = await tag(admin); const unused = await tag(admin);
    await task(source.key.secret, [a.id]); await task(other.key.secret, [b.id]);
    const reader = await create({ role: "reader", read_access: { mode: "selected", agent_ids: [source.agent.id] } });
    const auth = { token: reader.key.secret };
    const response = await request("/api/v1/reader/task-tags", auth); expect(response.status).toBe(200);
    expect((await response.json<Page<TaskTagDto>>()).items.map(t => t.id)).toEqual([a.id]);
    const hidden = await request(`/api/v1/reader/tasks?tag_id=${b.id}`, auth);
    expect((await hidden.json<Page<TaskDto>>()).items).toHaveLength(0);
    expect((await request(`/api/v1/reader/task-tags/${unused.id}`, auth, "DELETE")).status).toBe(404);
    expect((await request("/api/v1/admin/task-tags", auth, "POST", { name: "Blocked" })).status).toBe(403);
  });

  it("validates duplicate names and IDs without partial task updates", async () => {
    const { admin, source } = await setup(); const name = `Work-${crypto.randomUUID().slice(0, 8)}`; const a = await tag(admin, name);
    expect((await request("/api/v1/admin/task-tags", admin, "POST", { name: ` ${name.toUpperCase()} ` })).status).toBe(409);
    const value = await task(source.key.secret); const auth = { token: source.key.secret };
    for (const patch of [{ title: "Changed", add_tag_ids: ["missing"] }, { add_tag_ids: [a.id, a.id] }, { add_tag_ids: [a.id], remove_tag_ids: [a.id] }]) {
      expect((await request(`/api/v1/agent/tasks/${value.id}`, auth, "PATCH", patch)).status).toBeGreaterThanOrEqual(400);
    }
    expect((await list(source.key.secret)).items[0]?.title).toBe(value.title);
    await env.DB.exec("CREATE TRIGGER reject_tag_link BEFORE INSERT ON task_tag_links BEGIN SELECT RAISE(ABORT, 'tag write blocked'); END;");
    try {
      expect((await request(`/api/v1/agent/tasks/${value.id}`, auth, "PATCH", { title: "Must roll back", add_tag_ids: [a.id] })).status).toBe(500);
      expect((await request("/api/v1/agent/tasks", auth, "POST", { title: "Must not exist", tag_ids: [a.id] })).status).toBe(500);
      expect((await list(source.key.secret)).items).toHaveLength(1);
      expect((await list(source.key.secret)).items[0]?.title).toBe(value.title);
    } finally { await env.DB.exec("DROP TRIGGER reject_tag_link"); }
  });

  it("supports MCP tag operations and keeps ordinary tool permissions scoped", async () => {
    const { source, manager } = await setup();
    const call = async (token: string, name: string, args: unknown) => {
      const response = await worker.fetch(new Request(origin + "/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), env, createExecutionContext());
      expect(response.status).toBe(200);
      return response.json<{ result?: { isError?: boolean; structuredContent?: { result: unknown } }; error?: unknown }>();
    };
    const created = await call(manager.key.secret, "create_task_tag", { name: `MCP-${crypto.randomUUID().slice(0, 8)}` });
    expect(created.result?.isError).not.toBe(true);
    const a = created.result!.structuredContent!.result as TaskTagDto;
    const value = (await call(source.key.secret, "create_task", { title: "MCP tagged", tag_ids: [a.id] })).result!.structuredContent!.result as TaskDto;
    expect(value.tags[0]?.id).toBe(a.id);
    const forbidden = await call(source.key.secret, "delete_task_tag", { id: a.id });
    expect(Boolean(forbidden.error || forbidden.result?.isError)).toBe(true);
    expect((await call(manager.key.secret, "delete_task_tag", { id: a.id })).result?.isError).not.toBe(true);
    expect((await list(source.key.secret)).items[0]?.tags).toEqual([]);
  });
});
