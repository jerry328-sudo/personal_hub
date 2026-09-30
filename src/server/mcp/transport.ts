import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { Actor } from "../env";
import { authenticateBearer } from "../modules/auth/service";
import { applyPrivateHeaders } from "../shared/http";
import { enforceReaderRateLimit } from "../shared/reader-rate-limit";
import { forbidden, normalizeError, unauthenticated } from "../shared/errors";
import { recordReaderAccess } from "../shared/access-log";
import { createMcpServer } from "./tools";
import { principalFor, principalSchema, resolvePrincipal, scopesFor, type McpPrincipal } from "./identity";
import type { OAuthEnv } from "./oauth";

export async function handleMcp(request: Request, env: OAuthEnv, execution: ExecutionContext & { auth?: unknown }): Promise<Response> {
  let actor: Actor;
  let scopes: string[];
  let principal: McpPrincipal;
  const bearer = /^Bearer ([^\s]+)$/i.exec(request.headers.get("Authorization") ?? "")?.[1];
  if (!bearer) throw unauthenticated();
  // Existing Agent keys are intentionally separate from OAuth tokens, with no Cookie fallback.
  if (bearer.startsWith("phk.")) {
    actor = await authenticateBearer(env, bearer); scopes = scopesFor(actor); principal = principalFor(actor);
  } else {
    principal = principalSchema.parse(execution.props);
    actor = await resolvePrincipal(env, principal);
    const auth = z.object({ scope: z.array(z.string()) }).passthrough().parse(execution.auth);
    scopes = auth.scope;
  }
  const requestId = crypto.randomUUID();
  let status = 500; let code = "internal_error";
  let server: ReturnType<typeof createMcpServer> | undefined;
  try {
    await enforceReaderRateLimit(env, actor);
    server = createMcpServer({ env, actor, requestId }, scopes, env.OAUTH_PROVIDER, principal, request);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 15 * 1024 * 1024,
    });
    await server.connect(transport);
    const response = await transport.handleRequest(request, { authInfo: {
      token: bearer, clientId: "personal-hub", scopes, extra: { principal },
    } });
    status = response.status; code = status >= 400 ? "mcp_transport_error" : "ok";
    applyPrivateHeaders(response.headers);
    return response;
  } catch (error) {
    const normalized = normalizeError(error); status = normalized.status; code = normalized.code;
    throw error;
  } finally {
    if (server) await server.close();
    if (actor.type === "agent" && actor.role === "reader") recordReaderAccess({
      requestId, readerAgentId: actor.agentId, keyId: actor.keyId, method: request.method,
      route: "/mcp", status, code, permissionsRevision: actor.permissionsRevision,
    });
  }
}

export function checkMcpOrigin(request: Request, env: CloudflareBindings): void {
  const origin = request.headers.get("Origin");
  if (new URL(request.url).origin !== env.APP_ORIGIN || (origin !== null && origin !== env.APP_ORIGIN)) throw forbidden("MCP 请求来源不受信任");
}
export function mcpErrorResponse(error: unknown, env: CloudflareBindings): Response {
  const normalized = normalizeError(error);
  const headers = new Headers(normalized.headers); applyPrivateHeaders(headers);
  if (normalized.status === 401) headers.set("WWW-Authenticate", `Bearer resource_metadata="${env.APP_ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="hub:read"`);
  return Response.json({ error: { code: normalized.code, message: normalized.message } }, { status: normalized.status, headers });
}
