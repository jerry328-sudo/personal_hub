import { describe, expect, it } from "vitest";
import { SITE_THEME_IDS } from "../../src/shared/contracts";
import { isSiteThemeId, resolveSiteTheme, SITE_THEME_NAMES } from "../../src/shared/site-theme";

describe("shared interface themes", () => {
  it("uses the same theme identifiers and names for the website and panel", () => {
    expect(Object.keys(SITE_THEME_NAMES)).toEqual([...SITE_THEME_IDS]);
    for (const theme of SITE_THEME_IDS) {
      expect(isSiteThemeId(theme)).toBe(true);
      expect(resolveSiteTheme(theme)).toBe(theme);
    }
  });
  it("keeps old panel launch snapshots compatible without accepting arbitrary theme values", () => {
    for (const value of [undefined, null, "dark", "light", "system", "__proto__", "unknown", {}, 1]) {
      expect(isSiteThemeId(value)).toBe(false);
      expect(resolveSiteTheme(value)).toBe("current");
    }
  });
});
