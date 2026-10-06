import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentDto, IssuedKeyDto, Page, TaskDto } from "../../src/shared/contracts";
import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import worker from "../../src/server/index";
import { PANEL_RESOURCE_URI, type PanelSnapshot } from "../../src/shared/panel";

const origin = "http://localhost:5173";
const secret = "test-admin-secret-with-sufficient-entropy";
type Created = { agent: AgentDto; key: IssuedKeyDto };
type RpcResult = { result?: { tools?: { name: string; title?: string; _meta?: Record<string, unknown> }[]; isError?: boolean; structuredContent?: { result?: unknown }; content?: { type: string; text?: string; data?: string }[];
  _meta?: Record<string, unknown>; resources?: { uri: string }[];
  contents?: { uri: string; mimeType?: string; text?: string; _meta?: Record<string, unknown> }[] }; error?: unknown };
function hasWorker(value: object): value is { default: Fetcher } { return "default" in value; }
async function request(path: string, init: RequestInit = {}): Promise<Response> {
  if (!hasWorker(exports)) throw new Error("Worker unavailable");
  const headers = new Headers(init.headers);
  headers.set("CF-Connecting-IP", crypto.randomUUID());
  return exports.default.fetch(new Request(`${origin}${path}`, { ...init, redirect: "manual", headers }));
}
function json(method: string, body: unknown, headers: HeadersInit = {}): RequestInit {
  return { method, body: JSON.stringify(body), headers: { ...headers, "Content-Type": "application/json" } };
}
function cookies(response: Response): string {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}
async function login(): Promise<string> {
  const response = await request("/api/v1/auth/login", json("POST", { secret }, { Origin: origin }));
  expect(response.status).toBe(200); return cookies(response);
}
async function agent(cookie: string, input: Record<string, unknown> = {}): Promise<Created> {
  const response = await request("/api/v1/admin/agents", json("POST", { name: "MCP test", ...input }, { Cookie: cookie, Origin: origin }));
  expect(response.status).toBe(201); return response.json();
}
async function rpc(token: string, method: string, params: unknown = {}): Promise<RpcResult> {
  const response = await request("/mcp", json("POST", { jsonrpc: "2.0", id: 1, method, params }, {
    Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25",
  }));
  expect(response.status).toBe(200); return response.json();
}
async function tool(token: string, name: string, args: unknown = {}): Promise<RpcResult> {
  return rpc(token, "tools/call", { name, arguments: args });
}
function value<T>(result: RpcResult): T { return result.result?.structuredContent?.result as T; }

describe("Codex Hub MCP App", () => {
  afterEach(async () => { await env.DB.prepare("UPDATE agents SET status = 'disabled' WHERE scope = 'all'").run(); });
  it("clears completed tasks across pages within owner scope, preserving unfinished tasks and original entries", async () => {
    const cookie = await login();
    const first = await agent(cookie);
    const second = await agent(cookie);
    const linked = value<{ id: string }>(await tool(first.key.secret, "create_entry", { entry: { title: "Keep original", content: "Original body" } }));
    await env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<105)
      INSERT INTO tasks (id, agent_id, entry_id, title, done, created_at)
      SELECT ? || i, ?, NULL, 'Completed', 1, '2026-10-06T00:00:00Z' FROM n`).bind(`bulk-${crypto.randomUUID()}-`, first.agent.id).run();
    const pending = value<TaskDto>(await tool(first.key.secret, "create_task", { title: "Keep unfinished" }));
    const archived = value<TaskDto>(await tool(first.key.secret, "create_task", { title: "Keep archived link", entry_id: linked.id }));
    await env.DB.prepare("UPDATE tasks SET done=1 WHERE id=?").bind(archived.id).run();
    await env.DB.prepare("UPDATE entries SET archived=1 WHERE id=?").bind(linked.id).run();
    const peer = value<TaskDto>(await tool(second.key.secret, "create_task", { title: "Other owner" }));
    await env.DB.prepare("UPDATE tasks SET done=1 WHERE id=?").bind(peer.id).run();
    expect((await tool(first.key.secret, "clear_completed_tasks", { agent_id: second.agent.id })).result?.isError).toBe(true);
    expect(value(await tool(first.key.secret, "clear_completed_tasks"))).toEqual({ cleared: 105 });
    expect(value(await tool(first.key.secret, "clear_completed_tasks"))).toEqual({ cleared: 0 });
    for (const id of [pending.id, peer.id]) expect(await env.DB.prepare("SELECT id FROM tasks WHERE id=?").bind(id).first()).not.toBeNull();
    expect(await env.DB.prepare("SELECT id FROM tasks WHERE id=?").bind(archived.id).first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM entries WHERE id=?").bind(linked.id).first()).not.toBeNull();
  });
  it("returns a handled cleanup failure and keeps the API usable after a database write error", async () => {
    const cookie = await login(); const source = await agent(cookie);
    const task = value<TaskDto>(await tool(source.key.secret, "create_task", { title: "Cleanup failure fixture" }));
    await env.DB.prepare("UPDATE tasks SET done=1 WHERE id=?").bind(task.id).run();
    await env.DB.exec(`CREATE TRIGGER fail_cleanup BEFORE DELETE ON tasks WHEN OLD.id='${task.id}' BEGIN SELECT RAISE(ABORT, 'D1 quota failure fixture'); END;`);
    try {
      const response = await request("/api/v1/admin/tasks/completed/clear", json("POST", { agent_id: source.agent.id }, { Cookie: cookie, Origin: origin }));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "service_unavailable", message: "暂时无法清除已完成待办，请稍后再试" } });
      expect((await tool(source.key.secret, "clear_completed_tasks")).result?.isError).toBe(true);
      expect(await env.DB.prepare("SELECT id FROM tasks WHERE id=?").bind(task.id).first()).not.toBeNull();
      expect((await request(`/api/v1/admin/tasks?agent_id=${source.agent.id}`, { headers: { Cookie: cookie } })).status).toBe(200);
    } finally { await env.DB.exec("DROP TRIGGER IF EXISTS fail_cleanup;"); }
  });
  it("cleans historical archived tasks of both states once and preserves unrelated tasks and records", async () => {
    const cookie = await login(); const source = await agent(cookie);
    const archived = value<{ id: string }>(await tool(source.key.secret, "create_entry", { entry: { title: "Historical archive", content: "Keep history" } }));
    const current = value<{ id: string }>(await tool(source.key.secret, "create_entry", { entry: { title: "Active record", content: "Keep active" } }));
    await env.DB.exec("DROP TRIGGER delete_tasks_on_archive; DROP TRIGGER reject_archived_task_insert; DROP INDEX tasks_entry_id;");
    const make = async (title: string, entry_id?: string) => value<TaskDto>(await tool(source.key.secret, "create_task", { title, ...(entry_id ? { entry_id } : {}) }));
    const open = await make("Old hidden unfinished", archived.id);
    const done = await make("Old hidden completed", archived.id);
    const active = await make("Keep active task", current.id);
    const standalone = await make("Keep standalone");
    await env.DB.prepare("UPDATE tasks SET done=1 WHERE id=?").bind(done.id).run();
    await env.DB.prepare("UPDATE entries SET archived=1 WHERE id=?").bind(archived.id).run();
    const migration = env.TEST_MIGRATIONS.find((item) => item.name.includes("0007"))!;
    await applyD1Migrations(env.DB, [{ name: "cleanup-history-test", queries: migration.queries }]);
    const plan = await env.DB.prepare("EXPLAIN QUERY PLAN DELETE FROM tasks WHERE entry_id = ?").bind(archived.id).all<{ detail: string }>();
    expect(plan.results.map((row) => row.detail).join(" ")).toContain("tasks_entry_id");
    for (const id of [open.id, done.id]) expect(await env.DB.prepare("SELECT id FROM tasks WHERE id=?").bind(id).first()).toBeNull();
    for (const id of [active.id, standalone.id]) expect(await env.DB.prepare("SELECT id FROM tasks WHERE id=?").bind(id).first()).not.toBeNull();
    for (const id of [archived.id, current.id]) expect(await env.DB.prepare("SELECT id FROM entries WHERE id=?").bind(id).first()).not.toBeNull();
    expect((await tool(source.key.secret, "create_task", { title: "Reject old client", entry_id: archived.id })).result?.isError).toBe(true);
    // The cleanup DELETE also includes old archived rows if applied independently.
    await env.DB.exec("DROP TRIGGER reject_archived_task_insert;");
    await env.DB.prepare("INSERT INTO tasks(id, agent_id, entry_id, title, done, created_at) VALUES (?, ?, ?, 'Legacy done', 1, '2026-10-06T00:00:00Z')").bind(`legacy-${crypto.randomUUID()}`, source.agent.id, archived.id).run();
    expect(value(await tool(source.key.secret, "clear_completed_tasks"))).toEqual({ cleared: 1 });
    await env.DB.prepare(migration.queries.find((query) => query.includes("CREATE TRIGGER reject_archived_task_insert"))!).run();
  });
  it("rolls back archive state and every linked deletion on failure and blocks direct archived inserts", async () => {
    const cookie = await login(); const source = await agent(cookie); const manager = await agent(cookie, { role: "manager" });
    const entry = value<{ id: string }>(await tool(source.key.secret, "create_entry", { entry: { title: "Atomic archive", content: "Keep original" } }));
    const first = value<TaskDto>(await tool(source.key.secret, "create_task", { title: "First", entry_id: entry.id }));
    const second = value<TaskDto>(await tool(source.key.secret, "create_task", { title: "Second", entry_id: entry.id }));
    await env.DB.exec(`CREATE TRIGGER fail_archive_delete BEFORE DELETE ON tasks WHEN OLD.id='${second.id}' BEGIN SELECT RAISE(ABORT, 'D1 write failure'); END;`);
    try {
      expect((await tool(manager.key.secret, "update_entry_state", { id: entry.id, state: { archived: true } })).result?.isError).toBe(true);
      expect((await env.DB.prepare("SELECT archived FROM entries WHERE id=?").bind(entry.id).first<{ archived: number }>())?.archived).toBe(0);
      for (const id of [first.id, second.id]) expect(await env.DB.prepare("SELECT id FROM tasks WHERE id=?").bind(id).first()).not.toBeNull();
    } finally { await env.DB.exec("DROP TRIGGER fail_archive_delete;"); }
    expect((await tool(manager.key.secret, "update_entry_state", { id: entry.id, state: { archived: true } })).result?.isError).not.toBe(true);
    await expect(env.DB.prepare("INSERT INTO tasks(id, agent_id, entry_id, title, done, created_at) VALUES ('blocked-direct', ?, ?, 'Blocked', 0, '2026-10-06T00:00:00Z')").bind(source.agent.id, entry.id).run()).rejects.toThrow("archived_entry_task");
  });
  it("matches website tasks across roles after archive deletion; legacy archive flags no longer change pagination", async () => {
    const cookie = await login();
    const source = await agent(cookie, { name: "Task parity source" });
    const manager = await agent(cookie, { role: "manager", name: "Task parity manager" });
    const archived = value<{ id: string }>(await tool(source.key.secret, "create_entry", { entry: { title: "Archived source", content: "history" } }));
    const active = value<{ id: string }>(await tool(source.key.secret, "create_entry", { entry: { title: "Active source", content: "current" } }));
    const create = async (title: string, entry_id?: string) => value<TaskDto>(await tool(source.key.secret, "create_task", { title, ...(entry_id ? { entry_id } : {}) }));
    const hidden = await create("archived open", archived.id);
    const done = await create("completed", active.id);
    await tool(source.key.secret, "update_task", { id: done.id, task: { done: true } });
    const linked = await create("current open", active.id);
    const standalone = await create("standalone");
    await tool(manager.key.secret, "update_entry_state", { id: archived.id, state: { archived: true } });
    const query = { agent_id: source.agent.id, done: "no", include_archived: "no", limit: 1 };
    const first = value<Page<TaskDto>>(await tool(manager.key.secret, "list_tasks", query));
    expect(first.items).toHaveLength(1); expect(first.next_cursor).toBeTruthy();
    const second = value<Page<TaskDto>>(await tool(manager.key.secret, "list_tasks", { ...query, cursor: first.next_cursor }));
    expect([...first.items, ...second.items].map((item) => item.id).sort()).toEqual([linked.id, standalone.id].sort());
    expect(second.next_cursor).toBeNull();
    const webResponse = await request(`/api/v1/admin/tasks?agent_id=${source.agent.id}&done=no`, { headers: { Cookie: cookie } });
    const web = await webResponse.json() as Page<TaskDto>;
    expect(web.items.map((item) => item.id).sort()).toEqual([linked.id, standalone.id].sort());
    const history = value<Page<TaskDto>>(await tool(manager.key.secret, "list_tasks", { agent_id: source.agent.id, done: "all" }));
    expect(history.items.map((item) => item.id).sort()).toEqual([done.id, linked.id, standalone.id].sort());
    expect((await tool(manager.key.secret, "list_tasks", { ...query, include_archived: "yes", cursor: first.next_cursor })).result?.isError).not.toBe(true);
    expect(await env.DB.prepare("SELECT id FROM tasks WHERE id=?").bind(hidden.id).first()).toBeNull();
    expect((await tool(source.key.secret, "create_task", { title: "Cannot recreate hidden task", entry_id: archived.id })).result?.isError).toBe(true);
    await tool(manager.key.secret, "update_entry_state", { id: archived.id, state: { archived: false } });
    const restored = value<Page<TaskDto>>(await tool(manager.key.secret, "list_tasks", { ...query, limit: 100 }));
    expect(restored.items.map((item) => item.id).sort()).toEqual([linked.id, standalone.id].sort());
  });
  it("advertises navigation and thread entrypoints, serves isolated HTML and returns authorized launch data", async () => {
    const cookie = await login();
    const source = await agent(cookie, { name: "Panel source", display_mode: "report" });
    const manager = await agent(cookie, { role: "manager", name: "Panel manager" });
    const created = value<{ id: string }>(await tool(manager.key.secret, "create_entry", {
      agent_id: source.agent.id, entry: { title: "Panel version", content: "Private panel body" },
    }));
    const listed = (await rpc(manager.key.secret, "tools/list")).result!.tools!.find((item) => item.name === "open_hub_panel")!;
    expect(listed.title).toBe("Personal Hub");
    expect(listed._meta?.ui).toEqual({ resourceUri: PANEL_RESOURCE_URI, visibility: ["model", "app"] });
    expect(listed._meta?.["openai/ui"]).toEqual({ entrypoints: [{ type: "global" }, { type: "thread" }] });
    const opened = (await tool(manager.key.secret, "open_hub_panel")).result!;
    const snapshot = opened._meta!.personalHub as PanelSnapshot;
    expect(snapshot.identity).toMatchObject({ role: "manager", can_manage_entries: true, can_manage_sources: true, can_write: true });
    expect(snapshot.sources.items.some((item) => item.id === source.agent.id)).toBe(true);
    expect(snapshot.entries.items.some((item) => item.id === created.id)).toBe(true);
    expect(snapshot.entry?.content).toBe("Private panel body");
    expect(JSON.stringify(opened.structuredContent)).not.toContain("Private panel body");
    expect(JSON.stringify(opened.content)).not.toContain("Private panel body");
    expect(JSON.stringify(opened)).not.toContain(manager.key.secret);
    expect((await rpc(manager.key.secret, "resources/list")).result!.resources).toContainEqual(expect.objectContaining({ uri: PANEL_RESOURCE_URI }));
    const resource = (await rpc(manager.key.secret, "resources/read", { uri: PANEL_RESOURCE_URI })).result!.contents![0]!;
    expect(resource.mimeType).toBe("text/html;profile=mcp-app");
    expect(resource.text).toContain("Personal Hub");
    expect(resource.text).not.toContain(manager.key.secret);
    expect(resource.text).not.toContain(secret);
    expect(resource.text?.split("<script>")[0]).not.toMatch(/<script[^>]+src=/);
    expect(resource.text).not.toContain('src="./main.tsx"');
    expect(resource._meta?.["openai/ui"]).toEqual({ availableDisplayModes: ["fullscreen"], preferredDisplayMode: "fullscreen" });
  });
  it("caches public documentation encoding by role without changing client response formats", async () => {
    const cookie = await login(); const manager = await agent(cookie, { role: "manager" });
    const reader = await agent(cookie, { role: "reader", read_access: { mode: "all" } });
    const first = await tool(manager.key.secret, "get_api_documentation");
    const second = await tool(manager.key.secret, "get_api_documentation");
    const readonly = await tool(reader.key.secret, "get_api_documentation");
    expect(first.result?.content).toEqual(second.result?.content);
    expect(JSON.parse(first.result!.content![0]!.text!)).toBe(value<string>(first));
    expect(value<string>(readonly)).not.toEqual(value<string>(first));
    expect(value<string>(readonly)).not.toContain("/api/v1/admin/agents");
    expect(JSON.stringify(first)).not.toContain(manager.key.secret);
  });
  it("keeps reader launch data source-scoped and supplies no write capabilities", async () => {
    const cookie = await login(); const source = await agent(cookie); const hidden = await agent(cookie);
    const reader = await agent(cookie, { role: "reader", read_access: { mode: "selected", agent_ids: [source.agent.id] } });
    await tool(source.key.secret, "create_entry", { entry: { title: "Readable panel record", content: "Allowed body" } });
    const privateEntry = value<{ id: string }>(await tool(hidden.key.secret, "create_entry", { entry: { title: "Hidden record", content: "Hidden body" } }));
    const snapshot = (await tool(reader.key.secret, "open_hub_panel")).result!._meta!.personalHub as PanelSnapshot;
    expect(snapshot.identity).toMatchObject({ role: "reader", can_write: false, can_manage_entries: false, can_manage_sources: false });
    expect(snapshot.sources.items.map((item) => item.id)).toEqual([source.agent.id]);
    expect(snapshot.entries.items.every((item) => item.agent_id === source.agent.id)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain(privateEntry.id);
    expect(snapshot.entry?.content).toBe("Allowed body");
    expect((await tool(reader.key.secret, "update_entry_state", { id: snapshot.entry!.id, state: { archived: true } })).result?.isError).toBe(true);
  });
  it("makes a manager's read-only OAuth connection read-only in the panel", async () => {
    const cookie = await login(); const manager = await agent(cookie, { role: "manager" });
    const tokens = await authorize(cookie, manager.agent.id, ["hub:read", "offline_access"]);
    const snapshot = (await tool(tokens.access_token, "open_hub_panel")).result!._meta!.personalHub as PanelSnapshot;
    expect(snapshot.identity).toMatchObject({ role: "manager", can_write: false, can_manage_entries: false, can_manage_sources: false });
    const names = (await rpc(tokens.access_token, "tools/list")).result!.tools!.map((item) => item.name);
    expect(names).toContain("open_hub_panel"); expect(names).not.toContain("update_entry_state");
  });
  it("rejects the app and its resources after key revocation", async () => {
    const cookie = await login(); const manager = await agent(cookie, { role: "manager" });
    expect((await tool(manager.key.secret, "open_hub_panel")).result?.isError).not.toBe(true);
    await request(`/api/v1/admin/agents/${manager.agent.id}/keys/${manager.key.id}`, { method: "DELETE", headers: { Cookie: cookie, Origin: origin } });
    const response = await request("/mcp", json("POST", { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: PANEL_RESOURCE_URI } }, {
      Authorization: `Bearer ${manager.key.secret}`, Accept: "application/json, text/event-stream",
    }));
    expect(response.status).toBe(401);
  });
});
async function registration(name = "MCP integration"): Promise<string> {
  const response = await request("/oauth/register", json("POST", {
    client_name: name, redirect_uris: ["https://client.example/callback"],
    token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
  }));
  expect(response.status).toBe(201);
  return (await response.json() as { client_id: string }).client_id;
}
const verifier = "test-verifier-abcdefghijklmnopqrstuvwxyz-1234567890";
async function authPage(cookie: string, scope = "hub:read hub:write offline_access", name?: string) {
  const clientId = await registration(name);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const query = new URLSearchParams({ client_id: clientId, redirect_uri: "https://client.example/callback", response_type: "code",
    scope, state: "test-state", code_challenge: challenge, code_challenge_method: "S256", resource: `${origin}/mcp` });
  const response = await request(`/oauth/authorize?${query}`, { headers: { Cookie: cookie } });
  expect(response.status).toBe(200);
  const content = await response.text();
  const handle = /name="handle" value="([^"]+)"/.exec(content)?.[1]; expect(handle).toBeTruthy();
  return { clientId, handle: handle!, cookie: `${cookie}; ${cookies(response)}`, content };
}
async function approve(page: Awaited<ReturnType<typeof authPage>>, identity: string, scope: string[], key?: string) {
  const form = new URLSearchParams({ handle: page.handle, identity, decision: "approve" });
  for (const item of scope) form.append("scope", item);
  if (key) form.set("agent_key", key);
  return request("/oauth/authorize", { method: "POST", body: form,
    headers: { Cookie: page.cookie, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" } });
}
async function exchange(clientId: string, code: string, codeVerifier = verifier) {
  return request("/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: codeVerifier,
      redirect_uri: "https://client.example/callback", resource: `${origin}/mcp` }) });
}
async function authorize(cookie: string, identity: string, scopes: string[], key?: string) {
  const page = await authPage(cookie, scopes.join(" "));
  const approved = await approve(page, identity, scopes, key); expect(approved.status).toBe(302);
  const location = new URL(approved.headers.get("Location")!);
  expect(location.searchParams.get("state")).toBe("test-state");
  const response = await exchange(page.clientId, location.searchParams.get("code")!); expect(response.status).toBe(200);
  const tokens = await response.json() as { access_token: string; refresh_token?: string };
  return { ...tokens, clientId: page.clientId };
}

describe("additive MCP transport and existing API compatibility", () => {
  it("applies SDK input defaults, trimming and coercion while rejecting refinements and unknown fields", async () => {
    const cookie = await login();
    const created = await agent(cookie);
    const token = created.key.secret;
    const entry = value<{ id: string }>(await tool(token, "create_entry", {
      entry: { title: "  Trimmed title  ", content: "Default flags" },
    }));
    const stored = value<{ title: string; important: boolean }>(await tool(token, "get_entry", { id: entry.id }));
    expect(stored.title).toBe("Trimmed title");
    expect(stored.important).toBe(false);
    await tool(token, "create_entry", { entry: { title: "Another", content: "Another body" } });
    const page = value<{ items: { id: string }[]; next_cursor: string | null }>(await tool(token, "list_entries", { limit: "1" }));
    expect(page.items).toHaveLength(1);
    expect(page.next_cursor).toBeTruthy();
    for (const invalidEntry of [
      { title: " ", content: "Invalid title" },
      { title: "Invalid URL", content: "Body", url: "ftp://example.com/file" },
      { title: "Too large", content: "a".repeat(256 * 1024 + 1) },
    ]) expect((await tool(token, "create_entry", { entry: invalidEntry })).result?.isError).toBe(true);
    expect((await tool(token, "get_entry", { id: entry.id, unexpected: true })).result?.isError).toBe(true);
    expect((await tool(token, "append_entry_version", {
      id: entry.id, entry: { title: "Invalid version", content: "Body", base_version: 0 },
    })).result?.isError).toBe(true);
    expect(value<{ items: unknown[] }>(await tool(token, "list_entries")).items).toHaveLength(2);
  });
  it("initializes with an existing key, lists tools, shares versions with API and rejects stale snapshots", async () => {
    const cookie = await login(); const created = await agent(cookie); const token = created.key.secret;
    const init = await rpc(token, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.error).toBeUndefined();
    const names = (await rpc(token, "tools/list")).result!.tools!.map((t) => t.name);
    expect(names).toContain("create_entry"); expect(names).not.toContain("create_agent");
    const result = await tool(token, "create_entry", { entry: { title: "From MCP", content: "Version one" } });
    expect(result.result?.isError).not.toBe(true); const entry = value<{ id: string }>(result);
    const api = await request(`/api/v1/agent/entries/${entry.id}`, { headers: { Authorization: `Bearer ${token}` } });
    expect((await api.json() as { content: string }).content).toBe("Version one");
    await tool(token, "append_entry_version", { id: entry.id, entry: { title: "Updated", content: "Version two", base_version: 1 } });
    const stale = await tool(token, "append_entry_version", { id: entry.id, entry: { title: "Stale", content: "bad", base_version: 1 } });
    expect(stale.result?.isError).toBe(true); expect(value<{ error: { code: string } }>(stale).error.code).toBe("conflict");
  });
  it("keeps reader tools read-only and source-scoped across entries and images", async () => {
    const cookie = await login(); const source = await agent(cookie); const other = await agent(cookie);
    const reader = await agent(cookie, { role: "reader", read_access: { mode: "selected", agent_ids: [source.agent.id] } });
    const entry = value<{ id: string }>(await tool(other.key.secret, "create_entry", { entry: { title: "Private", content: "hidden" } }));
    const names = (await rpc(reader.key.secret, "tools/list")).result!.tools!.map((t) => t.name);
    expect(names).toContain("get_image"); expect(names).not.toContain("create_entry"); expect(names).not.toContain("report_run");
    expect((await tool(reader.key.secret, "create_task", { title: "denied" })).result?.isError).toBe(true);
    const denied = await tool(reader.key.secret, "get_entry", { id: entry.id });
    expect(value<{ error: { code: string } }>(denied).error.code).toBe("not_found");
    const image = value<{ id: string }>(await tool(source.key.secret, "upload_image", { filename: "test.png", content_type: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" }));
    expect((await tool(reader.key.secret, "get_image", { id: image.id })).result?.content?.[0]?.type).toBe("image");
    const updated = await request(`/api/v1/admin/agents/${reader.agent.id}/read-access`, json("PUT", { base_revision: 0, mode: "selected", agent_ids: [] }, { Cookie: cookie, Origin: origin }));
    expect(updated.status).toBe(200);
    expect(value<{ error: { code: string } }>(await tool(reader.key.secret, "get_image", { id: image.id })).error.code).toBe("not_found");
  });
  it("rejects origins, missing credentials and oversize messages while preserving direct keys without OAuth storage", async () => {
    expect((await request("/mcp", { method: "POST" })).status).toBe(401);
    const cookie = await login(); const created = await agent(cookie);
    const badOrigin = await request("/mcp", json("POST", {}, { Authorization: `Bearer ${created.key.secret}`, Origin: "https://evil.example" }));
    expect(badOrigin.status).toBe(403);
    const withoutOAuthStorage = { ...env };
    Reflect.deleteProperty(withoutOAuthStorage, "OAUTH_KV");
    const direct = await worker.fetch(new Request(`${origin}/mcp`, json("POST", { jsonrpc: "2.0", id: 1, method: "tools/list" }, {
      Authorization: `Bearer ${created.key.secret}`, Accept: "application/json, text/event-stream" })), withoutOAuthStorage, createExecutionContext());
    expect(direct.status).toBe(200);
    const large = await request("/mcp", json("POST", {}, { Authorization: `Bearer ${created.key.secret}`, Accept: "application/json, text/event-stream", "Content-Length": String(16 * 1024 * 1024) }));
    expect(large.status).toBe(413);
  });
});

describe("OAuth authorization and live permission checks", () => {
  it("discovers endpoints, enforces PKCE, one-use consent and codes, and scopes tools", async () => {
    const metadata = await request("/.well-known/oauth-protected-resource/mcp"); expect(metadata.status).toBe(200);
    expect((await metadata.json() as { resource: string }).resource).toBe(`${origin}/mcp`);
    const discovery = await request("/.well-known/oauth-authorization-server"); expect(discovery.status).toBe(200);
    const cookie = await login(); const source = await agent(cookie); const page = await authPage(cookie);
    const approved = await approve(page, source.agent.id, ["hub:read", "offline_access"]); expect(approved.status).toBe(302);
    expect((await approve(page, source.agent.id, ["hub:read"])).status).toBe(400);
    const code = new URL(approved.headers.get("Location")!).searchParams.get("code")!;
    expect((await exchange(page.clientId, code, "wrong-abcdefghijklmnopqrstuvwxyz1234567890123456789")).status).toBe(400);
    const response = await exchange(page.clientId, code); expect(response.status).toBe(200);
    const tokens = await response.json() as { access_token: string };
    const names = (await rpc(tokens.access_token, "tools/list")).result!.tools!.map((t) => t.name);
    expect(names).toContain("get_entry"); expect(names).not.toContain("create_entry");
    expect((await exchange(page.clientId, code)).status).toBe(400);
  });
  it("requires browser binding and same origin, escapes client metadata, and prevents reader-to-admin escalation", async () => {
    const cookie = await login(); const source = await agent(cookie);
    const reader = await agent(cookie, { role: "reader", read_access: { mode: "all" } });
    const page = await authPage(cookie, "hub:read", "<script>alert('client')</script>");
    expect(page.content).not.toContain("<script>alert");
    expect(page.content).toContain("&#60;script&#62;");
    const stolen = { ...page, cookie };
    expect((await approve(stolen, source.agent.id, ["hub:read"])).status).toBe(400);
    const second = await authPage(cookie, "hub:admin");
    expect((await approve(second, reader.agent.id, ["hub:admin"])).status).toBe(403);
    const body = new URLSearchParams({ handle: second.handle, identity: "__admin", decision: "approve", scope: "hub:admin" });
    const forged = await request("/oauth/authorize", { method: "POST", body, headers: { Cookie: second.cookie, Origin: "https://evil.example", "Content-Type": "application/x-www-form-urlencoded" } });
    expect(forged.status).toBe(403);
  });
  it("authorizes using an existing Agent key and checks revocation on MCP requests and refresh", async () => {
    const cookie = await login(); const source = await agent(cookie);
    const tokens = await authorize("", "", ["hub:read", "hub:write", "offline_access"], source.key.secret);
    expect((await tool(tokens.access_token, "create_task", { title: "OAuth task" })).result?.isError).not.toBe(true);
    await request(`/api/v1/admin/agents/${source.agent.id}/keys/${source.key.id}`, { method: "DELETE", headers: { Cookie: cookie, Origin: origin } });
    const revoked = await request("/mcp", json("POST", { jsonrpc: "2.0", id: 1, method: "tools/list" }, {
      Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json, text/event-stream" })); expect(revoked.status).toBe(401);
    const refresh = await request("/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: tokens.clientId, refresh_token: tokens.refresh_token!, resource: `${origin}/mcp` }) });
    expect(refresh.status).toBe(400);
  });
  it("keeps OAuth separate from browser logout and invalidates it when the administrator secret changes", async () => {
    let cookie = await login(); const tokens = await authorize(cookie, "__admin", ["hub:admin", "offline_access"]);
    await request("/api/v1/auth/logout", { method: "POST", headers: { Cookie: cookie, Origin: origin } });
    const created = value<Created>(await tool(tokens.access_token, "create_agent", { name: "From OAuth" }));
    expect(created.key.secret).toMatch(/^phk\./);
    cookie = await login();
    const changed = await request("/api/v1/auth/change-secret", json("POST", { current_secret: secret, new_secret: "new-mcp-admin-secret-with-sufficient-entropy" }, { Cookie: cookie, Origin: origin }));
    expect(changed.status).toBe(204);
    const denied = await request("/mcp", json("POST", { jsonrpc: "2.0", id: 1, method: "tools/list" }, {
      Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json, text/event-stream" })); expect(denied.status).toBe(401);
    expect((await rpc(created.key.secret, "tools/list")).result?.tools).toBeDefined();
    const relogin = await request("/api/v1/auth/login", json("POST", { secret: "new-mcp-admin-secret-with-sufficient-entropy" }, { Origin: origin }));
    expect(relogin.status).toBe(200);
    const restore = await request("/api/v1/auth/change-secret", json("POST", { current_secret: "new-mcp-admin-secret-with-sufficient-entropy", new_secret: secret }, { Cookie: cookies(relogin), Origin: origin }));
    expect(restore.status).toBe(204);
  });
  it("revokes a client grant without affecting original key access", async () => {
    const cookie = await login(); const source = await agent(cookie);
    const tokens = await authorize(cookie, source.agent.id, ["hub:read"]);
    const page = await request(`/oauth/connections?user_id=agent_${source.agent.id}`, { headers: { Cookie: cookie } }); expect(page.status).toBe(200);
    const content = await page.text(); const grant = /name="grant_id" value="([^"]+)"/.exec(content)?.[1];
    const csrf = /name="csrf" value="([^"]+)"/.exec(content)?.[1]; expect(grant).toBeTruthy();
    const revoked = await request(`/oauth/connections?user_id=agent_${source.agent.id}`, { method: "POST", body: new URLSearchParams({ grant_id: grant!, csrf: csrf! }),
      headers: { Cookie: `${cookie}; ${cookies(page)}`, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" } }); expect(revoked.status).toBe(303);
    const denied = await request("/mcp", json("POST", { jsonrpc: "2.0", id: 1, method: "tools/list" }, {
      Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json, text/event-stream" })); expect(denied.status).toBe(401);
    expect((await rpc(source.key.secret, "tools/list")).result?.tools).toBeDefined();
  });
  it("refreshes tokens, rejects a different resource and applies delegated reader authorization changes", async () => {
    const cookie = await login(); const source = await agent(cookie);
    const reader = await agent(cookie, { role: "reader", read_access: { mode: "selected", agent_ids: [source.agent.id] } });
    const entry = value<{ id: string }>(await tool(source.key.secret, "create_entry", { entry: { title: "Granted", content: "allowed" } }));
    const tokens = await authorize(cookie, reader.agent.id, ["hub:read", "offline_access"]);
    expect(value<{ id: string }>(await tool(tokens.access_token, "get_entry", { id: entry.id })).id).toBe(entry.id);
    const refreshBody = { grant_type: "refresh_token", client_id: tokens.clientId, refresh_token: tokens.refresh_token! };
    const wrong = await request("/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...refreshBody, resource: "https://other.example/mcp" }) }); expect(wrong.status).toBe(400);
    const refreshed = await request("/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...refreshBody, resource: `${origin}/mcp` }) }); expect(refreshed.status).toBe(200);
    const replacement = await refreshed.json() as { access_token: string; refresh_token: string };
    expect(replacement.refresh_token).not.toBe(tokens.refresh_token);
    await request(`/api/v1/admin/agents/${reader.agent.id}/read-access`, json("PUT", { base_revision: 0, mode: "selected", agent_ids: [] }, { Cookie: cookie, Origin: origin }));
    expect(value<{ error: { code: string } }>(await tool(replacement.access_token, "get_entry", { id: entry.id })).error.code).toBe("not_found");
    await request(`/api/v1/admin/agents/${reader.agent.id}/disable`, { method: "POST", headers: { Cookie: cookie, Origin: origin } });
    const denied = await request("/mcp", json("POST", { jsonrpc: "2.0", id: 1, method: "tools/list" }, {
      Authorization: `Bearer ${replacement.access_token}`, Accept: "application/json, text/event-stream" })); expect(denied.status).toBe(401);
  });
  it("covers administrator management, keys, reader grants, entry states and deletion through MCP", async () => {
    const cookie = await login(); const tokens = await authorize(cookie, "__admin", ["hub:admin"]);
    const admin = tokens.access_token;
    const created = value<Created>(await tool(admin, "create_agent", { name: "Managed with MCP" }));
    const updated = value<AgentDto>(await tool(admin, "update_agent", { id: created.agent.id, agent: { display_mode: "report", name: "Updated" } }));
    expect(updated.display_mode).toBe("report");
    const reader = value<Created>(await tool(admin, "create_agent", { name: "MCP reader", role: "reader", read_access: { mode: "all" } }));
    const access = value<{ revision: number }>(await tool(admin, "get_read_access", { id: reader.agent.id }));
    expect((await tool(admin, "set_read_access", { id: reader.agent.id, access: { base_revision: access.revision, mode: "selected", agent_ids: [created.agent.id] } })).result?.isError).not.toBe(true);
    const key = value<IssuedKeyDto>(await tool(admin, "issue_agent_key", { id: created.agent.id, key: {} }));
    expect(key.secret).toMatch(/^phk\./);
    expect((await tool(admin, "list_agent_keys", { id: created.agent.id })).result?.isError).not.toBe(true);
    await tool(admin, "revoke_agent_key", { id: created.agent.id, key_id: key.id });
    const entry = value<{ id: string }>(await tool(admin, "create_entry", { agent_id: created.agent.id, entry: { title: "Admin entry", content: "full body" } }));
    const state = value<{ completed: boolean; archived: boolean }>(await tool(admin, "update_entry_state", { id: entry.id, state: { completed: true } }));
    expect(state.completed).toBe(true); expect(state.archived).toBe(false);
    const task = value<{ id: string }>(await tool(admin, "create_task", { agent_id: created.agent.id, entry_id: entry.id, title: "Linked" }));
    await tool(admin, "delete_entry", { id: entry.id });
    expect((await tool(admin, "delete_task", { id: task.id })).result?.isError).not.toBe(true);
    for (const action of ["disable", "enable", "remove", "restore"]) {
      expect((await tool(admin, "set_agent_status", { id: created.agent.id, action })).result?.isError).not.toBe(true);
    }
    expect(value<{ status: string }>(await tool(admin, "purge_agent", { id: created.agent.id })).status).toBe("done");
  });
  it("gives existing manager keys all management tools while preserving their actor identity", async () => {
    const cookie = await login(); const source = await agent(cookie); const manager = await agent(cookie, { role: "manager" });
    const names = (await rpc(manager.key.secret, "tools/list")).result!.tools!.map((t) => t.name);
    for (const name of ["append_entry_version", "delete_task", "issue_agent_key", "create_agent", "purge_agent",
      "update_entry_state", "mark_entries_read", "delete_entry", "set_read_access", "list_passkeys",
      "change_admin_secret", "list_oauth_grants", "revoke_oauth_grant"]) expect(names).toContain(name);
    expect(value<{ role: string; agent_id: string; scopes: string[] }>(await tool(manager.key.secret, "get_identity")))
      .toMatchObject({ role: "manager", agent_id: manager.agent.id, scopes: ["hub:read", "hub:write", "hub:admin"] });
    const entry = value<{ id: string }>(await tool(manager.key.secret, "create_entry", { agent_id: source.agent.id, entry: { title: "Managed", content: "content" } }));
    expect(value<{ id: string }>(await tool(source.key.secret, "get_entry", { id: entry.id })).id).toBe(entry.id);
    const task = value<{ id: string }>(await tool(manager.key.secret, "create_task", { agent_id: source.agent.id, title: "Task" }));
    expect((await tool(manager.key.secret, "update_task", { id: task.id, task: { done: true } })).result?.isError).not.toBe(true);
    expect((await tool(manager.key.secret, "report_run", { result: "success", note: "MCP checked" })).result?.isError).not.toBe(true);
    expect(value<{ items: { id: string }[] }>(await tool(manager.key.secret, "list_agents", { scope: "all" })).items)
      .toContainEqual(expect.objectContaining({ id: manager.agent.id }));
    const current = value<{ created_by_agent_id: string }>(await tool(manager.key.secret, "get_entry", { id: entry.id }));
    expect(current.created_by_agent_id).toBe(manager.agent.id);
    expect(value<{ archived: boolean }>(await tool(manager.key.secret, "update_entry_state", { id: entry.id, state: { archived: true } })).archived).toBe(true);
    expect(value<{ updated: number }>(await tool(manager.key.secret, "mark_entries_read", { agent_id: source.agent.id })).updated).toBe(1);
    const created = value<Created>(await tool(manager.key.secret, "create_agent", { name: "Manager created" }));
    const issued = value<IssuedKeyDto>(await tool(manager.key.secret, "issue_agent_key", { id: created.agent.id, key: {} }));
    expect((await tool(manager.key.secret, "revoke_agent_key", { id: created.agent.id, key_id: issued.id })).result?.isError).not.toBe(true);
    const reader = value<Created>(await tool(manager.key.secret, "create_agent", { name: "Manager reader", role: "reader", read_access: { mode: "all" } }));
    expect((await tool(manager.key.secret, "set_read_access", { id: reader.agent.id, access: { base_revision: 0, mode: "selected", agent_ids: [source.agent.id] } })).result?.isError).not.toBe(true);
    expect((await tool(manager.key.secret, "delete_task", { id: task.id })).result?.isError).not.toBe(true);
    expect((await tool(manager.key.secret, "delete_entry", { id: entry.id })).result?.isError).not.toBe(true);
    const image = await tool(manager.key.secret, "upload_image", { agent_id: created.agent.id, filename: "manager.png", content_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" });
    expect(image.result?.isError).not.toBe(true);
    expect(value<{ status: string }>(await tool(manager.key.secret, "purge_agent", { id: created.agent.id })).status).toBe("done");
    expect((await tool(manager.key.secret, "list_passkeys")).result?.isError).not.toBe(true);
    expect((await tool(manager.key.secret, "list_oauth_grants")).result?.isError).not.toBe(true);
    expect((await tool(manager.key.secret, "set_agent_status", { id: manager.agent.id, action: "disable" })).result?.isError).not.toBe(true);
    const denied = await request("/mcp", json("POST", { jsonrpc: "2.0", id: 1, method: "tools/list" }, {
      Authorization: `Bearer ${manager.key.secret}`, Accept: "application/json, text/event-stream" }));
    expect(denied.status).toBe(401);
  });
  it("requires explicit manager OAuth admin consent and invalidates it when the manager key is revoked", async () => {
    const cookie = await login(); const manager = await agent(cookie, { role: "manager" });
    const limited = await authorize(cookie, manager.agent.id, ["hub:read", "hub:write", "offline_access"]);
    const limitedNames = (await rpc(limited.access_token, "tools/list")).result!.tools!.map((t) => t.name);
    expect(limitedNames).toContain("create_entry"); expect(limitedNames).not.toContain("create_agent");
    expect((await tool(limited.access_token, "create_agent", { name: "Denied without consent" })).result?.isError).toBe(true);
    const full = await authorize("", "", ["hub:admin", "offline_access"], manager.key.secret);
    const created = value<Created>(await tool(full.access_token, "create_agent", { name: "OAuth manager created" }));
    expect(created.agent.id).toBeTruthy();
    const grants = value<{ items: { id: string }[] }>(await tool(full.access_token, "list_oauth_grants", { user_id: `agent_${manager.agent.id}` }));
    expect(grants.items).toHaveLength(2);
    // Revoke the limited grant through the full manager connection.
    const fullGrants = value<{ items: { id: string; scope: string[] }[] }>(await tool(full.access_token, "list_oauth_grants", { user_id: `agent_${manager.agent.id}` }));
    const limitedGrant = fullGrants.items.find((grant) => !grant.scope.includes("hub:admin"))!;
    expect((await tool(full.access_token, "revoke_oauth_grant", { user_id: `agent_${manager.agent.id}`, grant_id: limitedGrant.id })).result?.isError).not.toBe(true);
    expect((await tool(full.access_token, "revoke_agent_key", { id: manager.agent.id, key_id: manager.key.id })).result?.isError).not.toBe(true);
    const denied = await request("/mcp", json("POST", { jsonrpc: "2.0", id: 1, method: "tools/list" }, {
      Authorization: `Bearer ${full.access_token}`, Accept: "application/json, text/event-stream" }));
    expect(denied.status).toBe(401);
    const refresh = await request("/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: full.clientId, refresh_token: full.refresh_token!, resource: `${origin}/mcp` }) });
    expect(refresh.status).toBe(400);
  });
  it("does not resurrect delegated OAuth access after removing and restoring an Agent", async () => {
    const cookie = await login(); const source = await agent(cookie);
    const tokens = await authorize(cookie, source.agent.id, ["hub:read"]);
    for (const action of ["remove", "restore"]) {
      const response = await request(`/api/v1/admin/agents/${source.agent.id}/${action}`, { method: "POST", headers: { Cookie: cookie, Origin: origin } });
      expect(response.status).toBe(200);
    }
    const denied = await request("/mcp", json("POST", { jsonrpc: "2.0", id: 1, method: "tools/list" }, {
      Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json, text/event-stream" })); expect(denied.status).toBe(401);
  });
  it("shares passkey management with the webpage and can rotate the administrator secret through MCP", async () => {
    const cookie = await login(); const tokens = await authorize(cookie, "__admin", ["hub:admin"]);
    const id = `passkey-${crypto.randomUUID()}`;
    await env.DB.prepare(`INSERT INTO admin_passkeys (id, credential_id, public_key, user_handle, counter, credential_revision, name, created_at)
      SELECT ?, ?, 'test-public-key', 'test-user', 0, revision, 'MCP metadata test', ? FROM admin_credentials WHERE id = 1`)
      .bind(id, `credential-${id}`, new Date().toISOString()).run();
    const list = value<{ items: { id: string }[] }>(await tool(tokens.access_token, "list_passkeys"));
    expect(list.items.some((p) => p.id === id)).toBe(true);
    expect((await tool(tokens.access_token, "revoke_passkey", { id })).result?.isError).not.toBe(true);
    const api = await request("/api/v1/auth/passkeys", { headers: { Cookie: cookie } });
    expect((await api.json() as { items: { id: string }[] }).items.some((p) => p.id === id)).toBe(false);
    const nextSecret = "mcp-rotated-admin-secret-with-sufficient-entropy";
    const changed = await tool(tokens.access_token, "change_admin_secret", { current_secret: secret, new_secret: nextSecret });
    expect(value<{ reauthorization_required: boolean }>(changed).reauthorization_required).toBe(true);
    const relogin = await request("/api/v1/auth/login", json("POST", { secret: nextSecret }, { Origin: origin }));
    expect(relogin.status).toBe(200);
    const restore = await request("/api/v1/auth/change-secret", json("POST", { current_secret: nextSecret, new_secret: secret }, { Cookie: cookies(relogin), Origin: origin }));
    expect(restore.status).toBe(204);
  });
});
