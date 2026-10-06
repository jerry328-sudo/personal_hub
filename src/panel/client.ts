import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import { OpenAIExtensions } from "@openai/mcp-extensions/app";
import type { CallToolResult, ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import type { PanelSnapshot } from "../shared/panel";
import { panelGeometry } from "./geometry";

export const app = new App({ name: "personal-hub-panel", version: "0.1.0" }, { availableDisplayModes: ["fullscreen"] }, { autoResize: false });
export const extensions = new OpenAIExtensions(app);

export function unwrap<T>(result: CallToolResult): T {
  const data = result.structuredContent?.result;
  if (result.isError) {
    const error = data as { error?: { message?: string } } | undefined;
    throw new Error(error?.error?.message ?? "操作失败，请刷新后重试。");
  }
  return data as T;
}

export async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  return unwrap<T>(await app.callServerTool({ name, arguments: args }));
}

function snapshotOf(result: CallToolResult): PanelSnapshot | null {
  const data = result._meta?.personalHub as PanelSnapshot | undefined;
  return data?.identity && Array.isArray(data.sources?.items) && Array.isArray(data.entries?.items) ? data : null;
}

let initialResolve: (snapshot: PanelSnapshot) => void;
let initialReject: (error: Error) => void;
const initial = new Promise<PanelSnapshot>((resolve, reject) => { initialResolve = resolve; initialReject = reject; });
void initial.catch(() => undefined);
app.ontoolresult = (result) => {
  const snapshot = snapshotOf(result);
  if (snapshot) initialResolve(snapshot);
  else initialReject(new Error("Hub 未返回面板数据，请重新打开面板。"));
};
app.ontoolcancelled = () => { initialReject(new Error("打开面板已取消。")); };

let reportedHeight: number | undefined;
function applyHostContext() {
  const context = app.getHostContext();
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
  const geometry = panelGeometry(context);
  for (const [property, value] of Object.entries(geometry.styles)) document.documentElement.style.setProperty(property, value);
  if (geometry.height && geometry.height !== reportedHeight) {
    reportedHeight = geometry.height;
    void app.sendSizeChanged({ height: geometry.height }).catch(() => { reportedHeight = undefined; });
  }
}
app.addEventListener("hostcontextchanged", applyHostContext);

export async function connect(): Promise<PanelSnapshot> {
  // Subscribe before connecting so the entrypoint's launch result is not lost.
  const connected = app.connect();
  await connected;
  applyHostContext();
  const context = app.getHostContext();
  if (context?.displayMode !== "fullscreen" && context?.availableDisplayModes?.includes("fullscreen")) {
    await app.requestDisplayMode({ mode: "fullscreen" }).catch(() => undefined);
  }
  return initial;
}

export async function attachContext(content: ContentBlock[], records: { id: string; version: number }[]): Promise<void> {
  if (extensions.modelContext) await extensions.modelContext.update({ content, structuredContent: { records } });
  else if (app.getHostCapabilities()?.updateModelContext) await app.updateModelContext({ content, structuredContent: { records } });
  else throw new Error("当前宿主暂不支持引用附件，可以使用复制引用。");
}

export async function clearContext(): Promise<void> {
  if (extensions.modelContext) await extensions.modelContext.update({ content: [], structuredContent: { records: [] } });
  else if (app.getHostCapabilities()?.updateModelContext) await app.updateModelContext({ content: [], structuredContent: { records: [] } });
}
