/** Only local OAuth pages may resume after browser login. */
export function oauthReturnPath(search: string, origin: string): string | null {
  const target = new URLSearchParams(search).get("return_to");
  if (!target || !target.startsWith("/") || target.startsWith("//") || target.includes("\\")) return null;
  try {
    const url = new URL(target, origin);
    return url.origin === origin && ["/oauth/authorize", "/oauth/connections"].includes(url.pathname) && !url.hash
      ? `${url.pathname}${url.search}` : null;
  } catch { return null; }
}
