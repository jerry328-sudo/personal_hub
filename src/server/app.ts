import { Hono, type MiddlewareHandler } from "hono";
import type { AppEnv } from "./env";
import { requireApiIdentity, requireReaderPathAccess } from "./modules/auth/middleware";
import { registerAuthRoutes } from "./modules/auth/routes";
import { registerPasskeyRoutes } from "./modules/auth/passkeys";
import { registerTaskRoutes } from "./modules/tasks/routes";
import { registerEntryRoutes } from "./modules/entries/routes";
import { registerAttachmentRoutes } from "./modules/attachments/routes";
import { purgeAgentAttachmentsStep } from "./modules/attachments/service";
import { registerAgentRoutes } from "./modules/agents/routes";
import { registerReaderRoutes } from "./modules/readers/routes";
import { registerDiscoveryRoutes } from "./discovery/routes";
import { applyPrivateHeaders, requestContext } from "./shared/http";
import { readerAccessLogMiddleware } from "./shared/access-log";
import { readerRateLimitMiddleware } from "./shared/reader-rate-limit";
import { errorBody, normalizeError, notFound as notFoundError } from "./shared/errors";

const app = new Hono<AppEnv>();

app.use("*", requestContext());

const privateApiHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  applyPrivateHeaders(c.res.headers);
};

app.use("/api", privateApiHeaders);
app.use("/api/*", privateApiHeaders);

const UNGATED_LOGIN_PATHS = [
  "/api/v1/auth/login",
  "/api/v1/auth/passkeys/login/options",
  "/api/v1/auth/passkeys/login/verify",
];

function isUngatedLogin(c: Parameters<MiddlewareHandler<AppEnv>>[0]): boolean {
  if (c.req.method !== "POST") return false;
  return UNGATED_LOGIN_PATHS.includes(new URL(c.req.url).pathname);
}

// 访问日志必须在网关之外，这样“路径被拒绝”也会被记录；
// 日志读取已认证身份以及 Hono 处理后的响应和错误。
app.use("/api", readerAccessLogMiddleware());
app.use("/api/*", readerAccessLogMiddleware());

// 认证 → reader 限流 → 路径准入；被拒绝的路径也消耗身份额度。
app.use("/api", requireApiIdentity());
app.use("/api/*", async (c, next) => {
  if (isUngatedLogin(c)) {
    await next();
    return;
  }
  await requireApiIdentity()(c, next);
});

app.use("/api", readerRateLimitMiddleware());
app.use("/api/*", readerRateLimitMiddleware());
app.use("/api", requireReaderPathAccess());
app.use("/api/*", requireReaderPathAccess());

registerAuthRoutes(app);
registerPasskeyRoutes(app);
registerDiscoveryRoutes(app);
registerAgentRoutes(app, { purgeAttachmentsStep: purgeAgentAttachmentsStep });
registerReaderRoutes(app);
registerEntryRoutes(app);
registerAttachmentRoutes(app);
registerTaskRoutes(app);

app.get("/api/health", (c) => c.json({ status: "ok" }));

app.notFound((c) => {
  const path = new URL(c.req.url).pathname;
  if (path === "/api" || path.startsWith("/api/")) {
    throw notFoundError("API 路径不存在");
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((rawError, c) => {
  const error = normalizeError(rawError);
  const requestId = c.get("requestId") || crypto.randomUUID();
  console.error(JSON.stringify({
    level: "error",
    request_id: requestId,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    code: error.code,
    status: error.status,
  }));
  const headers = new Headers({ "Content-Type": "application/json; charset=UTF-8" });
  applyPrivateHeaders(headers);
  for (const [name, value] of Object.entries(error.headers ?? {})) headers.set(name, value);
  return new Response(JSON.stringify(errorBody(error, requestId)), { status: error.status, headers });
});

export default app;
