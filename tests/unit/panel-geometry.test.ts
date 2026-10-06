import { describe, expect, it } from "vitest";
import { panelGeometry } from "../../src/panel/geometry";

describe("MCP panel surface geometry", () => {
  it("fills fixed host heights, including panels shorter than the previous 480px minimum", () => {
    const result = panelGeometry({ containerDimensions: { width: 620, height: 360 } });
    expect(result.height).toBe(360);
    expect(result.styles["--hub-height"]).toBe("360px");
  });
  it("fills a host-provided maximum height when there is no fixed height", () => {
    expect(panelGeometry({ containerDimensions: { maxWidth: 1496, maxHeight: 1051 } }).height).toBe(1051);
  });
  it("falls back to the iframe viewport when no usable host height is supplied", () => {
    for (const height of [0, -10, Infinity, NaN]) {
      expect(panelGeometry({ containerDimensions: { width: 620, height } }).styles["--hub-height"]).toBe("100dvh");
    }
    expect(panelGeometry(undefined).height).toBeUndefined();
  });
  it("reserves all host safe areas and clears them on a later context without insets", () => {
    expect(panelGeometry({ safeAreaInsets: { top: 10, right: 8, bottom: 64, left: 6 } }).styles)
      .toMatchObject({ "--hub-safe-top": "10px", "--hub-safe-right": "8px", "--hub-safe-bottom": "64px", "--hub-safe-left": "6px" });
    expect(panelGeometry({}).styles["--hub-safe-bottom"]).toBe("0px");
  });
});
