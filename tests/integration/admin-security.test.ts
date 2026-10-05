import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../../src/server/app";
import { generateSecret, formatSessionToken, hashAdminLoginSecret, hashCredential } from "../../src/server/modules/auth/crypto";
import { insertSession, rotateAdminCredential } from "../../src/server/modules/auth/repository";
import { authenticateBearer } from "../../src/server/modules/auth/service";

const origin = "http://localhost:5173";
const initial = "test-admin-secret-with-sufficient-entropy";
const next = "new-admin-secret-with-sufficient-entropy-2026";

function call(path: string, method = "GET", cookie?: string, data?: unknown, extra?: Record<string, string>) {
  return app.request(origin + path, {
    method,
    headers: { Origin: origin, "Content-Type": "application/json", "CF-Connecting-IP": crypto.randomUUID(),
      ...(cookie ? { Cookie: cookie } : {}), ...extra },
    body: data === undefined ? undefined : JSON.stringify(data),
  }, env);
}

async function login(secret = initial) {
  const response = await call("/api/v1/auth/login", "POST", undefined, { secret });
  expect(response.status).toBe(200);
  return response.headers.get("Set-Cookie")!.split(";")[0]!;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM admin_sessions"),
    env.DB.prepare("UPDATE admin_credentials SET secret_hash = NULL, revision = 0, updated_at = NULL WHERE id = 1"),
  ]);
});

describe("online administrator credential rotation", () => {
  it("lets managers rotate login credentials and revoke passkeys while rejecting stale manager keys in the transaction", async () => {
    const cookie = await login();
    await env.DB.prepare("UPDATE agents SET status = 'disabled' WHERE scope = 'all' AND access_mode = 'read_write' AND status = 'active'").run();
    const response = await call("/api/v1/admin/agents", "POST", cookie, { name: "Credential manager", role: "manager" });
    expect(response.status).toBe(201);
    const manager = await response.json<{ agent: { id: string }; key: { id: string; secret: string } }>();
    const headers = { Authorization: `Bearer ${manager.key.secret}` };
    const id = `manager-passkey-${crypto.randomUUID()}`;
    await env.DB.prepare(`INSERT INTO admin_passkeys (id, credential_id, public_key, user_handle, counter, credential_revision, name, created_at)
      VALUES (?, ?, 'test-public-key', 'test-user', 0, 0, 'Manager metadata test', ?)`)
      .bind(id, `credential-${id}`, new Date().toISOString()).run();
    expect((await call(`/api/v1/auth/passkeys/${id}`, "DELETE", undefined, undefined, headers)).status).toBe(204);
    const body = { current_secret: initial, new_secret: next };
    expect((await call("/api/v1/auth/change-secret", "POST", undefined, { ...body, current_secret: "wrong" }, headers)).status).toBe(403);
    // Direct API keys work without a browser Origin, while session writes still require it.
    const changed = await app.request(origin + "/api/v1/auth/change-secret", {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body),
    }, env);
    expect(changed.status).toBe(204);
    expect((await call("/api/v1/auth/session", "GET", cookie)).status).toBe(401);
    expect((await call("/api/v1/admin/agents", "GET", undefined, undefined, headers)).status).toBe(200);
    await login(next);
    const actor = await authenticateBearer(env, manager.key.secret);
    if (actor.role !== "manager") throw new Error("Expected manager");
    await env.DB.prepare("UPDATE agent_keys SET revoked_at = ? WHERE id = ?").bind(new Date().toISOString(), manager.key.id).run();
    const digest = await hashAdminLoginSecret(initial, env.AUTH_PEPPER);
    expect(await rotateAdminCredential(env.DB, actor, 1, digest, new Date().toISOString())).toBe(false);
    await login(next);
  });
  it("requires a session, same origin, correct old secret and a sufficiently long new secret", async () => {
    const body = { current_secret: initial, new_secret: next };
    expect((await call("/api/v1/auth/change-secret", "POST", undefined, body)).status).toBe(401);
    const cookie = await login();
    expect((await call("/api/v1/auth/change-secret", "POST", cookie, body, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await call("/api/v1/auth/change-secret", "POST", cookie, { ...body, current_secret: "wrong" })).status).toBe(403);
    expect((await call("/api/v1/auth/change-secret", "POST", cookie, { ...body, new_secret: "short" })).status).toBe(400);
    expect((await call("/api/v1/auth/change-secret", "POST", cookie, { ...body, new_secret: initial })).status).toBe(400);
    expect((await call("/api/v1/auth/session", "GET", cookie)).status).toBe(200);
  });

  it("stores only a digest, invalidates all old sessions, and never falls back to the initial secret", async () => {
    const first = await login();
    const second = await login();
    const response = await call("/api/v1/auth/change-secret", "POST", first, { current_secret: initial, new_secret: next });
    expect(response.status).toBe(204);
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect((await call("/api/v1/auth/session", "GET", first)).status).toBe(401);
    expect((await call("/api/v1/auth/session", "GET", second)).status).toBe(401);
    expect((await call("/api/v1/auth/login", "POST", undefined, { secret: initial })).status).toBe(401);
    const row = await env.DB.prepare("SELECT * FROM admin_credentials WHERE id = 1").first();
    expect(row?.revision).toBe(1);
    expect(JSON.stringify(row)).not.toContain(next);
    const fresh = await login(next);
    expect((await call("/api/v1/auth/session", "GET", fresh)).status).toBe(200);
    // A second rotation must validate the database credential, not the env bootstrap value.
    const third = "third-admin-secret-with-sufficient-entropy-2026";
    expect((await call("/api/v1/auth/change-secret", "POST", fresh, { current_secret: initial, new_secret: third })).status).toBe(403);
    expect((await call("/api/v1/auth/change-secret", "POST", fresh, { current_secret: next, new_secret: third })).status).toBe(204);
    await login(third);
  });

  it("rejects stale in-flight logins and concurrent rotations without invalidating new sessions", async () => {
    await login();
    const session = await env.DB.prepare("SELECT id FROM admin_sessions LIMIT 1").first<{ id: string }>();
    const digest = await hashAdminLoginSecret(next, env.AUTH_PEPPER);
    const now = new Date().toISOString();
    expect(await rotateAdminCredential(env.DB, { type: "admin", sessionId: session!.id }, 0, digest, now)).toBe(true);
    await expect(insertSession(env.DB, { id: "stale-login", tokenHash: "unused", createdAt: now,
      expiresAt: "2099-01-01T00:00:00.000Z", credentialRevision: 0 })).rejects.toThrow("登录密钥已变更");
    const fresh = await login(next);
    expect(await rotateAdminCredential(env.DB, { type: "admin", sessionId: session!.id }, 0, digest, now)).toBe(false);
    expect((await call("/api/v1/auth/session", "GET", fresh)).status).toBe(200);
  });

  it("does not allow a logged-out session to rotate credentials", async () => {
    const cookie = await login();
    const session = await env.DB.prepare("SELECT id FROM admin_sessions LIMIT 1").first<{ id: string }>();
    expect((await call("/api/v1/auth/logout", "POST", cookie)).status).toBe(204);
    const digest = await hashAdminLoginSecret(next, env.AUTH_PEPPER);
    expect(await rotateAdminCredential(env.DB, { type: "admin", sessionId: session!.id }, 0, digest, new Date().toISOString())).toBe(false);
    await login();
  });

  it("preserves Agent keys and prevents Agent callers from changing the admin credential", async () => {
    const cookie = await login();
    const created = await call("/api/v1/admin/agents", "POST", cookie, { name: "Rotation isolation" });
    expect(created.status).toBe(201);
    const agent = await created.json<{ key: { secret: string } }>();
    const headers = { Authorization: `Bearer ${agent.key.secret}` };
    const body = { current_secret: initial, new_secret: next };
    expect((await call("/api/v1/auth/change-secret", "POST", undefined, body, headers)).status).toBe(403);
    expect((await call("/api/v1/auth/change-secret", "POST", cookie, body)).status).toBe(204);
    expect((await call("/api/v1/agent", "GET", undefined, undefined, headers)).status).toBe(200);
  });

  it("keeps legacy revision-zero sessions usable until the first change", async () => {
    const secret = generateSecret();
    const digest = await hashCredential("session", "legacy-session", secret, env.AUTH_PEPPER);
    await env.DB.prepare("INSERT INTO admin_sessions (id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind("legacy-session", digest, new Date().toISOString(), "2099-01-01T00:00:00.000Z").run();
    const row = await env.DB.prepare("SELECT credential_revision FROM admin_sessions WHERE id = ?")
      .bind("legacy-session").first<{ credential_revision: number }>();
    expect(row?.credential_revision).toBe(0);
    const cookie = `__Host-ph_session=${formatSessionToken("legacy-session", secret)}`;
    expect((await call("/api/v1/auth/session", "GET", cookie)).status).toBe(200);
  });
});
