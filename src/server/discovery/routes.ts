import type { Hono } from "hono";
import type { AppContext, AppEnv } from "../env";
import { requireIdentity } from "../modules/auth/middleware";
import { getFullApiDocs, getQuickStart } from "./content";

function setDiscoveryHeaders(c: AppContext): void {
  c.header("Cache-Control", "private, no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Content-Language", "zh-CN");
}

export function registerDiscoveryRoutes(app: Hono<AppEnv>): void {
  app.get("/api", requireIdentity(), (c) => {
    setDiscoveryHeaders(c);
    return c.json(getQuickStart(c.get("actor")));
  });

  app.get("/api/docs", requireIdentity(), (c) => {
    setDiscoveryHeaders(c);
    return c.text(getFullApiDocs(c.get("actor")));
  });
}
