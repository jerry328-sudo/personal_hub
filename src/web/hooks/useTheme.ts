import { useCallback, useEffect, useState } from "react";
import {
  applyTheme,
  readThemePreference,
  resolveTheme,
  saveThemePreference,
  type ResolvedTheme,
  type ThemeMode,
} from "../lib/theme";

export interface ThemeState {
  mode: ThemeMode;
  resolvedTheme: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
}

export function useTheme(): ThemeState {
  const [mode, setModeState] = useState<ThemeMode>(() => readThemePreference());
  const [prefersDark, setPrefersDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  const resolvedTheme = resolveTheme(mode, prefersDark);

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => applyTheme(resolvedTheme), [resolvedTheme]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    saveThemePreference(next);
  }, []);

  return { mode, resolvedTheme, setMode };
}
