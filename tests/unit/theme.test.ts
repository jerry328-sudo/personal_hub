import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyTheme,
  readThemePreference,
  resolveTheme,
  saveThemePreference,
  THEME_STORAGE_KEY,
} from "../../src/web/lib/theme";

function memoryStorage(initial?: string) {
  let value: string | null = initial ?? null;
  return {
    getItem: vi.fn((key: string) => key === THEME_STORAGE_KEY ? value : null),
    setItem: vi.fn((key: string, next: string) => {
      if (key === THEME_STORAGE_KEY) value = next;
    }),
    removeItem: vi.fn((key: string) => {
      if (key === THEME_STORAGE_KEY) value = null;
    }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("theme preference", () => {
  it.each([
    ["light", "light"],
    ["dark", "dark"],
    ["system", "system"],
    ["unexpected", "system"],
  ] as const)("reads %s as %s", (stored, expected) => {
    vi.stubGlobal("localStorage", memoryStorage(stored));
    expect(readThemePreference()).toBe(expected);
  });

  it("falls back to system when storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
    });
    expect(readThemePreference()).toBe("system");
  });

  it("stores explicit modes and removes the key for system mode", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);

    saveThemePreference("dark");
    expect(storage.setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, "dark");
    expect(readThemePreference()).toBe("dark");

    saveThemePreference("system");
    expect(storage.removeItem).toHaveBeenCalledWith(THEME_STORAGE_KEY);
    expect(readThemePreference()).toBe("system");
  });

  it("does not throw when saving is blocked", () => {
    vi.stubGlobal("localStorage", {
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    });

    expect(() => saveThemePreference("light")).not.toThrow();
    expect(() => saveThemePreference("system")).not.toThrow();
  });
});

describe("theme resolution and application", () => {
  it("honors explicit modes and resolves system mode from the media query", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("applies the theme data attribute used by the stylesheet", () => {
    const documentElement = { dataset: {} as Record<string, string> };
    vi.stubGlobal("document", { documentElement });

    applyTheme("dark");

    expect(documentElement.dataset.theme).toBe("dark");
  });
});
