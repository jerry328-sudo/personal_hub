import OAuthProvider, { AuthorizationError, CimdFetchError, OAuthError, type OAuthHelpers, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import type { Actor } from "../env";
import { authenticateBearer, authenticateRequest, checkLoginRateLimit } from "../modules/auth/service";
import { listAgents } from "../modules/agents/service";
import { badRequest, forbidden, normalizeError, payloadTooLarge, unauthenticated } from "../shared/errors";
import { applyPrivateHeaders, requireSameOrigin } from "../shared/http";
import { nowIso } from "../shared/ids";
import { createOAuthSession, MCP_SCOPES, principalFor, resolvePrincipal, scopesFor, type McpPrincipal } from "./identity";
import { handleMcp } from "./transport";

export type OAuthEnv = CloudflareBindings & { OAUTH_PROVIDER?: OAuthHelpers };
const scopeLabels: Record<string, string> = {
  "hub:read": "读取当前身份可访问的内容与待办",
  "hub:write": "创建和更新内容、待办及上报运行结果",
  "hub:admin": "管理 Agent、密钥和来源授权，以及管理员内容操作",
  offline_access: "允许客户端刷新令牌，最长 30 天",
};
export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
function html(body: string, headers = new Headers()): Response {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  applyPrivateHeaders(headers);
  return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Personal Hub · MCP 授权</title><style>body{font:16px/1.6 system-ui;background:#f3f5f8;color:#172033;margin:0;padding:24px}main{max-width:650px;margin:32px auto;background:white;border:1px solid #dce2eb;border-radius:16px;padding:28px}h1{font-size:26px}label{display:block;margin:16px 0}select,input[type=password]{box-sizing:border-box;width:100%;padding:12px;border:1px solid #bbc6d7;border-radius:8px}button{padding:10px 20px;margin:8px 8px 8px 0;border:1px solid #bbc6d7;border-radius:8px;background:#edf3ff;cursor:pointer}a{color:#245cca}small{color:#526178}code{overflow-wrap:anywhere}</style><main><a href="/">Personal Hub</a>${body}</main></html>`, { headers });
}
export function helpers(env: OAuthEnv): OAuthHelpers {
  if (!env.OAUTH_PROVIDER) throw new Error("OAuth helpers unavailable");
  return env.OAUTH_PROVIDER;
}
export async function boundedBody(request: Request, limit = 16384): Promise<string> {
  if (Number(request.headers.get("Content-Length")) > limit) throw payloadTooLarge();
  if (!request.body) return "";
  const reader = request.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) { await reader.cancel(); throw payloadTooLarge(); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

async function browserActor(request: Request, env: OAuthEnv): Promise<Actor | null> {
  const actor = await authenticateRequest(request, env);
  if (actor && actor.type !== "admin") throw forbidden("此页面需要管理员登录");
  return actor;
}

async function authorize(request: Request, env: OAuthEnv): Promise<Response> {
  const oauth = helpers(env);
  if (request.method === "GET") {
    const auth = await oauth.parseAuthRequest(request);
    if (!auth.codeChallenge || auth.codeChallengeMethod !== "S256") throw badRequest("必须使用 PKCE S256");
    const details = await oauth.describeConsent(auth);
    const actor = await browserActor(request, env);
    const consent = await oauth.beginConsent(auth);
    const requested = auth.scope.length ? auth.scope : ["hub:read"];
    if (requested.some((scope) => !Object.hasOwn(scopeLabels, scope))) throw badRequest("不支持的授权范围");
    const offered = [...new Set([...requested, ...MCP_SCOPES, "offline_access"])];
    const choices = actor ? (await listAgents({ env, actor, requestId: crypto.randomUUID() }, { status: "active", limit: 100 }, "admin")).items : [];
    const returnTo = `/oauth/authorize${new URL(request.url).search}`;
    return html(`<h1>授权 ${escapeHtml(details.clientName)}</h1>
      <p>${details.clientDomain ? `客户端域名：<strong>${escapeHtml(details.clientDomain)}</strong>` : "客户端名称由申请方自行声明，请确认是你正在连接的应用。"}</p>
      <p>授权结果将返回：<strong>${escapeHtml(details.redirectHost)}</strong></p>
      ${details.redirectIsLoopback ? "<p>这是本机应用的回调。仅在你刚刚发起连接时继续。</p>" : ""}
      <form method="post" action="/oauth/authorize"><input type="hidden" name="handle" value="${escapeHtml(consent.handle)}">
      ${actor ? `<label>以哪个身份授权<select name="identity"><option value="">请选择身份</option>${choices.filter((a) => a.id !== "manual").map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}（${escapeHtml(a.role)}）</option>`).join("")}<option value="__admin">管理员（可授予管理权限）</option></select></label><small>此处列出前 100 个启用身份；其他身份可使用其 Agent 密钥授权。</small>`
        : `<p><a href="/login?return_to=${encodeURIComponent(returnTo)}">使用现有管理员密钥或通行密钥登录</a>，然后选择授权身份。</p>`}
      <details><summary>使用已有 Agent 密钥授权</summary><label>Agent Key<input type="password" name="agent_key" maxlength="300" autocomplete="off"></label><small>只提交给 Personal Hub，权限不会超出此密钥所属身份。</small></details>
      <h2>允许访问的范围</h2><small>只读身份只能选择读取；管理权限仅可授予管理员身份。</small>${offered.map((scope) => `<label><input type="checkbox" name="scope" value="${escapeHtml(scope)}" ${scope !== "hub:admin" && requested.includes(scope) ? "checked" : ""}> ${escapeHtml(scopeLabels[scope] ?? scope)}</label>`).join("")}
      <button name="decision" value="approve">允许连接</button><button name="decision" value="deny">拒绝</button></form>`, consent.headers);
  }
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
  requireSameOrigin(request, env.APP_ORIGIN);
  if (!request.headers.get("Content-Type")?.startsWith("application/x-www-form-urlencoded")) throw badRequest("授权表单类型无效");
  const form = new URLSearchParams(await boundedBody(request));
  const handle = form.get("handle") ?? "";
  if (form.get("decision") === "deny") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  if (form.get("decision") !== "approve") throw badRequest("授权决定无效");
  const key = form.get("agent_key")?.trim();
  let actor: Actor; let principal: McpPrincipal;
  const selected = form.get("identity");
  if (key) {
    await checkLoginRateLimit(env, request);
    actor = await authenticateBearer(env, key);
    if (actor.status !== "active") throw unauthenticated();
    principal = principalFor(actor);
  } else {
    const admin = await browserActor(request, env);
    if (!admin || !selected) throw unauthenticated("请先登录并选择授权身份，或填写 Agent 密钥");
    // Validate the target before creating the dedicated OAuth session.
    const liveKey = selected === "__admin" ? null : await env.DB.prepare(`SELECT id FROM agent_keys
      WHERE agent_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY (expires_at IS NULL) DESC, created_at DESC, id DESC LIMIT 1`)
      .bind(selected, nowIso()).first<{ id: string }>();
    if (selected !== "__admin" && !liveKey) throw badRequest("此身份没有可用密钥，请先在 Agent 管理中签发密钥");
    const candidate: McpPrincipal = selected === "__admin" ? principalFor(admin)
      : { kind: "delegated", sessionId: admin.type === "admin" ? admin.sessionId : "", keyId: liveKey!.id };
    actor = await resolvePrincipal(env, candidate); principal = candidate;
  }
  const approvedScopes = [...new Set(form.getAll("scope"))];
  const permitted = [...scopesFor(actor), "offline_access"];
  if (!approvedScopes.some((s) => s !== "offline_access") || approvedScopes.some((s) => !permitted.includes(s))) throw forbidden("所选权限超出此身份的范围");
  const approval = await oauth.approveConsent(request, handle, { scope: approvedScopes });
  if (!key) {
    const admin = await browserActor(request, env);
    if (!admin) throw unauthenticated();
    const sessionId = await createOAuthSession(env, admin);
    principal = principal.kind === "delegated" ? { ...principal, sessionId } : { kind: "admin", sessionId };
  }
  const result = await oauth.completeAuthorization({
    request: approval.request, userId: actor.type === "admin" ? "admin" : `agent_${actor.agentId}`,
    metadata: { identity: actor.type === "admin" ? "admin" : actor.agentId },
    scope: approval.request.scope, props: principal,
  });
  approval.headers.set("Location", result.redirectTo);
  return new Response(null, { status: 302, headers: approval.headers });
}

async function connections(request: Request, env: OAuthEnv): Promise<Response> {
  const actor = await browserActor(request, env);
  if (!actor) return Response.redirect(`${env.APP_ORIGIN}/login?return_to=${encodeURIComponent("/oauth/connections")}`, 302);
  const oauth = helpers(env); const url = new URL(request.url);
  const userId = url.searchParams.get("user_id") ?? "admin";
  if (userId.length > 200 || (userId !== "admin" && !/^agent_[A-Za-z0-9_-]+$/.test(userId))) throw badRequest("身份无效");
  if (request.method === "POST") {
    requireSameOrigin(request, env.APP_ORIGIN);
    const form = new URLSearchParams(await boundedBody(request));
    const cookie = request.headers.get("Cookie")?.split(";").map((c) => c.trim()).find((c) => c.startsWith("__Host-ph_oauth_csrf="))?.split("=")[1];
    if (!cookie || form.get("csrf") !== cookie) throw forbidden("授权管理表单已失效");
    await oauth.revokeGrant(form.get("grant_id") ?? "", userId);
    return Response.redirect(`${env.APP_ORIGIN}/oauth/connections?user_id=${encodeURIComponent(userId)}`, 303);
  }
  if (request.method !== "GET") return new Response(null, { status: 405 });
  const grants = await oauth.listUserGrants(userId, { limit: 50, cursor: url.searchParams.get("cursor") ?? undefined });
  const csrf = crypto.randomUUID(); const headers = new Headers({ "Set-Cookie": `__Host-ph_oauth_csrf=${csrf}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=600` });
  return html(`<h1>MCP 客户端授权</h1><p>撤销连接不会影响原有 API 密钥或网页登录。</p><form method="get"><label>身份编号<input name="user_id" value="${escapeHtml(userId)}"></label><small>管理员填 admin，Agent 填 agent_加上其编号。</small><button>查看</button></form>
    ${grants.items.length ? grants.items.map((grant) => `<section><p>客户端：<code>${escapeHtml(grant.clientId)}</code><br>范围：${escapeHtml(grant.scope.join(", "))}</p><form method="post"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="grant_id" value="${escapeHtml(grant.id)}"><button>撤销此连接</button></form></section>`).join("") : "<p>此身份暂无授权。</p>"}
    ${grants.cursor ? `<a href="?user_id=${encodeURIComponent(userId)}&cursor=${encodeURIComponent(grants.cursor)}">下一页</a>` : ""}<p><a href="/admin/security">返回登录与安全</a></p>`, headers);
}

export function createOAuthOptions(env: CloudflareBindings): OAuthProviderOptions<OAuthEnv> {
  return {
    apiRoute: "/mcp", apiHandler: { fetch: handleMcp },
    defaultHandler: { async fetch(request, env) {
      const path = new URL(request.url).pathname;
      if (path === "/oauth/authorize") return authorize(request, env);
      if (path === "/oauth/connections") return connections(request, env);
      return new Response(null, { status: 404 });
    } },
    authorizeEndpoint: `${env.APP_ORIGIN}/oauth/authorize`, tokenEndpoint: `${env.APP_ORIGIN}/oauth/token`,
    clientRegistrationEndpoint: `${env.APP_ORIGIN}/oauth/register`,
    scopesSupported: [...MCP_SCOPES, "offline_access"], requiredScopes: ["hub:read"],
    resourceMetadata: { resource: `${env.APP_ORIGIN}/mcp`, authorization_servers: [env.APP_ORIGIN] },
    accessTokenTTL: 3600, refreshTokenTTL: 30 * 86400,
    clientIdMetadataDocumentEnabled: true,
    async tokenExchangeCallback({ props, env }) {
      try { await resolvePrincipal(env, props); }
      catch (error) {
        const normalized = normalizeError(error);
        if (normalized.status === 401 || normalized.status === 403) throw new OAuthError("invalid_grant", { description: "身份已失效，请重新授权" });
        throw error;
      }
    },
  };
}
export function createOAuthProvider(env: CloudflareBindings): OAuthProvider<OAuthEnv> {
  return new OAuthProvider(createOAuthOptions(env));
}

export function oauthErrorResponse(error: unknown): Response {
  if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
  const normalized = error instanceof AuthorizationError || error instanceof CimdFetchError
    ? badRequest("授权请求无效或已过期，请重新发起连接") : normalizeError(error);
  const headers = new Headers(normalized.headers); applyPrivateHeaders(headers);
  return Response.json({ error: { code: normalized.code, message: normalized.message } }, { status: normalized.status, headers });
}
