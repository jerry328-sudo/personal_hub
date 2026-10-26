import type { Hono } from "hono";
import { z } from "zod";
import { SITE_THEME_IDS } from "../../../shared/contracts";
import { LIMITS } from "../../../shared/limits";
import type { AppEnv } from "../../env";
import { badRequest } from "../../shared/errors";
import { readLimitedJson, requireSameOrigin } from "../../shared/http";
import { requireAdminSession } from "../auth/middleware";
import { getSiteTheme } from "./service";

const siteThemeSchema = z.object({ theme: z.enum(SITE_THEME_IDS) }).strict();

export function registerSettingsRoutes(app: Hono<AppEnv>): void {
  app.get("/api/v1/ui-theme", async (c) => {
    return c.json(await getSiteTheme(c.env.DB));
  });

  app.put("/api/v1/admin/ui-theme", requireAdminSession(), async (c) => {
    requireSameOrigin(c.req.raw, c.env.APP_ORIGIN);
    const input = siteThemeSchema.safeParse(await readLimitedJson(c.req.raw, LIMITS.jsonRequestBytes));
    if (!input.success) throw badRequest("界面主题无效");
    await c.env.DB.prepare("INSERT INTO site_settings (id, theme) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET theme = excluded.theme")
      .bind(input.data.theme).run();
    return c.json(input.data);
  });
}
