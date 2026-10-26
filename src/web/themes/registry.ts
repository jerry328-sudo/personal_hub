import type { SiteThemeId } from "../../shared/contracts";
import { SITE_THEME_NAMES } from "../../shared/site-theme";
import { theme as current } from "./current";
import { theme as template } from "./template";
import type { ThemeComponents } from "./types";

interface ThemeDefinition {
  name: string;
  description: string;
  components: ThemeComponents;
}

export const siteThemes: Record<SiteThemeId, ThemeDefinition> = {
  current: { name: SITE_THEME_NAMES.current, description: "现有的绿色信息工作台，列表与正文并排阅读。", components: current },
  template: { name: SITE_THEME_NAMES.template, description: "新的信息收件箱，独立阅读页面与更宽松的内容排版。", components: template },
};

export { isSiteThemeId } from "../../shared/site-theme";
