import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type {
  AgentDto,
  ApiErrorBody,
  AttachmentDto,
  EntryFullDto,
  EntryStateDto,
  EntryVersionBriefDto,
  IssuedKeyDto,
  Page,
  SessionDto,
  TaskDto,
} from "../../src/shared/contracts";
import type { QuickStartDocument } from "../../src/server/discovery/content";

const APP_ORIGIN = "http://localhost:5173";
const ADMIN_SECRET = "test-admin-secret-with-sufficient-entropy";

type CreatedAgent = {
  agent: AgentDto;
  key: IssuedKeyDto;
};

type EntryMutation = {
  id: string;
  version: number;
};

type MainWorkerExport = {
  default: Fetcher;
};

function hasMainWorker(value: object): value is MainWorkerExport {
  return "default" in value;
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (typeof init.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const request = new Request(`${APP_ORIGIN}${path}`, { ...init, headers });
  if (!hasMainWorker(exports)) throw new Error("Worker default export is unavailable");
  return Promise.resolve(exports.default.fetch(request));
}

function jsonBody(method: string, body: unknown, headers?: HeadersInit): RequestInit {
  return {
    method,
    headers,
    body: JSON.stringify(body),
  };
}

async function readJson<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

function cookiePair(response: Response): string {
  const setCookie = response.headers.get("Set-Cookie");
  expect(setCookie).toBeTruthy();
  const pair = setCookie!.split(";", 1)[0];
  if (!pair) throw new Error("Session cookie is empty");
  return pair;
}

async function loginAdmin(label: string): Promise<string> {
  const response = await api("/api/v1/auth/login", jsonBody("POST", {
    secret: ADMIN_SECRET,
  }, {
    Origin: APP_ORIGIN,
    "CF-Connecting-IP": `integration-${label}`,
  }));
  expect(response.status).toBe(200);
  return cookiePair(response);
}

async function createAgent(
  cookie: string,
  name: string,
  options: { scope?: "own" | "all"; key_expires_at?: string } = {},
): Promise<CreatedAgent> {
  const response = await api("/api/v1/admin/agents", jsonBody("POST", {
    name,
    ...options,
  }, {
    Cookie: cookie,
    Origin: APP_ORIGIN,
  }));
  expect(response.status).toBe(201);
  return readJson<CreatedAgent>(response);
}

async function createEntry(token: string, title: string): Promise<EntryMutation> {
  const response = await api("/api/v1/agent/entries", jsonBody("POST", {
    title,
    content: `# ${title}\n\nInitial body`,
    important: true,
  }, {
    Authorization: `Bearer ${token}`,
  }));
  expect(response.status).toBe(201);
  return readJson<EntryMutation>(response);
}

function imageForm(filename: string): FormData {
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  ]);
  const form = new FormData();
  form.set("file", new File([png], filename, { type: "image/png" }));
  return form;
}

async function uploadAttachment(token: string, filename: string): Promise<AttachmentDto> {
  const form = imageForm(filename);
  const response = await api("/api/v1/agent/attachments", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  expect(response.status).toBe(201);
  return readJson<AttachmentDto>(response);
}

describe("Personal Hub Worker API", () => {
  it("hides archived-source tasks from every admin filter and counts, restoring them on unarchive", async () => {
    const cookie = await loginAdmin("archived-tasks");
    const owner = await createAgent(cookie, "archived-task-owner");
    const entry = await createEntry(owner.key.secret, "archive task source");
    const headers = { Cookie: cookie, Origin: APP_ORIGIN };
    const bearer = { Authorization: `Bearer ${owner.key.secret}` };
    const makeTask = async (title: string, entry_id?: string) => readJson<TaskDto>(await api("/api/v1/agent/tasks", jsonBody("POST", { title, entry_id }, bearer)));
    const linked = await makeTask("linked open", entry.id);
    const completed = await makeTask("linked done", entry.id);
    const standalone = await makeTask("standalone");
    await api(`/api/v1/agent/tasks/${completed.id}`, jsonBody("PATCH", { done: true }, bearer));
    const before = await readJson<{ open_tasks: number }>(await api("/api/v1/admin/entries/counts", { headers }));
    await api(`/api/v1/admin/entries/${entry.id}/state`, jsonBody("PATCH", { archived: true }, headers));
    for (const done of ["all", "no", "yes"]) {
      const response = await api(`/api/v1/admin/tasks?agent_id=${owner.agent.id}&done=${done}&limit=1`, { headers });
      expect(response.status).toBe(200);
      const page = await readJson<Page<TaskDto>>(response);
      expect(page.items.map((task) => task.id)).toEqual(done === "yes" ? [] : [standalone.id]);
      expect(page.next_cursor).toBeNull();
    }
    const after = await readJson<{ open_tasks: number }>(await api("/api/v1/admin/entries/counts", { headers }));
    expect(after.open_tasks).toBe(before.open_tasks - 1);
    const agentTasks = await readJson<Page<TaskDto>>(await api("/api/v1/agent/tasks?done=all", { headers: bearer }));
    expect(agentTasks.items.map((task) => task.id).sort()).toEqual([linked.id, completed.id, standalone.id].sort());
    await api(`/api/v1/admin/entries/${entry.id}/state`, jsonBody("PATCH", { archived: false }, headers));
    const restored = await readJson<Page<TaskDto>>(await api(`/api/v1/admin/tasks?agent_id=${owner.agent.id}&done=no`, { headers }));
    expect(restored.items.map((task) => task.id).sort()).toEqual([linked.id, standalone.id].sort());
    expect((await readJson<{ open_tasks: number }>(await api("/api/v1/admin/entries/counts", { headers }))).open_tasks).toBe(before.open_tasks);
  });

  it("filters archive time server-side with exclusive end, owner scope and bound cursors", async () => {
    const cookie = await loginAdmin("archive-window");
    const own = await createAgent(cookie, "archive-window-owner");
    const other = await createAgent(cookie, "archive-window-other");
    const items = await Promise.all([createEntry(own.key.secret, "old"), createEntry(own.key.secret, "inside-a"), createEntry(own.key.secret, "inside-b"), createEntry(own.key.secret, "end"), createEntry(other.key.secret, "outside-owner")]);
    const timestamps = ["2026-09-08T23:59:59.000Z", "2026-09-09T00:00:00.000Z", "2026-09-10T00:00:00.000Z", "2026-09-19T00:00:00.000Z", "2026-09-10T00:00:00.000Z"];
    await env.DB.batch(items.map((item, i) => env.DB.prepare("UPDATE entries SET archived = 1, archived_at = ? WHERE id = ?").bind(timestamps[i], item.id)));
    const headers = { Authorization: `Bearer ${own.key.secret}` };
    const range = "archived=yes&view=brief&time_field=archived&start=2026-09-09T08%3A00%3A00%2B08%3A00&end=2026-09-19T00%3A00%3A00Z&limit=1";
    const first = await readJson<Page<EntryFullDto>>(await api(`/api/v1/agent/entries?${range}`, { headers }));
    expect(first.items).toHaveLength(1);
    expect(first.next_cursor).toBeTruthy();
    const next = await readJson<Page<EntryFullDto>>(await api(`/api/v1/agent/entries?${range}&cursor=${encodeURIComponent(first.next_cursor!)}`, { headers }));
    expect(new Set([...first.items, ...next.items].map((item) => item.id))).toEqual(new Set([items[1]!.id, items[2]!.id]));
    expect(next.next_cursor).toBeNull();
    expect((await api(`/api/v1/agent/entries?${range.replace("time_field=archived", "time_field=created")}&cursor=${encodeURIComponent(first.next_cursor!)}`, { headers })).status).toBe(400);
    expect((await api("/api/v1/agent/entries?start=2026-10-01T00:00:00Z&end=2026-09-01T00:00:00Z", { headers })).status).toBe(400);
    expect((await api(`/api/v1/agent/entries?agent_id=${other.agent.id}&${range}`, { headers })).status).toBe(403);
    const active = await readJson<Page<EntryFullDto>>(await api(`/api/v1/agent/entries?archived=no`, { headers }));
    expect(active.items).toHaveLength(0);
  });

  it("marks every matching page read atomically and preserves other scopes and newer versions", async () => {
    const cookie = await loginAdmin("bulk-read");
    const own = await createAgent(cookie, "bulk-read-owner");
    const other = await createAgent(cookie, "bulk-read-other");
    const seed = await createEntry(own.key.secret, "bulk-needle");
    const unrelated = await createEntry(other.key.secret, "bulk-needle");
    const archive = await createEntry(own.key.secret, "bulk-needle-archive");
    await env.DB.prepare("UPDATE entries SET archived = 1 WHERE id = ?").bind(archive.id).run();
    for (let offset = 0; offset < 135; offset += 45) {
      const statements = [];
      for (let i = offset; i < offset + 45; i++) {
        const id = `${seed.id}-extra-${i}`;
        statements.push(env.DB.prepare("INSERT INTO entries (id, agent_id, created_at) VALUES (?, ?, ?)").bind(id, own.agent.id, "2026-09-10T00:00:00.000Z"));
        statements.push(env.DB.prepare("INSERT INTO entry_versions (entry_id, version, created_by_agent_id, title, content, created_at) VALUES (?, 1, ?, 'bulk-needle', 'body', ?)").bind(id, own.agent.id, "2026-09-10T00:00:00.000Z"));
      }
      await env.DB.batch(statements);
    }
    const headers = { Cookie: cookie, Origin: APP_ORIGIN };
    const body = { agent_id: own.agent.id, archived: "no", query: "bulk-needle" };
    expect((await api("/api/v1/admin/entries/read", jsonBody("POST", body, { Cookie: cookie }))).status).toBe(403);
    expect((await api("/api/v1/admin/entries/read", jsonBody("POST", body, { Authorization: `Bearer ${own.key.secret}` }))).status).toBe(403);
    expect((await api("/api/v1/admin/entries/read", jsonBody("POST", { ...body, cursor: "page" }, headers))).status).toBe(400);
    expect(await readJson(await api("/api/v1/admin/entries/read", jsonBody("POST", body, headers)))).toEqual({ updated: 136 });
    expect(await readJson(await api("/api/v1/admin/entries/read", jsonBody("POST", body, headers)))).toEqual({ updated: 0 });
    for (const id of [archive.id, unrelated.id]) {
      const item = await readJson<EntryFullDto>(await api(`/api/v1/admin/entries/${id}`, { headers }));
      expect(item.read_version).toBe(0);
    }
    const seenByAgent = await readJson<EntryFullDto>(await api(`/api/v1/agent/entries/${seed.id}`, { headers: { Authorization: `Bearer ${own.key.secret}` } }));
    expect(seenByAgent.read_version).toBe(1);
    const appended = await api(`/api/v1/agent/entries/${seed.id}/versions`, jsonBody("POST", { base_version: 1, title: "bulk-needle", content: "new", important: true }, { Authorization: `Bearer ${own.key.secret}` }));
    expect(appended.status).toBe(201);
    const unread = await readJson<Page<EntryFullDto>>(await api(`/api/v1/admin/entries?agent_id=${own.agent.id}&archived=no&read=updated`, { headers }));
    expect(unread.items.map((item) => item.id)).toEqual([seed.id]);
    expect(unread.items[0]!.read_version).toBe(1);
    const counts = await readJson<{ unread: number; important_unread: number; archived: number }>(await api("/api/v1/admin/entries/counts", { headers }));
    const expected = await env.DB.prepare("SELECT COUNT(*) AS n FROM entries e JOIN entry_versions v ON v.entry_id = e.id AND v.version = (SELECT MAX(version) FROM entry_versions WHERE entry_id=e.id) WHERE e.archived=0 AND e.read_version<v.version").first<{ n: number }>();
    expect(counts.unread).toBe(expected!.n);
  });

  it("records archive transitions without replacing an existing archive time", async () => {
    const cookie = await loginAdmin("archive-state");
    const own = await createAgent(cookie, "archive-state-owner");
    const entry = await createEntry(own.key.secret, "archive-state");
    const headers = { Cookie: cookie, Origin: APP_ORIGIN };
    const route = `/api/v1/admin/entries/${entry.id}/state`;
    const archived = await readJson<EntryStateDto>(await api(route, jsonBody("PATCH", { archived: true }, headers)));
    expect(archived.archived_at).toBeTruthy();
    const again = await readJson<EntryStateDto>(await api(route, jsonBody("PATCH", { archived: true, read_version: 1 }, headers)));
    expect(again.archived_at).toBe(archived.archived_at);
    const restored = await readJson<EntryStateDto>(await api(route, jsonBody("PATCH", { archived: false }, headers)));
    expect(restored.archived_at).toBeNull();
    expect(restored.read_version).toBe(1);
  });

  it("keeps discovery authenticated, role-scoped, and outside SPA fallback", async () => {
    const anonymous = await api("/api");
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("Content-Type")).toContain("application/json");

    const anonymousDocs = await api("/api/docs");
    expect(anonymousDocs.status).toBe(401);
    expect(anonymousDocs.headers.get("Content-Type")).toContain("application/json");

    const cookie = await loginAdmin("discovery");
    const adminResponse = await api("/api", { headers: { Cookie: cookie } });
    expect(adminResponse.status).toBe(200);
    expect(adminResponse.headers.get("Cache-Control")).toBe("private, no-store");
    const admin = await readJson<QuickStartDocument>(adminResponse);
    expect(admin.credential_role).toBe("admin");
    expect(admin.available_routes.some((route) => route.path.startsWith("/api/v1/admin/"))).toBe(true);
    expect(admin.available_routes.some((route) => route.path.startsWith("/api/v1/manager/"))).toBe(false);

    const adminDocsResponse = await api("/api/docs", { headers: { Cookie: cookie } });
    expect(adminDocsResponse.status).toBe(200);
    const adminDocs = await adminDocsResponse.text();
    expect(adminDocs).toContain("当前凭据角色：管理员");
    expect(adminDocs).toContain("/api/v1/admin/agents/{id}/keys");

    const created = await createAgent(cookie, "Discovery agent");
    const agentResponse = await api("/api", {
      headers: { Authorization: `Bearer ${created.key.secret}` },
    });
    expect(agentResponse.status).toBe(200);
    const agent = await readJson<QuickStartDocument>(agentResponse);
    expect(agent.credential_role).toBe("agent");
    expect(agent.available_routes.some((route) => route.path.startsWith("/api/v1/agent/"))).toBe(true);
    expect(agent.available_routes.some((route) => route.path.startsWith("/api/v1/admin/"))).toBe(false);
    expect(agent.available_routes.some((route) => route.path.startsWith("/api/v1/manager/"))).toBe(false);

    const docsResponse = await api("/api/docs", {
      headers: { Authorization: `Bearer ${created.key.secret}` },
    });
    expect(docsResponse.status).toBe(200);
    expect(docsResponse.headers.get("Content-Type")).toContain("text/plain");
    const docs = await docsResponse.text();
    expect(docs).toContain("当前凭据角色：普通 Agent");
    expect(docs).not.toContain("/api/v1/manager/entries");

    const ordinaryOnAdminRoute = await api("/api/v1/admin/agents", {
      headers: { Authorization: `Bearer ${created.key.secret}` },
    });
    expect(ordinaryOnAdminRoute.status).toBe(403);

    const manager = await createAgent(cookie, "Discovery manager", {
      scope: "all",
      key_expires_at: "2099-01-01T00:00:00.000Z",
    });
    const managerDocsResponse = await api("/api/docs", {
      headers: { Authorization: `Bearer ${manager.key.secret}` },
    });
    expect(managerDocsResponse.status).toBe(200);
    const managerDocs = await managerDocsResponse.text();
    expect(managerDocs).toContain("当前凭据角色：总管 Agent");
    expect(managerDocs).toContain("/api/v1/manager/entries");
    expect(managerDocs).not.toContain("/api/v1/admin/agents/{id}/keys");

    const disableManager = await api(
      `/api/v1/admin/agents/${manager.agent.id}/disable`,
      { method: "POST", headers: { Cookie: cookie, Origin: APP_ORIGIN } },
    );
    expect(disableManager.status).toBe(200);

    const adminOnAgentRoute = await api("/api/v1/agent/entries", {
      headers: { Cookie: cookie },
    });
    expect(adminOnAgentRoute.status).toBe(403);

    const adminOnManagerRoute = await api("/api/v1/manager/entries", {
      headers: { Cookie: cookie },
    });
    expect(adminOnManagerRoute.status).toBe(403);

    const missing = await api("/api/v1/not-a-real-route", {
      headers: { Authorization: `Bearer ${created.key.secret}` },
    });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Content-Type")).toContain("application/json");
    expect((await readJson<ApiErrorBody>(missing)).error.code).toBe("not_found");
  });

  it("denies unauthenticated API calls and enforces origin, secret, and session rules", async () => {
    const denied = await api("/api/v1/agent/entries");
    expect(denied.status).toBe(401);
    expect((await readJson<ApiErrorBody>(denied)).error.code).toBe("unauthenticated");

    const missingOrigin = await api("/api/v1/auth/login", jsonBody("POST", {
      secret: ADMIN_SECRET,
    }));
    expect(missingOrigin.status).toBe(403);

    const wrongOrigin = await api("/api/v1/auth/login", jsonBody("POST", {
      secret: ADMIN_SECRET,
    }, {
      Origin: "https://attacker.example",
      "CF-Connecting-IP": "integration-origin",
    }));
    expect(wrongOrigin.status).toBe(403);

    const wrongSecret = await api("/api/v1/auth/login", jsonBody("POST", {
      secret: "definitely-wrong",
    }, {
      Origin: APP_ORIGIN,
      "CF-Connecting-IP": "integration-secret",
    }));
    expect(wrongSecret.status).toBe(401);

    const login = await api("/api/v1/auth/login", jsonBody("POST", {
      secret: ADMIN_SECRET,
    }, {
      Origin: APP_ORIGIN,
      "CF-Connecting-IP": "integration-session",
    }));
    expect(login.status).toBe(200);
    expect(await readJson<SessionDto>(login)).toMatchObject({ authenticated: true });
    const setCookie = login.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toMatch(/^__Host-ph_session=phs\./);
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    const cookie = cookiePair(login);

    const session = await api("/api/v1/auth/session", {
      headers: { Cookie: cookie },
    });
    expect(session.status).toBe(200);
    expect(await readJson<SessionDto>(session)).toMatchObject({ authenticated: true });

    const ambiguous = await api("/api/v1/auth/session", {
      headers: {
        Cookie: cookie,
        Authorization: "Bearer malformed-token",
      },
    });
    expect(ambiguous.status).toBe(401);
    expect((await readJson<ApiErrorBody>(ambiguous)).error.message).toContain("不能同时携带");

    const logout = await api("/api/v1/auth/logout", {
      method: "POST",
      headers: { Cookie: cookie, Origin: APP_ORIGIN },
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.get("Set-Cookie")).toContain("Max-Age=0");

    const revokedSession = await api("/api/v1/auth/session", {
      headers: { Cookie: cookie },
    });
    expect(revokedSession.status).toBe(401);
  });

  it("returns an Agent key once, limits live keys, and enforces key roles and validity", async () => {
    const cookie = await loginAdmin("keys");
    const created = await createAgent(cookie, "Key lifecycle agent");

    expect(created.key.agent_id).toBe(created.agent.id);
    expect(created.key.secret).toMatch(/^phk\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const metadataResponse = await api(`/api/v1/admin/agents/${created.agent.id}/keys`, {
      headers: { Cookie: cookie },
    });
    expect(metadataResponse.status).toBe(200);
    const metadata = await readJson<{ items: Array<Record<string, unknown>> }>(metadataResponse);
    expect(metadata.items).toHaveLength(1);
    expect(metadata.items[0]).not.toHaveProperty("secret");
    expect(JSON.stringify(metadata)).not.toContain(created.key.secret);

    const stored = await env.DB.prepare(
      "SELECT secret_hash FROM agent_keys WHERE id = ?",
    ).bind(created.key.id).first<{ secret_hash: string }>();
    expect(stored?.secret_hash).toBeTruthy();
    expect(stored?.secret_hash).not.toBe(created.key.secret);

    const secondResponse = await api(
      `/api/v1/admin/agents/${created.agent.id}/keys`,
      jsonBody("POST", {}, { Cookie: cookie, Origin: APP_ORIGIN }),
    );
    expect(secondResponse.status).toBe(201);
    const second = await readJson<IssuedKeyDto>(secondResponse);

    const tooMany = await api(
      `/api/v1/admin/agents/${created.agent.id}/keys`,
      jsonBody("POST", {}, { Cookie: cookie, Origin: APP_ORIGIN }),
    );
    expect(tooMany.status).toBe(409);

    const ambiguous = await api("/api/v1/agent", {
      headers: {
        Cookie: cookie,
        Authorization: `Bearer ${second.secret}`,
      },
    });
    expect(ambiguous.status).toBe(401);

    const ordinaryOnManagerRoute = await api("/api/v1/manager/entries", {
      headers: { Authorization: `Bearer ${created.key.secret}` },
    });
    expect(ordinaryOnManagerRoute.status).toBe(403);

    const manager = await createAgent(cookie, "Permanent manager", { scope: "all" });
    expect(manager.key.expires_at).toBeNull();
    const managerSecondKey = await api(`/api/v1/admin/agents/${manager.agent.id}/keys`,
      jsonBody("POST", { expires_at: null }, { Cookie: cookie, Origin: APP_ORIGIN }));
    expect(managerSecondKey.status).toBe(201);
    const issuedManagerKey = await readJson<IssuedKeyDto>(managerSecondKey);
    expect(issuedManagerKey.expires_at).toBeNull();
    expect((await api("/api/v1/manager/entries", {
      headers: { Authorization: `Bearer ${issuedManagerKey.secret}` },
    })).status).toBe(200);
    const managerOnOrdinaryRoute = await api("/api/v1/agent/entries", {
      headers: { Authorization: `Bearer ${manager.key.secret}` },
    });
    expect(managerOnOrdinaryRoute.status).toBe(403);

    const revoke = await api(
      `/api/v1/admin/agents/${created.agent.id}/keys/${created.key.id}`,
      { method: "DELETE", headers: { Cookie: cookie, Origin: APP_ORIGIN } },
    );
    expect(revoke.status).toBe(204);
    const revokedKey = await api("/api/v1/agent", {
      headers: { Authorization: `Bearer ${created.key.secret}` },
    });
    expect(revokedKey.status).toBe(401);

    await env.DB.prepare(
      "UPDATE agent_keys SET expires_at = ? WHERE id = ?",
    ).bind("2000-01-01T00:00:00.000Z", second.id).run();
    const expiredKey = await api("/api/v1/agent", {
      headers: { Authorization: `Bearer ${second.secret}` },
    });
    expect(expiredKey.status).toBe(401);
  });

  it("keeps ordinary Agents isolated from each other's entries", async () => {
    const cookie = await loginAdmin("entry-isolation");
    const first = await createAgent(cookie, "First isolated agent");
    const second = await createAgent(cookie, "Second isolated agent");
    const firstEntry = await createEntry(first.key.secret, "First private entry");
    const secondEntry = await createEntry(second.key.secret, "Second private entry");

    const hiddenDetail = await api(`/api/v1/agent/entries/${firstEntry.id}`, {
      headers: { Authorization: `Bearer ${second.key.secret}` },
    });
    expect(hiddenDetail.status).toBe(404);

    const hiddenAppend = await api(
      `/api/v1/agent/entries/${firstEntry.id}/versions`,
      jsonBody("POST", {
        title: "Cross-owner append",
        content: "must not be accepted",
        base_version: 1,
      }, { Authorization: `Bearer ${second.key.secret}` }),
    );
    expect(hiddenAppend.status).toBe(404);

    const listResponse = await api("/api/v1/agent/entries", {
      headers: { Authorization: `Bearer ${second.key.secret}` },
    });
    expect(listResponse.status).toBe(200);
    const list = await readJson<Page<EntryFullDto>>(listResponse);
    expect(list.items.map((entry) => entry.id)).toEqual([secondEntry.id]);

    const explicitOtherOwner = await api(
      `/api/v1/agent/entries?agent_id=${encodeURIComponent(first.agent.id)}`,
      { headers: { Authorization: `Bearer ${second.key.secret}` } },
    );
    expect(explicitOtherOwner.status).toBe(403);
  });

  it("creates entry version one, preserves completion in the default list, and rejects stale appends", async () => {
    const cookie = await loginAdmin("entry-lifecycle");
    const created = await createAgent(cookie, "Entry lifecycle agent");
    const entry = await createEntry(created.key.secret, "Versioned report");
    expect(entry.version).toBe(1);

    const firstVersion = await api(`/api/v1/agent/entries/${entry.id}`, {
      headers: { Authorization: `Bearer ${created.key.secret}` },
    });
    expect(firstVersion.status).toBe(200);
    expect(await readJson<EntryFullDto>(firstVersion)).toMatchObject({
      id: entry.id,
      agent_id: created.agent.id,
      version: 1,
      title: "Versioned report",
      content: "# Versioned report\n\nInitial body",
      completed: false,
    });

    const complete = await api(
      `/api/v1/admin/entries/${entry.id}/state`,
      jsonBody("PATCH", { completed: true }, { Cookie: cookie, Origin: APP_ORIGIN }),
    );
    expect(complete.status).toBe(200);
    const state = await readJson<EntryStateDto>(complete);
    expect(state.completed).toBe(true);
    expect(state.completed_at).toBeTruthy();

    const append = (suffix: string) => api(
      `/api/v1/agent/entries/${entry.id}/versions`,
      jsonBody("POST", {
        title: `Version two ${suffix}`,
        content: `Full replacement ${suffix}`,
        base_version: 1,
      }, { Authorization: `Bearer ${created.key.secret}` }),
    );
    const concurrent = await Promise.all([append("A"), append("B")]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([201, 409]);
    const conflictResponse = concurrent.find((response) => response.status === 409)!;
    const conflictBody = await readJson<ApiErrorBody>(conflictResponse);
    expect(conflictBody.error.code).toBe("conflict");
    expect(conflictBody.error.details).toEqual({ current_version: 2 });

    const defaultListResponse = await api("/api/v1/agent/entries", {
      headers: { Authorization: `Bearer ${created.key.secret}` },
    });
    expect(defaultListResponse.status).toBe(200);
    const defaultList = await readJson<Page<EntryFullDto>>(defaultListResponse);
    expect(defaultList.items).toHaveLength(1);
    const listed = defaultList.items[0];
    expect(listed).toBeDefined();
    expect(listed).toMatchObject({
      id: entry.id,
      version: 2,
      completed: true,
    });
    expect(listed!.completed_at).toBe(state.completed_at);
    expect(listed).toHaveProperty("content");

    const versionsResponse = await api(`/api/v1/agent/entries/${entry.id}/versions`, {
      headers: { Authorization: `Bearer ${created.key.secret}` },
    });
    expect(versionsResponse.status).toBe(200);
    const versions = await readJson<Page<EntryVersionBriefDto>>(versionsResponse);
    expect(versions.items.map((version) => version.version)).toEqual([2, 1]);
  });

  it("freezes entry processing state while its owner Agent is deleting", async () => {
    const cookie = await loginAdmin("entry-deleting-state");
    const owner = await createAgent(cookie, "Deleting entry owner");
    const entry = await createEntry(owner.key.secret, "Frozen processing state");

    await env.DB.prepare(`
      UPDATE agents
      SET status = 'deleting', deleting_at = ?
      WHERE id = ?
    `).bind(new Date().toISOString(), owner.agent.id).run();

    const patch = await api(
      `/api/v1/admin/entries/${entry.id}/state`,
      jsonBody("PATCH", {
        archived: true,
        read_version: 1,
        completed: true,
      }, { Cookie: cookie, Origin: APP_ORIGIN }),
    );
    expect(patch.status).toBe(409);
    const error = await readJson<ApiErrorBody>(patch);
    expect(error.error.code).toBe("conflict");
    expect(error.error.message).toContain("正在删除");

    const stored = await env.DB.prepare(`
      SELECT archived, read_version, completed, completed_at
      FROM entries
      WHERE id = ?
    `).bind(entry.id).first<{
      archived: number;
      read_version: number;
      completed: number;
      completed_at: string | null;
    }>();
    expect(stored).toEqual({
      archived: 0,
      read_version: 0,
      completed: 0,
      completed_at: null,
    });
  });

  it("accepts only existing attachments owned by the entry Agent in every Markdown reference form", async () => {
    const cookie = await loginAdmin("entry-attachments");
    const owner = await createAgent(cookie, "Attachment owner");
    const outsider = await createAgent(cookie, "Attachment outsider");
    const ownedImage = await uploadAttachment(owner.key.secret, "owned.png");
    const outsideImage = await uploadAttachment(outsider.key.secret, "outside.png");

    const ownCreate = await api("/api/v1/agent/entries", jsonBody("POST", {
      title: "Report with owned image",
      content: `![owned image](${ownedImage.url})`,
    }, { Authorization: `Bearer ${owner.key.secret}` }));
    expect(ownCreate.status).toBe(201);
    const entry = await readJson<EntryMutation>(ownCreate);

    const otherOwnerShortcut = await api("/api/v1/agent/entries", jsonBody("POST", {
      title: "Cross-owner image",
      content: `![shot]\n\n[shot]: ${outsideImage.url}`,
    }, { Authorization: `Bearer ${owner.key.secret}` }));
    expect(otherOwnerShortcut.status).toBe(400);
    expect((await readJson<ApiErrorBody>(otherOwnerShortcut)).error.message).toContain("不属于目标 Agent");

    const missingShortcut = await api(
      `/api/v1/agent/entries/${entry.id}/versions`,
      jsonBody("POST", {
        title: "Missing image",
        content: "![missing]\n\n[missing]: /api/v1/media/missing-attachment",
        base_version: 1,
      }, { Authorization: `Bearer ${owner.key.secret}` }),
    );
    expect(missingShortcut.status).toBe(400);
    expect((await readJson<ApiErrorBody>(missingShortcut)).error.message).toContain("不存在");

    const validReferenceAppend = await api(
      `/api/v1/agent/entries/${entry.id}/versions`,
      jsonBody("POST", {
        title: "Owned reference image",
        content: `![figure][owned]\n\n[owned]: ${ownedImage.url}`,
        base_version: 1,
      }, { Authorization: `Bearer ${owner.key.secret}` }),
    );
    expect(validReferenceAppend.status).toBe(201);
    expect(await readJson<EntryMutation>(validReferenceAppend)).toEqual({
      id: entry.id,
      version: 2,
    });
  });

  it("lets the manager manage manual content without making the manager an owner", async () => {
    const cookie = await loginAdmin("manager-manual");
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE agent_keys
        SET revoked_at = COALESCE(revoked_at, ?)
        WHERE agent_id IN (SELECT id FROM agents WHERE scope = 'all' AND status = 'active')
      `).bind(new Date().toISOString()),
      env.DB.prepare("UPDATE agents SET status = 'disabled' WHERE scope = 'all' AND status = 'active'"),
    ]);
    const manager = await createAgent(cookie, "Manual partition manager", {
      scope: "all",
      key_expires_at: "2099-01-01T00:00:00.000Z",
    });
    const authorization = { Authorization: `Bearer ${manager.key.secret}` };

    const create = await api(
      "/api/v1/manager/agents/manual/entries",
      jsonBody("POST", {
        title: "Manager-created manual entry",
        content: "Initial manual content",
      }, authorization),
    );
    expect(create.status).toBe(201);
    const entry = await readJson<EntryMutation>(create);
    expect(entry.version).toBe(1);

    const append = await api(
      `/api/v1/manager/entries/${entry.id}/versions`,
      jsonBody("POST", {
        title: "Updated manual entry",
        content: "Full replacement by the manager",
        base_version: 1,
      }, authorization),
    );
    expect(append.status).toBe(201);
    expect(await readJson<EntryMutation>(append)).toEqual({ id: entry.id, version: 2 });

    const manualEntry = await api(`/api/v1/manager/entries/${entry.id}`, {
      headers: authorization,
    });
    expect(manualEntry.status).toBe(200);
    expect(await readJson<EntryFullDto>(manualEntry)).toMatchObject({
      id: entry.id,
      agent_id: "manual",
      version: 2,
      created_by_agent_id: manager.agent.id,
    });

    const taskResponse = await api("/api/v1/manager/tasks", jsonBody("POST", {
      title: "Follow up manual entry",
      entry_id: entry.id,
    }, authorization));
    expect(taskResponse.status).toBe(201);
    const task = await readJson<TaskDto>(taskResponse);
    expect(task).toMatchObject({
      agent_id: "manual",
      entry_id: entry.id,
      done: false,
    });

    const manualTasks = await api("/api/v1/manager/tasks?agent_id=manual", {
      headers: authorization,
    });
    expect(manualTasks.status).toBe(200);
    expect((await readJson<Page<TaskDto>>(manualTasks)).items.map((item) => item.id)).toEqual([task.id]);

    const selfOwnedEntry = await api(
      `/api/v1/manager/agents/${manager.agent.id}/entries`,
      jsonBody("POST", {
        title: "Invalid manager-owned entry",
        content: "A manager is an actor, not a content partition.",
      }, authorization),
    );
    expect(selfOwnedEntry.status).toBe(403);

    const selfOwnedTask = await api("/api/v1/manager/tasks", jsonBody("POST", {
      title: "Invalid manager-owned task",
      agent_id: manager.agent.id,
    }, authorization));
    expect(selfOwnedTask.status).toBe(403);

    const manualImage = await api("/api/v1/manager/agents/manual/attachments", {
      method: "POST",
      headers: authorization,
      body: imageForm("manual.png"),
    });
    expect(manualImage.status).toBe(201);
    expect(await readJson<AttachmentDto>(manualImage)).toMatchObject({ agent_id: "manual" });

    const selfOwnedImage = await api(
      `/api/v1/manager/agents/${manager.agent.id}/attachments`,
      {
        method: "POST",
        headers: authorization,
        body: imageForm("invalid-manager-owner.png"),
      },
    );
    expect(selfOwnedImage.status).toBe(403);
  });

  it("runs the ordinary-Agent task lifecycle and hides tasks and entries across owners", async () => {
    const cookie = await loginAdmin("tasks");
    const owner = await createAgent(cookie, "Task owner");
    const outsider = await createAgent(cookie, "Task outsider");
    const entry = await createEntry(owner.key.secret, "Task source entry");

    const create = await api("/api/v1/agent/tasks", jsonBody("POST", {
      title: "Review the report",
      entry_id: entry.id,
      due_at: "2099-03-04T05:06:07.000Z",
    }, { Authorization: `Bearer ${owner.key.secret}` }));
    expect(create.status).toBe(201);
    const task = await readJson<TaskDto>(create);
    expect(task).toMatchObject({
      agent_id: owner.agent.id,
      entry_id: entry.id,
      title: "Review the report",
      done: false,
    });

    const crossOwnerCreate = await api("/api/v1/agent/tasks", jsonBody("POST", {
      title: "Cannot attach another Agent's entry",
      entry_id: entry.id,
    }, { Authorization: `Bearer ${outsider.key.secret}` }));
    expect(crossOwnerCreate.status).toBe(404);

    const crossOwnerPatch = await api(
      `/api/v1/agent/tasks/${task.id}`,
      jsonBody("PATCH", { done: true }, { Authorization: `Bearer ${outsider.key.secret}` }),
    );
    expect(crossOwnerPatch.status).toBe(404);

    const initialList = await api("/api/v1/agent/tasks?done=no", {
      headers: { Authorization: `Bearer ${owner.key.secret}` },
    });
    expect(initialList.status).toBe(200);
    expect((await readJson<Page<TaskDto>>(initialList)).items.map((item) => item.id)).toEqual([task.id]);

    const update = await api(
      `/api/v1/agent/tasks/${task.id}`,
      jsonBody("PATCH", {
        title: "Reviewed report",
        done: true,
        due_at: null,
      }, { Authorization: `Bearer ${owner.key.secret}` }),
    );
    expect(update.status).toBe(200);
    expect(await readJson<TaskDto>(update)).toMatchObject({
      id: task.id,
      title: "Reviewed report",
      done: true,
      due_at: null,
    });

    const doneList = await api("/api/v1/agent/tasks?done=yes", {
      headers: { Authorization: `Bearer ${owner.key.secret}` },
    });
    expect(doneList.status).toBe(200);
    expect((await readJson<Page<TaskDto>>(doneList)).items.map((item) => item.id)).toEqual([task.id]);

    const remove = await api(`/api/v1/agent/tasks/${task.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${owner.key.secret}` },
    });
    expect(remove.status).toBe(204);

    const emptyList = await api("/api/v1/agent/tasks", {
      headers: { Authorization: `Bearer ${owner.key.secret}` },
    });
    expect(emptyList.status).toBe(200);
    expect((await readJson<Page<TaskDto>>(emptyList)).items).toEqual([]);
  });

  it("deletes an entry with multiple versions, clears its report pointer, and preserves linked tasks", async () => {
    const cookie = await loginAdmin("entry-delete");
    const owner = await createAgent(cookie, "Entry deletion owner");
    const entry = await createEntry(owner.key.secret, "Entry to delete");
    const bearer = { Authorization: `Bearer ${owner.key.secret}` };
    const admin = { Cookie: cookie, Origin: APP_ORIGIN };
    const append = await api(`/api/v1/agent/entries/${entry.id}/versions`, jsonBody("POST", {
      base_version: 1, title: "Updated entry", content: "Second version",
    }, bearer));
    expect(append.status).toBe(201);
    const report = await api(`/api/v1/admin/agents/${owner.agent.id}`, jsonBody("PATCH", {
      display_mode: "report", main_entry_id: entry.id,
    }, admin));
    expect(report.status).toBe(200);
    const taskResponse = await api("/api/v1/agent/tasks", jsonBody("POST", {
      title: "Keep this task", entry_id: entry.id,
    }, bearer));
    expect(taskResponse.status).toBe(201);
    const task = await readJson<TaskDto>(taskResponse);

    const remove = await api(`/api/v1/admin/entries/${entry.id}`, { method: "DELETE", headers: admin });
    expect(remove.status).toBe(204);
    expect((await api(`/api/v1/agent/entries/${entry.id}`, { headers: bearer })).status).toBe(404);
    const versions = await env.DB.prepare("SELECT COUNT(*) AS count FROM entry_versions WHERE entry_id = ?")
      .bind(entry.id).first<{ count: number }>();
    expect(versions?.count).toBe(0);
    const agentResponse = await api("/api/v1/agent", { headers: bearer });
    expect((await readJson<AgentDto>(agentResponse)).main_entry_id).toBeNull();
    const tasksResponse = await api("/api/v1/agent/tasks", { headers: bearer });
    expect((await readJson<Page<TaskDto>>(tasksResponse)).items).toContainEqual(
      expect.objectContaining({ id: task.id, entry_id: null, title: "Keep this task" }),
    );
    expect((await api(`/api/v1/admin/entries/${entry.id}`, { method: "DELETE", headers: admin })).status).toBe(404);
  });

  it("blocks administrator task updates and deletes once the owner starts deleting", async () => {
    const cookie = await loginAdmin("task-owner-deleting");
    const owner = await createAgent(cookie, "Deleting task owner");

    const create = await api("/api/v1/admin/tasks", jsonBody("POST", {
      title: "Preserve during purge",
      agent_id: owner.agent.id,
    }, {
      Cookie: cookie,
      Origin: APP_ORIGIN,
    }));
    expect(create.status).toBe(201);
    const task = await readJson<TaskDto>(create);

    await env.DB.prepare(`
      UPDATE agents
      SET status = 'deleting', deleting_at = ?
      WHERE id = ?
    `).bind(new Date().toISOString(), owner.agent.id).run();

    const update = await api(
      `/api/v1/admin/tasks/${task.id}`,
      jsonBody("PATCH", { title: "Must not change" }, {
        Cookie: cookie,
        Origin: APP_ORIGIN,
      }),
    );
    expect(update.status).toBe(409);

    const remove = await api(`/api/v1/admin/tasks/${task.id}`, {
      method: "DELETE",
      headers: {
        Cookie: cookie,
        Origin: APP_ORIGIN,
      },
    });
    expect(remove.status).toBe(404);

    const stored = await env.DB.prepare(
      "SELECT title FROM tasks WHERE id = ?",
    ).bind(task.id).first<{ title: string }>();
    expect(stored).toEqual({ title: "Preserve during purge" });
  });
});
