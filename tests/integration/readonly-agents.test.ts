import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentDto,
  ApiErrorBody,
  AttachmentDto,
  EntryFullDto,
  Page,
  ReadAccessDto,
  ReaderSelfDto,
  ReaderSourceDto,
  TaskDto,
} from "../../src/shared/contracts";
import { normalizeError } from "../../src/server/shared/errors";
import { enforceReaderRateLimit } from "../../src/server/shared/reader-rate-limit";
import { createEntry, listEntries } from "../../src/server/modules/entries/service";
import { listTasks } from "../../src/server/modules/tasks/service";
import { getAttachmentMedia } from "../../src/server/modules/attachments/service";
import type { ServiceContext } from "../../src/server/env";

const APP_ORIGIN = "http://localhost:5173";
const ADMIN_SECRET = "test-admin-secret-with-sufficient-entropy";

type Created = { agent: AgentDto; key: { secret: string } };

type MainWorkerExport = { default: Fetcher };

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
  return { method, headers, body: JSON.stringify(body) };
}

function readJson<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

async function loginAdmin(label: string): Promise<string> {
  const response = await api("/api/v1/auth/login", jsonBody("POST", { secret: ADMIN_SECRET }, {
    Origin: APP_ORIGIN,
    "CF-Connecting-IP": `readonly-${label}`,
  }));
  expect(response.status).toBe(200);
  return response.headers.get("Set-Cookie")!.split(";", 1)[0]!;
}

async function createOrdinaryAgent(cookie: string, name: string): Promise<Created> {
  const response = await api("/api/v1/admin/agents", jsonBody("POST", { name }, {
    Cookie: cookie,
    Origin: APP_ORIGIN,
  }));
  expect(response.status).toBe(201);
  return readJson<Created>(response);
}

async function createReader(
  cookie: string,
  name: string,
  readAccess: { mode: "selected" | "all"; agent_ids?: string[] },
): Promise<Created> {
  const response = await api("/api/v1/admin/agents", jsonBody("POST", {
    name,
    role: "reader",
    read_access: readAccess,
  }, {
    Cookie: cookie,
    Origin: APP_ORIGIN,
  }));
  expect(response.status).toBe(201);
  return readJson<Created>(response);
}

function bearer(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

async function readerGet<T>(token: string, path: string): Promise<T> {
  const response = await api(path, { headers: bearer(token) });
  expect(response.status).toBe(200);
  return readJson<T>(response);
}

async function errorBody(response: Response): Promise<ApiErrorBody["error"]> {
  return (await readJson<ApiErrorBody>(response)).error;
}

/** request_id 每次不同，比较错误语义时要去掉它。 */
function errorSemantics(error: ApiErrorBody["error"]): Record<string, unknown> {
  return { code: error.code, message: error.message, details: error.details };
}

/** 腾出“只有一个启用总管”的唯一名额；只动可读写的跨分区身份，不动只读身份。 */
async function freeManagerSlot(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE agent_keys SET revoked_at = COALESCE(revoked_at, ?)
      WHERE agent_id IN (
        SELECT id FROM agents
        WHERE scope = 'all' AND access_mode = 'read_write' AND status = 'active'
      )
    `).bind(new Date().toISOString()),
    env.DB.prepare(`
      UPDATE agents SET status = 'disabled'
      WHERE scope = 'all' AND access_mode = 'read_write' AND status = 'active'
    `),
  ]);
}

async function seedEntry(token: string, title: string): Promise<string> {
  const response = await api("/api/v1/agent/entries", jsonBody("POST", {
    title,
    content: `# ${title}\n\nBody`,
  }, bearer(token)));
  expect(response.status).toBe(201);
  return (await readJson<{ id: string }>(response)).id;
}

async function seedTask(token: string, title: string): Promise<string> {
  const response = await api("/api/v1/agent/tasks", jsonBody("POST", { title }, bearer(token)));
  expect(response.status).toBe(201);
  return (await readJson<TaskDto>(response)).id;
}

async function seedAttachment(token: string, filename: string): Promise<AttachmentDto> {
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  ]);
  const form = new FormData();
  form.set("file", new File([png], filename, { type: "image/png" }));
  const response = await api("/api/v1/agent/attachments", { method: "POST", body: form, headers: bearer(token) });
  expect(response.status).toBe(201);
  return readJson<AttachmentDto>(response);
}

function readerServiceContext(
  agentId: string,
  readMode: "selected" | "all",
  permissionsRevision = 0,
): ServiceContext {
  return {
    env: env as unknown as CloudflareBindings,
    requestId: "readonly-service-test",
    actor: {
      type: "agent",
      agentId,
      keyId: "readonly-service-key",
      status: "active",
      role: "reader",
      readMode,
      permissionsRevision,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("read-only agents: authorization model", () => {
  it("creates selected and all readers, lists them without consuming the manager slot", async () => {
    const cookie = await loginAdmin("create");
    const a = await createOrdinaryAgent(cookie, "Reader source A");
    const b = await createOrdinaryAgent(cookie, "Reader source B");

    const selected = await createReader(cookie, "Selected reader", { mode: "selected", agent_ids: [a.agent.id] });
    const all = await createReader(cookie, "All reader", { mode: "all" });

    expect(selected.agent.role).toBe("reader");
    expect(selected.agent.read_mode).toBe("selected");
    expect(selected.agent.read_source_count).toBe(1);
    expect(all.agent.role).toBe("reader");
    expect(all.agent.read_mode).toBe("all");
    expect(all.agent.read_source_count).toBe(0);

    // 多个只读身份可以并存，而且不会挤占“只有一个启用总管”的唯一索引。
    const manager = await api("/api/v1/admin/agents", jsonBody("POST", {
      name: "Manager after readers",
      scope: "all",
    }, { Cookie: cookie, Origin: APP_ORIGIN }));
    expect(manager.status).toBe(201);

    const listed = await readJson<Page<AgentDto>>(await api("/api/v1/admin/agents?status=all", { headers: { Cookie: cookie } }));
    const readerIds = listed.items.filter((item) => item.role === "reader").map((item) => item.id);
    expect(readerIds).toContain(selected.agent.id);
    expect(readerIds).toContain(all.agent.id);

    // 指定范围的授权只包含 A。
    const access = await readerGet<Page<ReaderSourceDto>>(selected.key.secret, "/api/v1/reader/agents");
    expect(access.items.map((item) => item.id)).toEqual([a.agent.id]);
    expect(access.items[0]!.name).toBe("Reader source A");
    void b;
  });

  it("rejects invalid creation inputs and non-grantable targets", async () => {
    const cookie = await loginAdmin("invalid-create");
    const source = await createOrdinaryAgent(cookie, "Invalid source");
    await freeManagerSlot();
    const managerResponse = await api("/api/v1/admin/agents", jsonBody("POST", { name: "Existing manager", scope: "all" }, {
      Cookie: cookie, Origin: APP_ORIGIN,
    }));
    expect(managerResponse.status).toBe(201);
    const manager = await readJson<Created>(managerResponse);

    const cases: Array<{ body: unknown; status: number }> = [
      // role 与 scope 不能同时提交
      { body: { name: "bad", role: "reader", scope: "all", read_access: { mode: "all" } }, status: 400 },
      // 只读身份必须提供 read_access
      { body: { name: "bad", role: "reader" }, status: 400 },
      // 新建时 selected 至少选一个来源
      { body: { name: "bad", role: "reader", read_access: { mode: "selected", agent_ids: [] } }, status: 400 },
      // all 与非空 agent_ids 互斥
      { body: { name: "bad", role: "reader", read_access: { mode: "all", agent_ids: [source.agent.id] } }, status: 400 },
      // 非只读角色不能提交 read_access
      { body: { name: "bad", scope: "own", read_access: { mode: "all" } }, status: 400 },
      // 不能授权总管
      { body: { name: "bad", role: "reader", read_access: { mode: "selected", agent_ids: [manager.agent.id] } }, status: 400 },
      // 不存在的目标
      { body: { name: "bad", role: "reader", read_access: { mode: "selected", agent_ids: ["agent-does-not-exist"] } }, status: 400 },
    ];
    for (const item of cases) {
      const response = await api("/api/v1/admin/agents", jsonBody("POST", item.body, { Cookie: cookie, Origin: APP_ORIGIN }));
      expect(response.status).toBe(item.status);
    }

    // 不能授权另一个只读身份
    const reader = await createReader(cookie, "Peer reader", { mode: "selected", agent_ids: [source.agent.id] });
    const peerResponse = await api("/api/v1/admin/agents", jsonBody("POST", {
      name: "bad", role: "reader", read_access: { mode: "selected", agent_ids: [reader.agent.id] },
    }, { Cookie: cookie, Origin: APP_ORIGIN }));
    expect(peerResponse.status).toBe(400);
  });

  it("refuses an invalid database role combination instead of downgrading it", async () => {
    const cookie = await loginAdmin("decode");
    const source = await createOrdinaryAgent(cookie, "Decode source");
    const reader = await createReader(cookie, "Decode reader", { mode: "selected", agent_ids: [source.agent.id] });

    // read_only 但缺少 read_mode 表示权限配置缺失，必须拒绝认证而不是默认全部可读。
    await env.DB.prepare("UPDATE agents SET read_mode = NULL WHERE id = ?").bind(reader.agent.id).run();
    expect((await api("/api/v1/reader", { headers: bearer(reader.key.secret) })).status).toBe(401);

    // 恢复后可以读取，证明失败原因就是那个组合。
    await env.DB.prepare("UPDATE agents SET read_mode = 'selected' WHERE id = ?").bind(reader.agent.id).run();
    expect((await api("/api/v1/reader", { headers: bearer(reader.key.secret) })).status).toBe(200);
  });
});

describe("read-only agents: resource scope", () => {
  it("only exposes granted sources across sources, entries and tasks", async () => {
    const cookie = await loginAdmin("scope");
    const a = await createOrdinaryAgent(cookie, "Scope A");
    const c = await createOrdinaryAgent(cookie, "Scope C");
    const b = await createOrdinaryAgent(cookie, "Scope B");
    await seedEntry(a.key.secret, "A entry");
    await seedEntry(c.key.secret, "C entry");
    const bEntry = await seedEntry(b.key.secret, "B entry");
    await seedTask(a.key.secret, "A task");
    await seedTask(b.key.secret, "B task");

    const reader = await createReader(cookie, "Scoped reader", { mode: "selected", agent_ids: [a.agent.id, c.agent.id] });
    const token = reader.key.secret;

    const sources = await readerGet<Page<ReaderSourceDto>>(token, "/api/v1/reader/agents");
    expect(sources.items.map((item) => item.id).sort()).toEqual([a.agent.id, c.agent.id].sort());

    const entries = await readerGet<Page<EntryFullDto>>(token, "/api/v1/reader/entries?view=full&limit=50");
    expect(entries.items.map((item) => item.agent_id).sort()).toEqual([a.agent.id, c.agent.id].sort());

    const tasks = await readerGet<Page<TaskDto>>(token, "/api/v1/reader/tasks");
    expect(tasks.items.map((item) => item.title)).toEqual(["A task"]);

    // 猜测 B 的条目 ID 与显式 agent_id 都拿不到任何内容。
    expect((await api(`/api/v1/reader/entries/${bEntry}`, { headers: bearer(token) })).status).toBe(404);
    expect((await api(`/api/v1/reader/entries/${bEntry}/versions`, { headers: bearer(token) })).status).toBe(404);
    expect((await api(`/api/v1/reader/entries?agent_id=${b.agent.id}`, { headers: bearer(token) })).status).toBe(404);
    expect((await api(`/api/v1/reader/tasks?agent_id=${b.agent.id}`, { headers: bearer(token) })).status).toBe(404);

    // 未授权与不存在返回完全相同的错误语义（只有 request_id 不同）。
    const unauthorized = await errorBody(await api(`/api/v1/reader/entries/${bEntry}`, { headers: bearer(token) }));
    const missing = await errorBody(await api("/api/v1/reader/entries/entry-does-not-exist", { headers: bearer(token) }));
    expect(errorSemantics(unauthorized)).toEqual(errorSemantics(missing));
    expect(JSON.stringify(unauthorized)).not.toContain("B entry");
  });

  it("rejects every write surface and keeps reader out of other namespaces", async () => {
    const cookie = await loginAdmin("write");
    const source = await createOrdinaryAgent(cookie, "Write source");
    const entryId = await seedEntry(source.key.secret, "Read only entry");
    const reader = await createReader(cookie, "Write reader", { mode: "all" });
    const token = reader.key.secret;

    const attempts: Array<[string, string, unknown?]> = [
      ["POST", "/api/v1/agent/entries", { title: "x", content: "y" }],
      ["POST", `/api/v1/agent/entries/${entryId}/versions`, { title: "x", content: "y", base_version: 1 }],
      ["POST", "/api/v1/agent/tasks", { title: "x" }],
      ["PATCH", "/api/v1/agent/tasks/whatever", { done: true }],
      ["DELETE", "/api/v1/agent/tasks/whatever"],
      ["POST", "/api/v1/agent/report", { result: "success" }],
      ["PATCH", `/api/v1/admin/entries/${entryId}/state`, { archived: true }],
      ["POST", "/api/v1/admin/entries/read", {}],
      ["GET", "/api/v1/admin/agents"],
      ["GET", "/api/v1/manager/entries"],
      ["POST", "/api/v1/manager/report", { result: "success" }],
      ["GET", "/api/v1/agent/entries"],
    ];
    for (const [method, path, body] of attempts) {
      const response = await api(path, body === undefined
        ? { method, headers: bearer(token) }
        : jsonBody(method, body, bearer(token)));
      expect(response.status, `${method} ${path}`).toBe(403);
    }

    // 业务数据没有变化：条目仍可读，且没有被标记归档或已读。
    const entry = await readerGet<EntryFullDto>(token, `/api/v1/reader/entries/${entryId}`);
    expect(entry.archived).toBe(false);
    expect(entry.read_version).toBe(0);
  });

  it("service layer entry points reject a reader actor directly", async () => {
    const cookie = await loginAdmin("service");
    const source = await createOrdinaryAgent(cookie, "Service source");
    const entryId = await seedEntry(source.key.secret, "Service entry");
    await seedTask(source.key.secret, "Service task");
    const reader = await createReader(cookie, "Service reader", { mode: "all" });
    const ctx = readerServiceContext(reader.agent.id, "all");

    await expect(createEntry(ctx, source.agent.id, { title: "x", content: "y" })).rejects.toMatchObject({ status: 403 });
    await expect(listTasks(ctx, {})).resolves.toBeDefined();

    // 同一身份改成 selected 且没有授权时读取为空页，而不是越过权限。
    const restricted = readerServiceContext(reader.agent.id, "selected");
    const page = await listTasks(restricted, {});
    expect(page.items).toEqual([]);
    const entries = await listEntries(restricted, {}, "reader");
    expect(entries.items).toEqual([]);
    void entryId;
  });

  it("returns 404 for attachments outside the granted scope", async () => {
    const cookie = await loginAdmin("media");
    const a = await createOrdinaryAgent(cookie, "Media A");
    const b = await createOrdinaryAgent(cookie, "Media B");
    const aImage = await seedAttachment(a.key.secret, "a.png");
    const bImage = await seedAttachment(b.key.secret, "b.png");

    const reader = await createReader(cookie, "Media reader", { mode: "selected", agent_ids: [a.agent.id] });
    const token = reader.key.secret;

    const granted = await api(`/api/v1/media/${aImage.id}`, { headers: bearer(token) });
    expect(granted.status).toBe(200);
    expect(granted.headers.get("Cache-Control")).toContain("no-store");
    expect(granted.headers.get("Content-Type")).toBe("image/png");

    const denied = await api(`/api/v1/media/${bImage.id}`, { headers: bearer(token) });
    expect(denied.status).toBe(404);
    const deniedError = await errorBody(denied);
    expect(JSON.stringify(deniedError)).not.toContain("b.png");
    // 越权与不存在的附件返回同一语义，不暴露文件名、大小或对象地址。
    expect(errorSemantics(deniedError)).toEqual(
      errorSemantics(await errorBody(await api("/api/v1/media/att-does-not-exist", { headers: bearer(token) }))),
    );

    // service 层同样拒绝，避免只测路由。
    await expect(getAttachmentMedia(readerServiceContext(reader.agent.id, "selected"), bImage.id))
      .rejects.toMatchObject({ status: 404 });
    // 同一身份在 all 模式下可以读取，证明拒绝原因就是授权范围。
    await expect(getAttachmentMedia(readerServiceContext(reader.agent.id, "all"), bImage.id))
      .resolves.toMatchObject({ status: 200 });
  });
});

describe("read-only agents: authorization changes", () => {
  it("applies a full replacement, bumps the revision and answers with the new configuration", async () => {
    const cookie = await loginAdmin("replace");
    const a = await createOrdinaryAgent(cookie, "Replace A");
    const b = await createOrdinaryAgent(cookie, "Replace B");
    const reader = await createReader(cookie, "Replace reader", { mode: "selected", agent_ids: [a.agent.id] });

    const before = await readJson<ReadAccessDto>(await api(`/api/v1/admin/agents/${reader.agent.id}/read-access`, {
      headers: { Cookie: cookie },
    }));
    expect(before.mode).toBe("selected");
    expect(before.sources.map((item) => item.id)).toEqual([a.agent.id]);

    const updated = await readJson<ReadAccessDto>(await api(`/api/v1/admin/agents/${reader.agent.id}/read-access`, jsonBody("PUT", {
      base_revision: before.revision,
      mode: "selected",
      agent_ids: [b.agent.id],
    }, { Cookie: cookie, Origin: APP_ORIGIN })));
    expect(updated.revision).toBe(before.revision + 1);
    expect(updated.sources.map((item) => item.id)).toEqual([b.agent.id]);

    // 授权替换是完整替换：A 立刻不可读，B 立即可读，且同一密钥无需更换。
    const aEntry = await seedEntry(a.key.secret, "Replace A entry");
    const bEntry = await seedEntry(b.key.secret, "Replace B entry");
    expect((await api(`/api/v1/reader/entries/${aEntry}`, { headers: bearer(reader.key.secret) })).status).toBe(404);
    expect((await api(`/api/v1/reader/entries/${bEntry}`, { headers: bearer(reader.key.secret) })).status).toBe(200);

    // 并发替换：同一个 base_revision 只有一个成功。
    const stale = await api(`/api/v1/admin/agents/${reader.agent.id}/read-access`, jsonBody("PUT", {
      base_revision: before.revision,
      mode: "selected",
      agent_ids: [a.agent.id],
    }, { Cookie: cookie, Origin: APP_ORIGIN }));
    expect(stale.status).toBe(409);

    // 失败者不得改动任何授权行。
    const stillB = await readJson<ReadAccessDto>(await api(`/api/v1/admin/agents/${reader.agent.id}/read-access`, {
      headers: { Cookie: cookie },
    }));
    expect(stillB.sources.map((item) => item.id)).toEqual([b.agent.id]);
    expect(stillB.revision).toBe(before.revision + 1);
  });

  it("distinguishes cursor_scope_changed from invalid_cursor", async () => {
    const cookie = await loginAdmin("cursor");
    const a = await createOrdinaryAgent(cookie, "Cursor A");
    for (let index = 0; index < 3; index += 1) await seedEntry(a.key.secret, `Cursor entry ${index}`);
    const reader = await createReader(cookie, "Cursor reader", { mode: "selected", agent_ids: [a.agent.id] });
    const token = reader.key.secret;

    const first = await readerGet<Page<EntryFullDto>>(token, "/api/v1/reader/entries?limit=1");
    expect(first.next_cursor).toBeTruthy();

    // 同一筛选条件下继续翻页。
    const second = await readerGet<Page<EntryFullDto>>(token, `/api/v1/reader/entries?limit=1&cursor=${encodeURIComponent(first.next_cursor!)}`);
    expect(second.items).toHaveLength(1);

    // 筛选条件变化 → invalid_cursor。
    const changed = await api(`/api/v1/reader/entries?limit=1&archived=no&cursor=${encodeURIComponent(first.next_cursor!)}`, { headers: bearer(token) });
    expect(changed.status).toBe(400);
    expect((await errorBody(changed)).code).toBe("invalid_cursor");

    // 伪造的游标不能扩大范围。
    expect((await errorBody(await api("/api/v1/reader/entries?limit=1&cursor=ZmFrZQ", { headers: bearer(token) }))).code)
      .toBe("invalid_cursor");

    // 管理员改动授权后，旧游标提示从第一页重新读取。
    const current = await readJson<ReadAccessDto>(await api(`/api/v1/admin/agents/${reader.agent.id}/read-access`, {
      headers: { Cookie: cookie },
    }));
    await api(`/api/v1/admin/agents/${reader.agent.id}/read-access`, jsonBody("PUT", {
      base_revision: current.revision,
      mode: "selected",
      agent_ids: [],
    }, { Cookie: cookie, Origin: APP_ORIGIN }));

    const scoped = await api(`/api/v1/reader/entries?limit=1&cursor=${encodeURIComponent(first.next_cursor!)}`, { headers: bearer(token) });
    expect(scoped.status).toBe(400);
    const body = await errorBody(scoped);
    expect(body.code).toBe("cursor_scope_changed");
    expect(body.details).toEqual({ restart_from_first_page: true });

    // 空清单返回空页，而不是所有内容。
    const empty = await readerGet<Page<EntryFullDto>>(token, "/api/v1/reader/entries");
    expect(empty.items).toEqual([]);
  });

  it("keeps 'all' dynamic and 'selected' static when new sources appear", async () => {
    const cookie = await loginAdmin("dynamic");
    const a = await createOrdinaryAgent(cookie, "Dynamic A");
    const allReader = await createReader(cookie, "All reader", { mode: "all" });
    const selectedReader = await createReader(cookie, "Selected reader", { mode: "selected", agent_ids: [a.agent.id] });

    const fresh = await createOrdinaryAgent(cookie, "Dynamic B");
    const allSources = await readerGet<Page<ReaderSourceDto>>(allReader.key.secret, "/api/v1/reader/agents");
    expect(allSources.items.map((item) => item.id)).toContain(fresh.agent.id);
    // all 模式也包含手动记录分区。
    expect(allSources.items.map((item) => item.id)).toContain("manual");

    const selectedSources = await readerGet<Page<ReaderSourceDto>>(selectedReader.key.secret, "/api/v1/reader/agents");
    expect(selectedSources.items.map((item) => item.id)).not.toContain(fresh.agent.id);
  });
});

describe("read-only agents: lifecycle", () => {
  it("stops reading after disable, removal, deleting and key revocation", async () => {
    const cookie = await loginAdmin("lifecycle");
    const source = await createOrdinaryAgent(cookie, "Lifecycle source");
    const entryId = await seedEntry(source.key.secret, "Lifecycle entry");
    const reader = await createReader(cookie, "Lifecycle reader", { mode: "all" });
    const token = reader.key.secret;
    expect((await api(`/api/v1/reader/entries/${entryId}`, { headers: bearer(token) })).status).toBe(200);

    const disable = await api(`/api/v1/admin/agents/${reader.agent.id}/disable`, { method: "POST", headers: { Cookie: cookie, Origin: APP_ORIGIN } });
    expect(disable.status).toBe(200);
    expect((await api(`/api/v1/reader/entries/${entryId}`, { headers: bearer(token) })).status).toBe(403);

    await api(`/api/v1/admin/agents/${reader.agent.id}/restore`, { method: "POST", headers: { Cookie: cookie, Origin: APP_ORIGIN } });
    await api(`/api/v1/admin/agents/${reader.agent.id}/enable`, { method: "POST", headers: { Cookie: cookie, Origin: APP_ORIGIN } });
    const reissued = await readJson<{ secret: string }>(await api(`/api/v1/admin/agents/${reader.agent.id}/keys`, jsonBody("POST", { expires_at: null }, {
      Cookie: cookie, Origin: APP_ORIGIN,
    })));
    // 移除会撤销旧密钥；恢复后需要重新签发，旧密钥不能再用。
    const removed = await api(`/api/v1/admin/agents/${reader.agent.id}/remove`, { method: "POST", headers: { Cookie: cookie, Origin: APP_ORIGIN } });
    expect(removed.status).toBe(200);
    expect((await api(`/api/v1/reader/entries/${entryId}`, { headers: bearer(reissued.secret) })).status).toBe(401);

    // 来源进入 deleting 后立即不可读，即使授权行还在。
    await env.DB.prepare("UPDATE agents SET status = 'deleting', deleting_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), source.agent.id).run();
    const stillGranted = await createReader(cookie, "Post deleting reader", { mode: "all" });
    expect((await api(`/api/v1/reader/entries/${entryId}`, { headers: bearer(stillGranted.key.secret) })).status).toBe(404);
  });

  it("cascades grant cleanup when a source or reader is permanently deleted", async () => {
    const cookie = await loginAdmin("cascade");
    const source = await createOrdinaryAgent(cookie, "Cascade source");
    const reader = await createReader(cookie, "Cascade reader", { mode: "selected", agent_ids: [source.agent.id] });

    const grantCount = async (): Promise<number> => {
      const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM agent_read_grants WHERE reader_agent_id = ?")
        .bind(reader.agent.id).first<{ count: number }>();
      return row?.count ?? 0;
    };
    expect(await grantCount()).toBe(1);

    // 来源永久删除后反向授权被清理。
    const purgeSource = await api(`/api/v1/admin/agents/${source.agent.id}`, { method: "DELETE", headers: { Cookie: cookie, Origin: APP_ORIGIN } });
    expect(purgeSource.status).toBe(200);
    expect(await grantCount()).toBe(0);

    // 删除只读身份不影响任何被授权来源的内容。
    const other = await createOrdinaryAgent(cookie, "Cascade other");
    const otherEntry = await seedEntry(other.key.secret, "Cascade entry");
    const secondReader = await createReader(cookie, "Cascade reader two", { mode: "selected", agent_ids: [other.agent.id] });
    const purgeReader = await api(`/api/v1/admin/agents/${secondReader.agent.id}`, { method: "DELETE", headers: { Cookie: cookie, Origin: APP_ORIGIN } });
    expect(purgeReader.status).toBe(200);
    const survived = await api(`/api/v1/agent/entries/${otherEntry}`, { headers: bearer(other.key.secret) });
    expect(survived.status).toBe(200);
  });

  it("never leaks run notes, results or key material through reader DTOs", async () => {
    const cookie = await loginAdmin("dto");
    const source = await createOrdinaryAgent(cookie, "DTO source");
    await api("/api/v1/agent/report", jsonBody("POST", { result: "failed", note: "internal-note-marker" }, bearer(source.key.secret)));

    const reader = await createReader(cookie, "DTO reader", { mode: "all" });
    // 只读身份自己的运行备注为空，但来源可能带有备注；两种都不能出现在响应里。
    await env.DB.prepare("UPDATE agents SET last_note = ?, last_result = 'failed' WHERE id = ?")
      .bind("reader-internal-note-marker", reader.agent.id).run();

    const self = await readerGet<ReaderSelfDto>(reader.key.secret, "/api/v1/reader");
    expect(Object.keys(self).sort()).toEqual(
      ["description", "id", "mode", "name", "permissions_revision", "role"].sort(),
    );
    expect(self.role).toBe("reader");

    const sources = await readerGet<Page<ReaderSourceDto>>(reader.key.secret, "/api/v1/reader/agents");
    const dto = sources.items.find((item) => item.id === source.agent.id)!;
    expect(dto).toBeDefined();
    expect(Object.keys(dto).sort()).toEqual(
      ["description", "display_mode", "id", "main_entry_id", "name", "status"].sort(),
    );
    const serialized = JSON.stringify(sources);
    expect(serialized).not.toContain("internal-note-marker");
    expect(serialized).not.toContain("reader-internal-note-marker");
    expect(serialized).not.toContain("last_result");
  });
});

describe("read-only agents: rate limiting and logging", () => {
  it("keys the reader budget by identity, not by key, and fails closed when the binding is unusable", async () => {
    const readerActor = {
      type: "agent",
      agentId: "agent-limit-target",
      keyId: "key-limit-target",
      status: "active",
      role: "reader",
      readMode: "all",
      permissionsRevision: 3,
    } as const;

    const keysSeen: string[] = [];
    const denying = {
      limit: async ({ key }: { key: string }) => {
        keysSeen.push(key);
        return { success: false };
      },
    };
    await expect(enforceReaderRateLimit(
      { READER_RATE_LIMITER: denying } as unknown as CloudflareBindings,
      readerActor,
    )).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
      headers: { "Retry-After": "60" },
    });
    // 用已认证的 reader Agent ID 计数，不用 key ID，切换密钥不能绕过。
    expect(keysSeen).toEqual(["agent-limit-target"]);

    const throwing = { limit: async () => { throw new Error("limiter down"); } };
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(enforceReaderRateLimit(
      { READER_RATE_LIMITER: throwing } as unknown as CloudflareBindings,
      readerActor,
    )).rejects.toMatchObject({ status: 503 });
    // 绑定缺失时拒绝服务，不能悄悄取消限制。
    await expect(enforceReaderRateLimit({} as CloudflareBindings, readerActor))
      .rejects.toMatchObject({ status: 503 });

    // 非只读身份与未认证请求不消耗这个额度。
    const ordinary = { type: "agent", agentId: "agent-1", keyId: "k", status: "active", role: "agent" } as const;
    await expect(enforceReaderRateLimit({} as CloudflareBindings, ordinary)).resolves.toBeUndefined();
    await expect(enforceReaderRateLimit({} as CloudflareBindings, undefined)).resolves.toBeUndefined();
  });

  it("serves reader traffic through the real rate limit binding", async () => {
    const cookie = await loginAdmin("ratelimit-wired");
    const reader = await createReader(cookie, "Wired reader", { mode: "all" });
    // 绑定缺失会返回 503；这里走通说明本地与生产配置都已绑定。
    const response = await api("/api/v1/reader", { headers: bearer(reader.key.secret) });
    expect(response.status).toBe(200);
  });

  it("logs reader access without credentials, bodies or search terms", async () => {
    const cookie = await loginAdmin("log");
    const source = await createOrdinaryAgent(cookie, "Log source");
    await seedEntry(source.key.secret, "Log entry");
    const reader = await createReader(cookie, "Log reader", { mode: "all" });

    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value?: unknown) => {
      logged.push(typeof value === "string" ? value : JSON.stringify(value));
    });

    await api("/api/v1/reader/agents", { headers: bearer(reader.key.secret) });
    await api("/api/v1/reader/entries?query=secret-search-term", { headers: bearer(reader.key.secret) });
    await api("/api/v1/agent/entries", { headers: bearer(reader.key.secret) });

    const combined = logged.join("\n");
    expect(combined).toContain(reader.agent.id);
    expect(combined).toContain("reader_api_access");
    expect(combined).not.toContain(reader.key.secret);
    expect(combined).not.toContain("secret-search-term");
    const statuses = logged
      .map((line) => JSON.parse(line) as { status?: number })
      .map((entry) => entry.status);
    expect(statuses).toContain(200);
    expect(statuses).toContain(403);
  });

  it("serves reader-specific discovery documents", async () => {
    const cookie = await loginAdmin("docs");
    const reader = await createReader(cookie, "Docs reader", { mode: "all" });

    const quick = await readerGet<{ credential_role: string; available_routes: { path: string }[] }>(
      reader.key.secret,
      "/api",
    );
    expect(quick.credential_role).toBe("reader");
    expect(quick.available_routes.every(
      (route) => route.path.startsWith("/api/v1/reader") || route.path.startsWith("/api/v1/media"),
    )).toBe(true);

    const docs = await api("/api/docs", { headers: bearer(reader.key.secret) });
    expect(docs.status).toBe(200);
    const text = await docs.text();
    expect(text).toContain("当前凭据角色：只读 Agent");
    expect(text).toContain("cursor_scope_changed");
    expect(text).not.toContain("/api/v1/admin/agents/{id}/keys");
    expect(text).not.toContain("/api/v1/manager/entries");
  });

  it("normalizes unknown reader paths to a 404 without exposing other namespaces", async () => {
    const cookie = await loginAdmin("unknown");
    const reader = await createReader(cookie, "Unknown path reader", { mode: "all" });
    expect((await api("/api/v1/reader/nope", { headers: bearer(reader.key.secret) })).status).toBe(404);
    expect((await api("/api/v1/admin/agents", { headers: bearer(reader.key.secret) })).status).toBe(403);
    // 全局网关是 fail-closed：不在允许清单里的路径一律拒绝，
    // 即使该路由自己没有声明角色名单（/api/health 就是这种路由）。
    expect((await api("/api/health", { headers: bearer(reader.key.secret) })).status).toBe(403);
    expect((await api("/api/v1/manager/entries", { headers: bearer(reader.key.secret) })).status).toBe(403);
    expect(normalizeError(new Error("boom")).code).toBe("internal_error");
  });
});
