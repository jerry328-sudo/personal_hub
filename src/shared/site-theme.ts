import { SITE_THEME_IDS, type SiteThemeId } from "./contracts";

export const SITE_THEME_NAMES: Record<SiteThemeId, string> = {
  current: "经典主题",
  template: "简洁主题",
};

export function isSiteThemeId(value: unknown): value is SiteThemeId {
  return typeof value === "string" && SITE_THEME_IDS.some((theme) => theme === value);
}

export function resolveSiteTheme(value: unknown): SiteThemeId {
  return isSiteThemeId(value) ? value : "current";
}
