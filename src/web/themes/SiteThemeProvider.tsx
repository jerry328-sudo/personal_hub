import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import type { SiteThemeId, SiteThemeSettings } from "../../shared/contracts";
import { requestJson } from "../api";
import { ErrorState, LoadingState } from "../components/ui";
import { isSiteThemeId } from "./registry";

interface SiteThemeContextValue {
  themeId: SiteThemeId;
  saving: boolean;
  saveTheme: (theme: SiteThemeId) => Promise<void>;
}

const SiteThemeContext = createContext<SiteThemeContextValue | null>(null);

function checkedTheme(settings: SiteThemeSettings): SiteThemeId {
  if (!settings || !isSiteThemeId(settings.theme)) throw new Error("站点主题设置无效，请重试或联系管理员");
  return settings.theme;
}

export function SiteThemeProvider({ children }: { children: ReactNode }) {
  const [themeId, setThemeId] = useState<SiteThemeId>("current");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void requestJson<SiteThemeSettings>("/api/v1/ui-theme", { signal: controller.signal })
      .then((settings) => { if (!controller.signal.aborted) setThemeId(checkedTheme(settings)); })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "无法读取站点主题");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);

  useLayoutEffect(() => { document.documentElement.dataset.siteTheme = themeId; }, [themeId]);

  const saveTheme = useCallback(async (theme: SiteThemeId) => {
    setSaving(true);
    try {
      const settings = await requestJson<SiteThemeSettings>("/api/v1/admin/ui-theme", {
        method: "PUT",
        body: JSON.stringify({ theme }),
      });
      setThemeId(checkedTheme(settings));
    } finally {
      setSaving(false);
    }
  }, []);

  const value = useMemo(() => ({ themeId, saving, saveTheme }), [themeId, saving, saveTheme]);

  if (loading) return <div className="boot-screen"><LoadingState label="正在读取站点主题…" /></div>;
  if (error) return <div className="boot-screen"><ErrorState message={error} onRetry={() => setRevision((count) => count + 1)} /></div>;
  return <SiteThemeContext.Provider value={value}>{children}</SiteThemeContext.Provider>;
}

export function useSiteTheme(): SiteThemeContextValue {
  const value = useContext(SiteThemeContext);
  if (!value) throw new Error("useSiteTheme 必须在 SiteThemeProvider 中使用");
  return value;
}
