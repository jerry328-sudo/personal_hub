(() => {
  const prefersDark = () => matchMedia("(prefers-color-scheme: dark)").matches;
  let theme = prefersDark() ? "dark" : "light";
  try {
    const saved = localStorage.getItem("personal-hub-theme");
    if (saved === "light" || saved === "dark") theme = saved;
  } catch {
    // Storage can be unavailable in hardened browser contexts.
  }
  document.documentElement.dataset.theme = theme;
  const themeColor = document.querySelector('meta[name="theme-color"]');
  themeColor?.setAttribute("content", theme === "dark" ? "#101412" : "#ffffff");
})();
