import app from "./app";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { boundedBody, createOAuthOptions, createOAuthProvider, oauthErrorResponse, type OAuthEnv } from "./mcp/oauth";
import { checkMcpOrigin, handleMcp, mcpErrorResponse } from "./mcp/transport";
import { serviceUnavailable } from "./shared/errors";

export default {
  async fetch(request: Request, env: CloudflareBindings, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    const isMcp = path === "/mcp";
    const isOAuth = path === "/oauth" || path.startsWith("/oauth/")
      || path.startsWith("/.well-known/oauth-");
    // Existing routes retain their exact authentication and request handling.
    if (!isMcp && !isOAuth) return app.fetch(request, env, ctx);
    try {
      if (isMcp) {
        checkMcpOrigin(request, env);
        if (/^Bearer phk\./i.test(request.headers.get("Authorization") ?? "")) {
          const oauthEnv: OAuthEnv = { ...env };
          if (env.OAUTH_KV) oauthEnv.OAUTH_PROVIDER = getOAuthApi(createOAuthOptions(env), oauthEnv);
          return await handleMcp(request, oauthEnv, ctx);
        }
      }
      if (!env.OAUTH_KV) throw serviceUnavailable("OAuth 存储尚未配置");
      if (isOAuth && request.method === "POST" && path !== "/oauth/authorize" && path !== "/oauth/connections") {
        const outcome = await env.LOGIN_RATE_LIMITER.limit({ key: `oauth:${request.headers.get("CF-Connecting-IP") ?? "unknown"}` });
        if (!outcome.success) return new Response(null, { status: 429, headers: { "Retry-After": "60" } });
        request = new Request(request, { body: await boundedBody(request) });
      }
      return await createOAuthProvider(env).fetch(request, { ...env }, ctx);
    } catch (error) { return isMcp ? mcpErrorResponse(error, env) : oauthErrorResponse(error); }
  },
} satisfies ExportedHandler<CloudflareBindings>;
