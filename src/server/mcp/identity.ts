import { z } from "zod";
import type { Actor, AgentActor } from "../env";
import { decodeAgentRole } from "../modules/auth/service";
import { findKeyWithAgent, findSession, insertSession } from "../modules/auth/repository";
import { generateSecret, hashCredential } from "../modules/auth/crypto";
import { newEntityId, nowIso } from "../shared/ids";
import { unauthenticated } from "../shared/errors";

export const principalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("key"), keyId: z.string() }).strict(),
  z.object({ kind: z.literal("admin"), sessionId: z.string() }).strict(),
  z.object({ kind: z.literal("delegated"), sessionId: z.string(), keyId: z.string() }).strict(),
]);
export type McpPrincipal = z.infer<typeof principalSchema>;
export const MCP_SCOPES = ["hub:read", "hub:write", "hub:admin"] as const;
export type McpScope = typeof MCP_SCOPES[number];

export function scopesFor(actor: Actor): McpScope[] {
  if (actor.type === "admin") return [...MCP_SCOPES];
  return actor.role === "reader" ? ["hub:read"] : ["hub:read", "hub:write"];
}
export function scopeAllows(scopes: readonly string[], scope: McpScope): boolean {
  return scopes.includes(scope) || scopes.includes("hub:admin")
    || (scope === "hub:read" && scopes.includes("hub:write"));
}
export function principalFor(actor: Actor): McpPrincipal {
  return actor.type === "admin" ? { kind: "admin", sessionId: actor.sessionId }
    : { kind: "key", keyId: actor.keyId };
}

async function resolveKey(env: CloudflareBindings, keyId: string): Promise<AgentActor> {
  const now = nowIso();
  const row = await findKeyWithAgent(env.DB, keyId);
  if (!row || row.revokedAt || row.status !== "active"
    || (row.expiresAt !== null && (!Number.isFinite(Date.parse(row.expiresAt)) || Date.parse(row.expiresAt) <= Date.parse(now)))) throw unauthenticated();
  const role = decodeAgentRole(row);
  return { type: "agent", agentId: row.agentId, keyId: row.id, status: row.status, ...role };
}

/** OAuth stores only identity references. Resolve current permissions on every request. */
export async function resolvePrincipal(env: CloudflareBindings, value: unknown): Promise<Actor> {
  const principal = principalSchema.parse(value);
  if (principal.kind === "key") return resolveKey(env, principal.keyId);
  const now = nowIso();
  const session = await findSession(env.DB, principal.sessionId);
  if (!session || session.revokedAt || Date.parse(session.expiresAt) <= Date.parse(now)) throw unauthenticated();
  if (principal.kind === "admin") return { type: "admin", sessionId: principal.sessionId };
  return resolveKey(env, principal.keyId);
}

/** A separate session keeps OAuth independent of browser logout; credential rotation still revokes it. */
export async function createOAuthSession(env: CloudflareBindings, actor: Actor): Promise<string> {
  if (actor.type !== "admin") throw unauthenticated();
  const source = await env.DB.prepare(`SELECT credential_revision, passkey_id FROM admin_sessions
    WHERE id = ? AND revoked_at IS NULL AND expires_at > ?`)
    .bind(actor.sessionId, nowIso()).first<{ credential_revision: number; passkey_id: string | null }>();
  if (!source) throw unauthenticated();
  const id = newEntityId("session");
  await insertSession(env.DB, {
    id, tokenHash: await hashCredential("session", id, generateSecret(), env.AUTH_PEPPER),
    createdAt: nowIso(), expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
    credentialRevision: source.credential_revision,
    ...(source.passkey_id ? { passkeyId: source.passkey_id } : {}),
  });
  return id;
}
