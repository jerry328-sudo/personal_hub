import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";

export function panelGeometry(context: McpUiHostContext | undefined) {
  const dimensions = context?.containerDimensions;
  const availableHeight = dimensions && ('height' in dimensions ? dimensions.height : dimensions.maxHeight);
  const height = typeof availableHeight === "number" && Number.isFinite(availableHeight) && availableHeight > 0
    ? Math.round(availableHeight) : undefined;
  const styles: Record<string, string> = { "--hub-height": height ? `${height}px` : "100dvh" };
  for (const side of ["top", "right", "bottom", "left"] as const) {
    const inset = context?.safeAreaInsets?.[side];
    styles[`--hub-safe-${side}`] = typeof inset === "number" && Number.isFinite(inset) && inset > 0 ? `${inset}px` : "0px";
  }
  return { height, styles };
}
