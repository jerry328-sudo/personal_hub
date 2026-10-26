import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../../src/server/app";
import type { SiteThemeSettings } from "../../src/shared/contracts";

const origin = "http://localhost:5173";

function call(path: string, method = "GET", cookie?: string, data?: unknown, extra: Record<string, string> = {}) {
  return app.request(origin + path, {
    method,
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "CF-Connecting-IP": crypto.randomUUID(),
      ...(cookie ? { Cookie: cookie } : {}),
      ...extra,
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  }, env);
}

async function login() {
  const response = await call("/api/v1/auth/login", "POST", undefined, {
    secret: "test-admin-secret-with-sufficient-entropy",
  });
  expect(response.status).toBe(200);
  return response.headers.get("Set-Cookie")!.split(";", 1)[0]!;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM site_settings"),
    env.DB.prepare("INSERT INTO site_settings (id, theme) VALUES (1, 'current')"),
    env.DB.prepare("DELETE FROM admin_sessions"),
    env.DB.prepare("UPDATE admin_credentials SET secret_hash = NULL, revision = 0, updated_at = NULL WHERE id = 1"),
  ]);
});

describe("global interface theme", () => {
  it("allows the login page to read only the current theme without authentication or caching", async () => {
    const response = await app.request(origin + "/api/v1/ui-theme", {}, env);
    expect(response.status).toBe(200);
    expect(await response.json<SiteThemeSettings>()).toEqual({ theme: "current" });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await call("/api/v1/ui-theme", "POST", undefined, { theme: "template" })).status).toBe(401);
    expect((await call("/api/v1/ui-theme/other")).status).toBe(401);
    expect((await call("/api/v1/admin/agents")).status).toBe(401);
  });

  it("persists one setting shared by new requests and independent administrator sessions", async () => {
    const first = await login();
    const second = await login();
    const changed = await call("/api/v1/admin/ui-theme", "PUT", first, { theme: "template" });
    expect(changed.status).toBe(200);
    expect(await changed.json<SiteThemeSettings>()).toEqual({ theme: "template" });
    expect(changed.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await (await call("/api/v1/ui-theme")).json()).toEqual({ theme: "template" });
    expect(await (await call("/api/v1/ui-theme", "GET", second)).json()).toEqual({ theme: "template" });
    expect(await env.DB.prepare("SELECT theme FROM site_settings WHERE id = 1").first()).toEqual({ theme: "template" });
    expect((await call("/api/v1/admin/ui-theme", "PUT", second, { theme: "current" })).status).toBe(200);
    expect(await (await call("/api/v1/ui-theme")).json()).toEqual({ theme: "current" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM site_settings").first()).toEqual({ count: 1 });
  });

  it("requires an administrator session, same origin and a supported theme without extra fields", async () => {
    const data = { theme: "template" };
    expect((await call("/api/v1/admin/ui-theme", "PUT", undefined, data)).status).toBe(401);
    const cookie = await login();
    expect((await call("/api/v1/admin/ui-theme", "PUT", cookie, data, { Origin: "https://other.example" })).status).toBe(403);
    expect((await call("/api/v1/admin/ui-theme", "PUT", cookie, data, { Origin: "" })).status).toBe(403);
    for (const invalid of [{ theme: "unknown" }, { theme: "template", other: true }, {}, { theme: null }]) {
      expect((await call("/api/v1/admin/ui-theme", "PUT", cookie, invalid)).status).toBe(400);
    }
    expect(await (await call("/api/v1/ui-theme")).json()).toEqual({ theme: "current" });
  });

  it("does not let ordinary, manager or read-only credentials change the site theme", async () => {
    const cookie = await login();
    await env.DB.prepare("UPDATE agents SET status = 'disabled' WHERE scope = 'all' AND access_mode = 'read_write' AND status = 'active'").run();
    for (const role of ["agent", "manager", "reader"] as const) {
      const created = await call("/api/v1/admin/agents", "POST", cookie, {
        name: `Theme access ${role}`,
        role,
        ...(role === "reader" ? { read_access: { mode: "all" } } : {}),
      });
      expect(created.status).toBe(201);
      const identity = await created.json<{ key: { secret: string } }>();
      const denied = await call("/api/v1/admin/ui-theme", "PUT", undefined, { theme: "template" }, {
        Authorization: `Bearer ${identity.key.secret}`,
      });
      expect(denied.status).toBe(403);
    }
    expect(await (await call("/api/v1/ui-theme")).json()).toEqual({ theme: "current" });
  });

  it("defaults safely when unset and can save the singleton again", async () => {
    await env.DB.prepare("DELETE FROM site_settings").run();
    expect(await (await call("/api/v1/ui-theme")).json()).toEqual({ theme: "current" });
    const cookie = await login();
    expect((await call("/api/v1/admin/ui-theme", "PUT", cookie, { theme: "template" })).status).toBe(200);
    expect(await (await call("/api/v1/ui-theme")).json()).toEqual({ theme: "template" });
  });
});
