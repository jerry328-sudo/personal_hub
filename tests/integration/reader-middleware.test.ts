import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import app from "../../src/server/app";
import { createAgent } from "../../src/server/modules/agents/service";

afterEach(() => vi.restoreAllMocks());

async function createReader() {
  return createAgent({
    env,
    actor: { type: "admin", sessionId: "middleware-test" },
    requestId: "middleware-test",
  }, { name: "Middleware reader", role: "reader", read_access: { mode: "all" } });
}

it.each([
  "/api",
  "/api/docs",
  "/api/v1/reader",
  "/api/v1/media/missing",
  "/api/v1/manager/entries",
  "/api/v1/admin/agents",
])("limits authenticated reader requests before path authorization: %s", async (path) => {
  const reader = await createReader();
  const limit = vi.fn(async () => ({ success: false }));
  const response = await app.request(`http://localhost:5173${path}`, {
    headers: { Authorization: `Bearer ${reader.key.secret}` },
  }, { ...env, READER_RATE_LIMITER: { limit } });
  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toBe("60");
  expect(limit).toHaveBeenCalledExactlyOnceWith({ key: reader.agent.id });
});

it.each([
  { path: "/api/v1/reader", limiter: "allow", status: 200, code: "ok" },
  { path: "/api/v1/manager/entries", limiter: "allow", status: 403, code: "forbidden" },
  { path: "/api/v1/reader/entries/missing", limiter: "allow", status: 404, code: "not_found" },
  { path: "/api/v1/reader/no-such-route", limiter: "allow", status: 404, code: "not_found" },
  { path: "/api/v1/reader", limiter: "deny", status: 429, code: "rate_limited" },
  { path: "/api/v1/reader", limiter: "error", status: 503, code: "service_unavailable" },
])("logs the actual response code $code for $path", async ({ path, limiter, status, code }) => {
  const reader = await createReader();
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const response = await app.request(`http://localhost:5173${path}?query=private-search`, {
    headers: { Authorization: `Bearer ${reader.key.secret}` },
  }, { ...env, READER_RATE_LIMITER: {
    limit: async () => {
      if (limiter === "error") throw new Error("binding failed");
      return { success: limiter === "allow" };
    },
  } });
  expect(response.status).toBe(status);
  const access = log.mock.calls.map(([value]) => JSON.parse(String(value)) as Record<string, unknown>)
    .filter((row) => row.event === "reader_api_access");
  expect(access).toHaveLength(1);
  expect(access[0]).toMatchObject({ status, code, reader_agent_id: reader.agent.id });
  expect(JSON.stringify(access)).not.toContain(reader.key.secret);
  expect(JSON.stringify(access)).not.toContain("private-search");
});
