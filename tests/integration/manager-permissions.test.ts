import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../../src/server/app";
import type { AgentDto, EntryFullDto, IssuedKeyDto } from "../../src/shared/contracts";
import type { QuickStartDocument } from "../../src/server/discovery/content";

const origin = "http://localhost:5173";
type Created = { agent: AgentDto; key: IssuedKeyDto };
function call(path: string, token: string, method = "GET", body?: unknown, extra: HeadersInit = {}) {
  const headers = new Headers(extra);
  headers.set("Authorization", `Bearer ${token}`);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return app.request(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, env);
}
async function setup() {
  const loggedIn = await app.request(origin + "/api/v1/auth/login", {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "CF-Connecting-IP": crypto.randomUUID() },
    body: JSON.stringify({ secret: "test-admin-secret-with-sufficient-entropy" }),
  }, env);
  expect(loggedIn.status).toBe(200);
  const cookie = loggedIn.headers.get("Set-Cookie")!.split(";")[0]!;
  const response = await app.request(origin + "/api/v1/admin/agents", {
    method: "POST", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Full access manager", role: "manager" }),
  }, env);
  expect(response.status).toBe(201);
  return { manager: await response.json<Created>(), cookie };
}
async function create(token: string, input: Record<string, unknown> = {}) {
  const response = await call("/api/v1/admin/agents", token, "POST", { name: "Manager source", ...input });
  expect(response.status).toBe(201);
  return response.json<Created>();
}
beforeEach(async () => {
  await env.DB.prepare("UPDATE agents SET status = 'disabled' WHERE scope = 'all' AND access_mode = 'read_write' AND status = 'active'").run();
});

describe("full manager API permissions", () => {
  it("uses existing Bearer keys for all management routes without converting them to browser sessions", async () => {
    const { manager } = await setup(); const token = manager.key.secret;
    const source = await create(token);
    const createdEntry = await call(`/api/v1/admin/agents/${source.agent.id}/entries`, token, "POST", { title: "Managed", content: "Original" });
    expect(createdEntry.status).toBe(201);
    const entry = await createdEntry.json<{ id: string }>();
    const detail = await call(`/api/v1/admin/entries/${entry.id}`, token);
    expect((await detail.json<EntryFullDto>()).created_by_agent_id).toBe(manager.agent.id);
    expect((await call(`/api/v1/admin/entries/${entry.id}/versions`, token, "POST", { base_version: 1, title: "Updated", content: "Full snapshot" })).status).toBe(201);
    expect((await call("/api/v1/admin/entries/read", token, "POST", { agent_id: source.agent.id })).status).toBe(200);
    expect((await call(`/api/v1/admin/entries/${entry.id}/state`, token, "PATCH", { archived: true, completed: true })).status).toBe(200);
    expect((await call("/api/v1/admin/entries/counts", token)).status).toBe(200);
    const task = await call("/api/v1/admin/tasks", token, "POST", { agent_id: source.agent.id, entry_id: entry.id, title: "Managed task" });
    expect(task.status).toBe(201);
    const taskId = (await task.json<{ id: string }>()).id;
    expect((await call(`/api/v1/manager/tasks/${taskId}`, token, "DELETE")).status).toBe(204);
    expect((await call(`/api/v1/admin/entries/${entry.id}`, token, "DELETE")).status).toBe(204);
    const issued = await call(`/api/v1/admin/agents/${source.agent.id}/keys`, token, "POST", {});
    expect(issued.status).toBe(201);
    const key = await issued.json<IssuedKeyDto>();
    expect((await call(`/api/v1/admin/agents/${source.agent.id}/keys`, token)).status).toBe(200);
    expect((await call(`/api/v1/admin/agents/${source.agent.id}/keys/${key.id}`, token, "DELETE")).status).toBe(204);
    expect((await call("/api/v1/agent", key.secret)).status).toBe(401);
    const reader = await create(token, { role: "reader", read_access: { mode: "all" } });
    expect((await call(`/api/v1/admin/agents/${reader.agent.id}/read-access`, token, "PUT", { base_revision: 0, mode: "selected", agent_ids: [source.agent.id] })).status).toBe(200);
    expect((await call(`/api/v1/admin/agents/${reader.agent.id}/read-access`, token)).status).toBe(200);
    expect((await call(`/api/v1/admin/agents/${source.agent.id}`, token, "PATCH", { name: "Renamed source" })).status).toBe(200);
    for (const action of ["disable", "enable", "remove", "restore"]) {
      expect((await call(`/api/v1/admin/agents/${source.agent.id}/${action}`, token, "POST")).status).toBe(200);
    }
    expect((await call(`/api/v1/admin/agents/${source.agent.id}`, token, "DELETE")).status).toBe(200);
    expect((await call("/api/v1/auth/passkeys", token)).status).toBe(200);
    expect((await call("/api/v1/auth/session", token)).status).toBe(403);
    expect((await call("/api/v1/auth/logout", token, "POST")).status).toBe(403);
    const discovery = await (await call("/api", token)).json<QuickStartDocument>();
    expect(discovery.credential_role).toBe("manager");
    expect(discovery.available_routes).toContainEqual(expect.objectContaining({ path: "/api/v1/admin/agents/{id}/keys" }));
    expect(discovery.available_routes.some((route) => route.path === "/api/v1/auth/session")).toBe(false);
  });

  it("rejects other roles, foreign Origins, disabled managers and revoked manager keys", async () => {
    const { manager } = await setup(); const token = manager.key.secret;
    const source = await create(token);
    const reader = await create(token, { role: "reader", read_access: { mode: "all" } });
    for (const denied of [source.key.secret, reader.key.secret]) {
      expect((await call("/api/v1/admin/agents", denied)).status).toBe(403);
      expect((await call(`/api/v1/admin/agents/${source.agent.id}/keys`, denied, "POST", {})).status).toBe(403);
      expect((await call("/api/v1/auth/passkeys", denied)).status).toBe(403);
    }
    expect((await call("/api/v1/admin/agents", token, "POST", { name: "Foreign origin" }, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await call(`/api/v1/admin/agents/${manager.agent.id}/disable`, token, "POST")).status).toBe(200);
    expect((await call("/api/v1/admin/agents", token)).status).toBe(403);
    await env.DB.prepare("UPDATE agents SET status = 'active' WHERE id = ?").bind(manager.agent.id).run();
    expect((await call(`/api/v1/admin/agents/${manager.agent.id}/keys/${manager.key.id}`, token, "DELETE")).status).toBe(204);
    expect((await call("/api/v1/admin/agents", token)).status).toBe(401);
  });
});
