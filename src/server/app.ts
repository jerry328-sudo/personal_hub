import { Hono, type MiddlewareHandler } from "hono";
import type { AppEnv } from "./env";
import { requireIdentity } from "./modules/auth/middleware";
import { registerAuthRoutes } from "./modules/auth/routes";
import { registerTaskRoutes } from "./modules/tasks/routes";
import { registerEntryRoutes } from "./modules/entries/routes";
import { registerAttachmentRoutes } from "./modules/attachments/routes";
import { purgeAgentAttachmentsStep } from "./modules/attachments/service";
import { registerAgentRoutes } from "./modules/agents/routes";
import { registerDiscoveryRoutes } from "./discovery/routes";
import { applyPrivateHeaders, requestContext } from "./shared/http";
import { errorBody, normalizeError, notFound as notFoundError } from "./shared/errors";

const app = new Hono<AppEnv>();

app.use("*", requestContext());

const privateApiHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  applyPrivateHeaders(c.res.headers);
};

app.use("/api", privateApiHeaders);
app.use("/api/*", privateApiHeaders);

app.use("/api", requireIdentity());
app.use("/api/*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (c.req.method === "POST" && path === "/api/v1/auth/login") {
    await next();
    return;
  }
  await requireIdentity()(c, next);
});

registerAuthRoutes(app);
registerDiscoveryRoutes(app);
registerAgentRoutes(app, { purgeAttachmentsStep: purgeAgentAttachmentsStep });
registerEntryRoutes(app);
registerAttachmentRoutes(app);
registerTaskRoutes(app);

app.get("/api/health", (c) => c.json({ status: "ok" }));

app.notFound((c) => {
  const path = new URL(c.req.url).pathname;
  if (path === "/api" || path.startsWith("/api/")) {
    return c.json(errorBody(notFoundError("API 路径不存在"), c.get("requestId")), 404);
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
  return new Response(JSON.stringify(errorBody(error, requestId)), { status: error.status, headers });
});

export default app;
