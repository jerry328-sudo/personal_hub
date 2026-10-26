import { describe, expect, it } from "vitest";
import { isSiteThemeId, siteThemes } from "../../src/web/themes/registry";

describe("site theme registry", () => {
  it("provides the required page entry points for both persisted choices", () => {
    for (const id of ["current", "template"] as const) {
      expect(isSiteThemeId(id)).toBe(true);
      const { components } = siteThemes[id];
      for (const page of ["AppShell", "InboxPage", "AgentPage", "EntryPage"] as const) {
        expect(typeof components[page]).toBe("function");
      }
    }
  });

  it.each([undefined, null, "", "unknown", "__proto__", "constructor", "toString", {}, ["current"]])("rejects non-registered settings %j", (value) => {
    expect(isSiteThemeId(value)).toBe(false);
  });
});
