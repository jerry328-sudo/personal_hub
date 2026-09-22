import { env as cloudflareEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  formatAgentKey,
  generateSecret,
  hashCredential,
  verifyAdminSecret,
} from "../../src/server/modules/auth/crypto";
import { authenticateRequest } from "../../src/server/modules/auth/service";

const PEPPER = "test-pepper-with-at-least-32-random-bytes";

describe("administrator secret verification", () => {
  it("accepts a matching strong configured secret", async () => {
    const secret = "a-strong-admin-secret-with-32-bytes";
    await expect(verifyAdminSecret(secret, secret)).resolves.toBe(true);
    await expect(verifyAdminSecret("incorrect", secret)).resolves.toBe(false);
  });

  it("rejects a configured root secret shorter than 32 UTF-8 bytes", async () => {
    await expect(verifyAdminSecret("short", "x".repeat(31))).rejects.toThrow(
      "ADMIN_LOGIN_SECRET 必须至少包含 32 个 UTF-8 字节",
    );
  });
});

describe("Bearer authentication scheme", () => {
  it("accepts the scheme case-insensitively while preserving the token", async () => {
    const suffix = crypto.randomUUID();
    const id = `key-${suffix}`;
    const agentId = `agent-${suffix}`;
    const secret = generateSecret();
    const token = formatAgentKey(id, secret);
    const secretHash = await hashCredential("agent", id, secret, PEPPER);
    const createdAt = new Date().toISOString();
    await cloudflareEnv.DB.prepare(
      `INSERT INTO agents (
         id, name, description, scope, status, display_mode, created_at
       ) VALUES (?, ?, '', 'own', 'active', 'feed', ?)`,
    ).bind(agentId, "Auth test agent", createdAt).run();
    await cloudflareEnv.DB.prepare(
      `INSERT INTO agent_keys (
         id, agent_id, secret_hash, created_at, expires_at, revoked_at, last_used_at
       ) VALUES (?, ?, ?, ?, NULL, NULL, NULL)`,
    ).bind(id, agentId, secretHash, createdAt).run();

    const authEnv = {
      AUTH_PEPPER: PEPPER,
      DB: cloudflareEnv.DB,
    } as CloudflareBindings;
    const request = new Request("https://hub.example/api", {
      headers: { Authorization: `bEaReR ${token}` },
    });

    await expect(authenticateRequest(request, authEnv)).resolves.toEqual({
      type: "agent",
      agentId,
      keyId: id,
      role: "agent",
      status: "active",
    });
    const stored = await cloudflareEnv.DB.prepare(
      "SELECT last_used_at FROM agent_keys WHERE id = ?",
    ).bind(id).first<{ last_used_at: string | null }>();
    expect(stored?.last_used_at).not.toBeNull();
  });
});
