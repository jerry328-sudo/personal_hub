import type { SiteThemeId } from "../../shared/contracts";
import { theme as current } from "./current";
import { theme as template } from "./template";
import type { ThemeComponents } from "./types";

interface ThemeDefinition {
  name: string;
  description: string;
  components: ThemeComponents;
}

export const siteThemes: Record<SiteThemeId, ThemeDefinition> = {
  current: { name: "经典主题", description: "现有的绿色信息工作台，列表与正文并排阅读。", components: current },
  template: { name: "简洁主题", description: "新的信息收件箱，独立阅读页面与更宽松的内容排版。", components: template },
};

export function isSiteThemeId(value: unknown): value is SiteThemeId {
  return typeof value === "string" && Object.hasOwn(siteThemes, value);
}
