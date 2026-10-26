import type { SiteThemeSettings } from "../../../shared/contracts";
import { resolveSiteTheme } from "../../../shared/site-theme";

export async function getSiteTheme(db: D1Database): Promise<SiteThemeSettings> {
  const row = await db.prepare("SELECT theme FROM site_settings WHERE id = 1").first<{ theme: string }>();
  return { theme: resolveSiteTheme(row?.theme) };
}
