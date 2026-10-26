import { useState } from "react";
import type { SiteThemeId } from "../../shared/contracts";
import { useToast } from "../components/ui";
import { siteThemes } from "./registry";
import { useSiteTheme } from "./SiteThemeProvider";

export function ThemeSettings() {
  const { themeId, saving, saveTheme } = useSiteTheme();
  const { showToast } = useToast();
  const [error, setError] = useState<string | null>(null);

  const changeTheme = async (theme: SiteThemeId) => {
    if (theme === themeId || saving) return;
    setError(null);
    try {
      await saveTheme(theme);
      showToast("站点主题已保存，其他已打开的页面刷新后生效");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "主题保存失败，请重试");
    }
  };

  return <section className="security-card site-theme-settings" aria-labelledby="site-theme-title">
    <h2 id="site-theme-title">站点主题</h2>
    <p>统一设置所有设备使用的界面。其他已打开的页面手动刷新后生效，日间与夜间外观仍按本机选择。</p>
    <label className="field">当前主题
      <select aria-label="站点主题" value={themeId} disabled={saving} onChange={(event) => void changeTheme(event.target.value as SiteThemeId)}>
        {Object.entries(siteThemes).map(([id, theme]) => <option key={id} value={id}>{theme.name}</option>)}
      </select>
      <small>{siteThemes[themeId].description}</small>
    </label>
    {saving ? <p role="status">正在保存主题…</p> : null}
    {error ? <p className="security-error" role="alert">{error}</p> : null}
  </section>;
}
