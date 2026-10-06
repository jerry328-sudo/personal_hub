import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { OpenAIUiResourceMetadata } from "@openai/mcp-extensions/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PANEL_RESOURCE_URI } from "../../shared/panel";
import { serviceUnavailable } from "../shared/errors";

// Only public UI code is cached. Never retain a request, response, promise or user data.
let cachedPanelHtml: string | undefined;

async function panelHtml(env: Pick<CloudflareBindings, "ASSETS" | "APP_ORIGIN">): Promise<string> {
  if (cachedPanelHtml !== undefined) return cachedPanelHtml;
  // Assets normalizes HTML filenames to this extensionless URL.
  const response = await env.ASSETS.fetch(new Request(`${env.APP_ORIGIN}/plugin/panel`));
  if (!response.ok) throw serviceUnavailable("Hub 面板资源暂时不可用");
  const text = await response.text();
  // Reject the SPA fallback if the build omitted the panel asset.
  if (!text.includes('data-personal-hub-panel="v1"')) throw serviceUnavailable("Hub 面板资源尚未构建");
  cachedPanelHtml = text;
  return text;
}

export function registerPanelResource(server: McpServer, authorize: () => Promise<void>, env: Pick<CloudflareBindings, "ASSETS" | "APP_ORIGIN">): void {
  registerAppResource(server, "personal-hub-panel", PANEL_RESOURCE_URI, {
    title: "Personal Hub", description: "收件箱、来源、版本、待办与当前聊天引用。",
  }, async () => {
    await authorize();
    return { contents: [{
      uri: PANEL_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: await panelHtml(env),
      _meta: {
        ui: { csp: { connectDomains: [], resourceDomains: [] }, permissions: { clipboardWrite: {} }, prefersBorder: false },
        "openai/ui": {
          availableDisplayModes: ["fullscreen"], preferredDisplayMode: "fullscreen",
        } satisfies OpenAIUiResourceMetadata,
      },
    }] };
  });
}
