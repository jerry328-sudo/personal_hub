import type {
  AgentKeyMetadataDto,
  IssuedKeyDto,
  SessionDto,
  ChangeAdminSecretInput,
} from "../../../shared/contracts";
import type { Actor, AgentActor, AgentReadMode, AgentRoleFields, ServiceContext } from "../../env";
import {
  conflict,
  badRequest,
  forbidden,
  notFound,
  rateLimited,
  unauthenticated,
} from "../../shared/errors";
import { newEntityId, nowIso } from "../../shared/ids";
import {
  buildSessionCookie,
  clearSessionCookie,
  formatAgentKey,
  formatSessionToken,
  generateSecret,
  hashCredential,
  parseAgentKey,
  parseSessionToken,
  SESSION_COOKIE_NAME,
  verifyAdminSecret,
  hashAdminLoginSecret,
  verifyAdminLoginHash,
  verifyCredential,
} from "./crypto";
import {
  deleteExpiredSessions,
  findAdminCredential,
  rotateAdminCredential,
  findAgentKeyTarget,
  findKeyWithAgent,
  findSession,
  insertKey,
  insertSession,
  listKeyMetadata,
  prepareInsertKey,
  revokeKey,
  revokeSession,
  touchKeyUsage,
  type AgentKeyInsert,
} from "./repository";

const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const LOGIN_RATE_LIMIT_PREFIX = "admin-login";

export type IdentityRole = "admin" | "agent" | "manager" | "reader";

/** decodeAgentRole 的结果。只包含角色判别信息，不包含身份标识。 */
export type DecodedAgentRole =
  | { role: "agent" }
  | { role: "manager" }
  | { role: "reader"; readMode: AgentReadMode; permissionsRevision: number };

/**
 * 验证数据库中 scope / access_mode / read_mode / permissions_revision 的合法组合。
 * 未知组合一律拒绝认证，不能降级为普通或总管角色。例如 read_only 但缺少
 * read_mode 表示权限配置缺失，必须失败而不是默认全部可读。
 */
export function decodeAgentRole(fields: AgentRoleFields): DecodedAgentRole {
  const { scope, accessMode, readMode, permissionsRevision } = fields;
  if (!Number.isSafeInteger(permissionsRevision) || permissionsRevision < 0) {
    throw unauthenticated("Agent 密钥无效或已失效");
  }
  if (accessMode === "read_write" && readMode === null) {
    if (scope === "own") return { role: "agent" };
    if (scope === "all") return { role: "manager" };
  }
  if (accessMode === "read_only" && scope === "all" && (readMode === "selected" || readMode === "all")) {
    return { role: "reader", readMode, permissionsRevision };
  }
  throw unauthenticated("Agent 密钥无效或已失效");
}

export interface LoginInput {
  secret: string;
}

export interface IssueKeyInput {
  expires_at?: string | null;
}

export interface LoginResult {
  session: SessionDto;
  cookie: string;
}

export interface PreparedAgentKey {
  record: AgentKeyInsert;
  plaintext: IssuedKeyDto;
  prepareInsert(db: D1Database): D1PreparedStatement;
}

function sessionTtlSeconds(env: CloudflareBindings): number {
  const parsed = Number.parseInt(env.SESSION_TTL_SECONDS, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_SESSION_TTL_SECONDS) {
    return DEFAULT_SESSION_TTL_SECONDS;
  }
  return parsed;
}

function isExpired(expiresAt: string | null, now: string): boolean {
  if (expiresAt === null) return false;
  const timestamp = Date.parse(expiresAt);
  return !Number.isFinite(timestamp) || timestamp <= Date.parse(now);
}

function roleOf(actor: Actor): IdentityRole {
  if (actor.type === "admin") return "admin";
  return actor.role;
}

function requireAdminActor(
  ctx: ServiceContext,
): asserts ctx is ServiceContext & { actor: Extract<Actor, { type: "admin" }> } {
  if (ctx.actor.type !== "admin") throw forbidden();
}

function requireUsableKeyTarget(
  target: Awaited<ReturnType<typeof findAgentKeyTarget>>,
): asserts target is NonNullable<typeof target> {
  if (!target) throw notFound("Agent 不存在");
  if (target.id === "manual") throw forbidden("手动分区不能签发 Agent 密钥");
  if (target.status === "removed" || target.status === "deleting") {
    throw forbidden("此 Agent 当前不能签发密钥");
  }
}

function normalizeFutureExpiry(expiresAt: string | null, now: string): string | null {
  if (expiresAt === null) return null;
  const timestamp = Date.parse(expiresAt);
  if (!Number.isFinite(timestamp) || timestamp <= Date.parse(now)) {
    throw conflict("密钥到期时间必须晚于当前时间");
  }
  return new Date(timestamp).toISOString();
}

function readSessionCookie(request: Request): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;

  const values: string[] = [];
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== SESSION_COOKIE_NAME) continue;
    values.push(part.slice(separator + 1).trim());
  }

  if (values.length === 0) return null;
  if (values.length !== 1 || !values[0]) {
    throw unauthenticated("Session Cookie 无效");
  }
  return values[0];
}

function readBearerToken(request: Request): { present: boolean; token: string | null } {
  const header = request.headers.get("Authorization");
  if (header === null) return { present: false, token: null };
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  return { present: true, token: match?.[1] ?? null };
}

export async function checkLoginRateLimit(
  env: CloudflareBindings,
  request: Request,
): Promise<void> {
  // RateLimit.limit() consumes one unit and exposes no read-only check. Keep
  // this as an intentional limit on every login request, successful or not,
  // instead of pretending it can count only failures.
  const ip = request.headers.get("CF-Connecting-IP")?.trim() || "unknown";
  const outcome = await env.LOGIN_RATE_LIMITER.limit({
    key: `${LOGIN_RATE_LIMIT_PREFIX}:${ip}`,
  });
  if (!outcome.success) throw rateLimited();
}

export async function loginAdmin(
  env: CloudflareBindings,
  request: Request,
  input: LoginInput,
): Promise<LoginResult> {
  await checkLoginRateLimit(env, request);
  const credential = await findAdminCredential(env.DB);
  const valid = credential.secret_hash === null
    ? await verifyAdminSecret(input.secret, env.ADMIN_LOGIN_SECRET)
    : await verifyAdminLoginHash(input.secret, credential.secret_hash, env.AUTH_PEPPER);
  if (!valid) {
    throw unauthenticated("管理员密钥无效");
  }
  return createAdminSession(env, credential.revision);
}

export async function createAdminSession(
  env: CloudflareBindings, credentialRevision: number, passkeyId?: string,
): Promise<LoginResult> {
  const createdAt = nowIso();
  const expiresAt = new Date(
    Date.parse(createdAt) + sessionTtlSeconds(env) * 1000,
  ).toISOString();
  const id = newEntityId("session");
  const secret = generateSecret();
  const tokenHash = await hashCredential("session", id, secret, env.AUTH_PEPPER);

  await deleteExpiredSessions(env.DB, createdAt);
  await insertSession(env.DB, {
    id,
    tokenHash,
    createdAt,
    expiresAt,
    credentialRevision,
    ...(passkeyId ? { passkeyId } : {}),
  });

  const token = formatSessionToken(id, secret);
  return {
    session: { authenticated: true, expires_at: expiresAt },
    cookie: buildSessionCookie(token, expiresAt),
  };
}

export async function authenticateBearer(
  env: CloudflareBindings,
  token: string,
): Promise<AgentActor> {
  const parsed = parseAgentKey(token);
  if (!parsed) throw unauthenticated("Agent 密钥无效");

  const row = await findKeyWithAgent(env.DB, parsed.id);
  const now = nowIso();
  if (
    !row ||
    row.revokedAt !== null ||
    isExpired(row.expiresAt, now) ||
    row.status === "removed" ||
    row.status === "deleting"
  ) {
    throw unauthenticated("Agent 密钥无效或已失效");
  }
  if (
    !(await verifyCredential(
      "agent",
      parsed.id,
      parsed.secret,
      row.secretHash,
      env.AUTH_PEPPER,
    ))
  ) {
    throw unauthenticated("Agent 密钥无效或已失效");
  }

  const touched = await touchKeyUsage(env.DB, parsed.id, now);
  if (!touched) throw unauthenticated("Agent 密钥已失效");

  const decoded = decodeAgentRole({
    scope: row.scope,
    accessMode: row.accessMode,
    readMode: row.readMode,
    permissionsRevision: row.permissionsRevision,
  });
  const base = { type: "agent", agentId: row.agentId, keyId: row.id, status: row.status } as const;
  return decoded.role === "reader"
    ? {
        ...base,
        role: "reader",
        readMode: decoded.readMode,
        permissionsRevision: decoded.permissionsRevision,
      }
    : { ...base, role: decoded.role };
}

export async function authenticateSession(
  env: CloudflareBindings,
  token: string,
): Promise<Extract<Actor, { type: "admin" }>> {
  const parsed = parseSessionToken(token);
  if (!parsed) throw unauthenticated("管理员 Session 无效");

  const row = await findSession(env.DB, parsed.id);
  const now = nowIso();
  if (!row || row.revokedAt !== null || isExpired(row.expiresAt, now)) {
    throw unauthenticated("管理员 Session 无效或已过期");
  }
  if (
    !(await verifyCredential(
      "session",
      parsed.id,
      parsed.secret,
      row.tokenHash,
      env.AUTH_PEPPER,
    ))
  ) {
    throw unauthenticated("管理员 Session 无效或已过期");
  }

  return { type: "admin", sessionId: row.id };
}

export async function authenticateRequest(
  request: Request,
  env: CloudflareBindings,
): Promise<Actor | null> {
  const bearer = readBearerToken(request);
  const sessionToken = readSessionCookie(request);

  if (bearer.present && sessionToken !== null) {
    throw unauthenticated("请求不能同时携带 Agent 密钥和管理员 Session");
  }
  if (bearer.present) {
    if (!bearer.token) throw unauthenticated("Authorization 请求头无效");
    return authenticateBearer(env, bearer.token);
  }
  if (sessionToken !== null) return authenticateSession(env, sessionToken);
  return null;
}

export function actorHasRole(actor: Actor, acceptedRoles: readonly IdentityRole[]): boolean {
  return acceptedRoles.includes(roleOf(actor));
}

export async function getAdminSession(ctx: ServiceContext): Promise<SessionDto> {
  requireAdminActor(ctx);
  const row = await findSession(ctx.env.DB, ctx.actor.sessionId);
  const now = nowIso();
  if (!row || row.revokedAt !== null || isExpired(row.expiresAt, now)) {
    throw unauthenticated("管理员 Session 无效或已过期");
  }
  return { authenticated: true, expires_at: row.expiresAt };
}

export async function logoutAdmin(ctx: ServiceContext): Promise<string> {
  requireAdminActor(ctx);
  await revokeSession(ctx.env.DB, ctx.actor.sessionId, nowIso());
  return clearSessionCookie();
}

export async function changeAdminSecret(
  ctx: ServiceContext, request: Request, input: ChangeAdminSecretInput,
): Promise<string> {
  requireAdminActor(ctx);
  await checkLoginRateLimit(ctx.env, request);
  const credential = await findAdminCredential(ctx.env.DB);
  const valid = credential.secret_hash === null
    ? await verifyAdminSecret(input.current_secret, ctx.env.ADMIN_LOGIN_SECRET)
    : await verifyAdminLoginHash(input.current_secret, credential.secret_hash, ctx.env.AUTH_PEPPER);
  if (!valid) throw forbidden("当前登录密钥不正确");
  if (input.new_secret.length < 32 || input.new_secret.length > 1024 || input.new_secret === input.current_secret) {
    throw badRequest("新密钥需为 32–1024 个字符，且不能与旧密钥相同");
  }
  const digest = await hashAdminLoginSecret(input.new_secret, ctx.env.AUTH_PEPPER);
  const changed = await rotateAdminCredential(ctx.env.DB, ctx.actor.sessionId, credential.revision, digest, nowIso());
  if (!changed) throw conflict("凭据或会话已变更，请重新登录");
  return clearSessionCookie();
}

export async function prepareAgentKey(
  env: CloudflareBindings,
  agentId: string,
  expiresAt: string | null = null,
  createdAt = nowIso(),
): Promise<PreparedAgentKey> {
  const normalizedExpiresAt = normalizeFutureExpiry(expiresAt, createdAt);
  const id = newEntityId("key");
  const rawSecret = generateSecret();
  const secretHash = await hashCredential("agent", id, rawSecret, env.AUTH_PEPPER);
  const record: AgentKeyInsert = {
    id,
    agentId,
    secretHash,
    createdAt,
    expiresAt: normalizedExpiresAt,
  };
  return {
    record,
    plaintext: {
      id,
      agent_id: agentId,
      secret: formatAgentKey(id, rawSecret),
      created_at: createdAt,
      expires_at: normalizedExpiresAt,
    },
    prepareInsert: (db) => prepareInsertKey(db, record),
  };
}

export async function issueAgentKey(
  ctx: ServiceContext,
  agentId: string,
  input: IssueKeyInput,
): Promise<IssuedKeyDto> {
  requireAdminActor(ctx);
  const target = await findAgentKeyTarget(ctx.env.DB, agentId);
  requireUsableKeyTarget(target);

  const expiresAt = input.expires_at ?? null;
  const prepared = await prepareAgentKey(ctx.env, agentId, expiresAt);
  await insertKey(ctx.env.DB, prepared.record);
  return prepared.plaintext;
}

export async function listAgentKeys(
  ctx: ServiceContext,
  agentId: string,
): Promise<AgentKeyMetadataDto[]> {
  requireAdminActor(ctx);
  const target = await findAgentKeyTarget(ctx.env.DB, agentId);
  if (!target) throw notFound("Agent 不存在");
  return listKeyMetadata(ctx.env.DB, agentId);
}

export async function revokeAgentKey(
  ctx: ServiceContext,
  agentId: string,
  keyId: string,
): Promise<void> {
  requireAdminActor(ctx);
  const keys = await listAgentKeys(ctx, agentId);
  const key = keys.find((item) => item.id === keyId);
  if (!key) throw notFound("密钥不存在");
  if (key.revoked_at !== null) return;
  await revokeKey(ctx.env.DB, agentId, keyId, nowIso());
}
