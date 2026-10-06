import type { Icon } from "@modelcontextprotocol/sdk/types.js";

// Standalone images cannot inherit currentColor from the host's sidebar.
// Embed both themes so displaying the icon needs no separate network request.
const glyph = "M14.4 10.8h19.2M14.4 19.2h19.2M7.2 25.2v9.6a4.8 4.8 0 0 0 4.8 4.8h24a4.8 4.8 0 0 0 4.8-4.8v-9.6";
export const HUB_ICONS: Icon[] = ([['light', '#303234'], ['dark', '#e5e5e5']] as const).map(([theme, stroke]) => ({
  src: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="${stroke}" stroke-width="3.192" stroke-linecap="round" stroke-linejoin="round"><path d="${glyph}"/></svg>`)}`,
  mimeType: "image/svg+xml", sizes: ["48x48"], theme,
}));
