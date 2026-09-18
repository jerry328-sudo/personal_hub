import { Hono } from "hono";
import { z } from "zod";
import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type { PasskeyDto } from "../../../shared/contracts";
import type { AppContext, AppEnv } from "../../env";
import { badRequest, conflict, forbidden, notFound, unauthenticated } from "../../shared/errors";
import { readLimitedJson, requireSameOrigin } from "../../shared/http";
import { newEntityId, nowIso } from "../../shared/ids";
import { generateSecret, verifyAdminLoginHash, verifyAdminSecret } from "./crypto";
import { requireAdminSession } from "./middleware";
import { findAdminCredential } from "./repository";
import { checkLoginRateLimit, createAdminSession } from "./service";

const COOKIE = "__Host-ph_webauthn";
const TTL = 300;
const ALGORITHMS = [-7, -257]; // ES256 and RS256: Windows Hello and mobile passkeys.
const MAX_KEYS = 20;
type Challenge = {
  challenge: string; credential_revision: number; name: string | null; user_handle: string | null;
};
type PasskeyRow = PasskeyDto & {
  credential_id: string; public_key: string; user_handle: string; counter: number;
};
const base64 = z.string().min(1).max(65536).regex(/^[A-Za-z0-9_-]+$/);
const responseBase = {
  id: base64.max(2048), rawId: base64.max(2048), type: z.literal("public-key"),
  clientExtensionResults: z.object({}).passthrough(),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
};
const registrationSchema = z.object({
  ...responseBase,
  response: z.object({ clientDataJSON: base64, attestationObject: base64 }),
});
const authenticationSchema = z.object({
  ...responseBase,
  response: z.object({ clientDataJSON: base64, authenticatorData: base64, signature: base64, userHandle: base64.optional() }),
});
const registerSchema = z.object({ name: z.string().trim().min(1).max(80), secret: z.string().min(1).max(1024) });

function origin(c: AppContext): void {
  try { requireSameOrigin(c.req.raw, c.env.APP_ORIGIN); }
  catch { throw forbidden("请求来源不受信任"); }
}
async function input<T>(c: AppContext, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await readLimitedJson(c.req.raw, 96 * 1024));
  if (!parsed.success) throw badRequest("通行密钥请求格式无效");
  return parsed.data;
}
function sessionId(c: AppContext): string {
  const actor = c.get("actor");
  if (actor.type !== "admin") throw forbidden();
  return actor.sessionId;
}
function challengeCookie(id: string, maxAge = TTL): string {
  return `${COOKIE}=${id}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}
async function saveChallenge(c: AppContext, kind: "register" | "login", challenge: string,
  revision: number, name: string | null = null, userHandle: string | null = null): Promise<void> {
  const id = generateSecret();
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM webauthn_challenges WHERE expires_at <= ?").bind(now),
    c.env.DB.prepare(`INSERT INTO webauthn_challenges
      (id, challenge, kind, session_id, credential_revision, name, user_handle, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, challenge, kind, kind === "register" ? sessionId(c) : null,
      revision, name, userHandle, new Date(Date.parse(now) + TTL * 1000).toISOString()),
  ]);
  c.header("Set-Cookie", challengeCookie(id), { append: true });
}
async function consumeChallenge(c: AppContext, kind: "register" | "login"): Promise<Challenge> {
  const values = (c.req.header("Cookie") ?? "").split(";").map(s => s.trim()).filter(s => s.startsWith(`${COOKIE}=`));
  const id = values.length === 1 ? values[0]!.slice(COOKIE.length + 1) : "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(id)) throw badRequest("验证请求已失效，请重新尝试");
  // DELETE RETURNING makes challenges single-use, including concurrent attempts.
  const row = await c.env.DB.prepare(`DELETE FROM webauthn_challenges
    WHERE id = ? AND kind = ? AND expires_at > ? AND session_id IS ?
    AND credential_revision = (SELECT revision FROM admin_credentials WHERE id = 1)
    RETURNING challenge, credential_revision, name, user_handle`)
    .bind(id, kind, nowIso(), kind === "register" ? sessionId(c) : null).first<Challenge>();
  if (!row) throw badRequest("验证请求已失效，请重新尝试");
  c.header("Set-Cookie", challengeCookie("", 0), { append: true });
  return row;
}

export function registerPasskeyRoutes(app: Hono<AppEnv>): void {
  app.get("/api/v1/auth/passkeys", requireAdminSession(), async c => {
    const rows = await c.env.DB.prepare(`SELECT id, name, created_at, last_used_at FROM admin_passkeys
      WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT ?`).bind(MAX_KEYS).all<PasskeyDto>();
    return c.json({ items: rows.results });
  });

  app.post("/api/v1/auth/passkeys/register/options", requireAdminSession(), async c => {
    origin(c);
    await checkLoginRateLimit(c.env, c.req.raw);
    const body = await input(c, registerSchema);
    const admin = await findAdminCredential(c.env.DB);
    const valid = admin.secret_hash === null
      ? await verifyAdminSecret(body.secret, c.env.ADMIN_LOGIN_SECRET)
      : await verifyAdminLoginHash(body.secret, admin.secret_hash, c.env.AUTH_PEPPER);
    if (!valid) throw forbidden("管理员密钥不正确");
    const keys = await c.env.DB.prepare("SELECT credential_id FROM admin_passkeys WHERE revoked_at IS NULL LIMIT ?")
      .bind(MAX_KEYS).all<{ credential_id: string }>();
    if (keys.results.length >= MAX_KEYS) throw conflict("最多绑定 20 个通行密钥，请先移除不用的绑定");
    const user = await c.env.DB.prepare("SELECT webauthn_user_id FROM admin_credentials WHERE id = 1")
      .first<{ webauthn_user_id: string }>();
    if (!user?.webauthn_user_id) throw new Error("通行密钥数据库未迁移");
    const options = await generateRegistrationOptions({
      rpName: "Personal Hub", rpID: new URL(c.env.APP_ORIGIN).hostname,
      userName: "admin", userDisplayName: "Personal Hub 管理员",
      userID: new TextEncoder().encode(user.webauthn_user_id),
      attestationType: "none", timeout: TTL * 1000, supportedAlgorithmIDs: ALGORITHMS,
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      excludeCredentials: keys.results.map(k => ({ id: k.credential_id })),
    });
    await saveChallenge(c, "register", options.challenge, admin.revision, body.name, options.user.id);
    return c.json(options);
  });

  app.post("/api/v1/auth/passkeys/register/verify", requireAdminSession(), async c => {
    origin(c);
    const response = await input(c, registrationSchema);
    const challenge = await consumeChallenge(c, "register");
    let verification;
    try {
      verification = await verifyRegistrationResponse({ response, expectedChallenge: challenge.challenge,
        expectedOrigin: c.env.APP_ORIGIN, expectedRPID: new URL(c.env.APP_ORIGIN).hostname,
        requireUserVerification: true, supportedAlgorithmIDs: ALGORITHMS });
    } catch { throw badRequest("通行密钥验证失败，请重新绑定"); }
    if (!verification.verified || !verification.registrationInfo) throw badRequest("通行密钥验证失败");
    const key = verification.registrationInfo.credential;
    const id = newEntityId("passkey");
    const now = nowIso();
    const inserted = await c.env.DB.prepare(`INSERT INTO admin_passkeys
      (id, credential_id, public_key, user_handle, counter, name, created_at, credential_revision)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM admin_sessions s JOIN admin_credentials a ON a.id = 1
        WHERE s.id = ? AND s.revoked_at IS NULL AND s.expires_at > ?
        AND s.credential_revision = a.revision AND a.revision = ?
        AND (s.passkey_id IS NULL OR EXISTS (SELECT 1 FROM admin_passkeys p WHERE p.id = s.passkey_id AND p.revoked_at IS NULL))
      ) AND (SELECT count(*) FROM admin_passkeys WHERE revoked_at IS NULL) < ?
      ON CONFLICT(credential_id) DO NOTHING RETURNING id`)
      .bind(id, key.id, isoBase64URL.fromBuffer(key.publicKey), challenge.user_handle, key.counter,
        challenge.name, now, challenge.credential_revision, sessionId(c), now, challenge.credential_revision, MAX_KEYS).first();
    if (!inserted) throw conflict("绑定未保存：凭据可能已绑定，或登录状态已变化，请刷新后重试");
    return c.json({ id }, 201);
  });

  app.post("/api/v1/auth/passkeys/login/options", async c => {
    origin(c);
    await checkLoginRateLimit(c.env, c.req.raw);
    const admin = await findAdminCredential(c.env.DB);
    const options = await generateAuthenticationOptions({
      rpID: new URL(c.env.APP_ORIGIN).hostname, timeout: TTL * 1000, userVerification: "required",
    });
    await saveChallenge(c, "login", options.challenge, admin.revision);
    return c.json(options);
  });

  app.post("/api/v1/auth/passkeys/login/verify", async c => {
    origin(c);
    await checkLoginRateLimit(c.env, c.req.raw);
    const response = await input(c, authenticationSchema);
    const challenge = await consumeChallenge(c, "login");
    const key = await c.env.DB.prepare("SELECT * FROM admin_passkeys WHERE credential_id = ? AND revoked_at IS NULL")
      .bind(response.id).first<PasskeyRow>();
    if (!key || response.response.userHandle !== key.user_handle) throw unauthenticated("通行密钥未绑定或已被移除");
    let verification;
    try {
      verification = await verifyAuthenticationResponse({ response, expectedChallenge: challenge.challenge,
        expectedOrigin: c.env.APP_ORIGIN, expectedRPID: new URL(c.env.APP_ORIGIN).hostname,
        requireUserVerification: true,
        credential: { id: key.credential_id, publicKey: isoBase64URL.toBuffer(key.public_key), counter: key.counter },
      });
    } catch { throw unauthenticated("通行密钥验证失败，请重新登录"); }
    if (!verification.verified) throw unauthenticated("通行密钥验证失败");
    const updated = await c.env.DB.prepare(`UPDATE admin_passkeys SET counter = ?, last_used_at = ?
      WHERE id = ? AND counter = ? AND revoked_at IS NULL
      AND (SELECT revision FROM admin_credentials WHERE id = 1) = ? RETURNING id`)
      .bind(verification.authenticationInfo.newCounter, nowIso(), key.id, key.counter, challenge.credential_revision).first();
    if (!updated) throw unauthenticated("通行密钥状态已变化，请重新登录");
    const result = await createAdminSession(c.env, challenge.credential_revision, key.id);
    c.header("Set-Cookie", result.cookie, { append: true });
    return c.json(result.session);
  });

  app.delete("/api/v1/auth/passkeys/:id", requireAdminSession(), async c => {
    origin(c);
    const key = await c.env.DB.prepare("UPDATE admin_passkeys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL RETURNING id")
      .bind(nowIso(), c.req.param("id")).first();
    if (!key) throw notFound("通行密钥不存在或已移除");
    return c.body(null, 204);
  });
}
