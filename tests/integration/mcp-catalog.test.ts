import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Actor } from "../../src/server/env";
import { createMcpServer } from "../../src/server/mcp/tools";
import { entryQuerySchema, createEntrySchema } from "../../src/shared/validation";
import { HUB_ICONS } from "../../src/shared/hub-icon";

const readTools = ["open_hub_panel", "get_identity", "get_api_documentation", "list_agents", "list_entries", "get_entry",
  "list_entry_versions", "get_entry_version", "list_tasks", "get_image"];
const writeTools = ["create_entry", "append_entry_version", "create_task", "update_task", "delete_task", "clear_completed_tasks", "upload_image"];
const managementWriteTools = ["mark_entries_read", "update_entry_state", "delete_entry"];
const adminTools = ["create_agent", "update_agent", "set_agent_status", "purge_agent", "list_agent_keys", "issue_agent_key",
  "revoke_agent_key", "get_read_access", "set_read_access", "list_passkeys", "revoke_passkey", "change_admin_secret"];
const oauthTools = ["list_oauth_grants", "revoke_oauth_grant"];
const allScopes = ["hub:read", "hub:write", "hub:admin"];
const oauth: Pick<OAuthHelpers, "listUserGrants" | "revokeGrant"> = {
  async listUserGrants() { throw new Error("Discovery must not call OAuth operations"); },
  async revokeGrant() { throw new Error("Discovery must not call OAuth operations"); },
};

function actor(role: "admin" | "agent" | "manager" | "reader"): Actor {
  if (role === "admin") return { type: "admin", sessionId: "test-session" };
  const base = { type: "agent" as const, agentId: `test-${role}`, keyId: `key-${role}`, status: "active" as const };
  return role === "reader" ? { ...base, role, readMode: "selected", permissionsRevision: 1 } : { ...base, role };
}

async function discover(server: McpServer) {
  const client = new Client({ name: "catalog-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  try {
    await client.connect(clientTransport);
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

function server(role: Parameters<typeof actor>[0], scopes: readonly string[], origin = env.APP_ORIGIN, withOAuth = true) {
  return createMcpServer({ env: { ...env, APP_ORIGIN: origin }, actor: actor(role), requestId: crypto.randomUUID() },
    scopes, withOAuth ? oauth as OAuthHelpers : undefined);
}

describe("MCP static discovery catalog", () => {
  it("advertises icons at initialization as well as on the panel tool", async () => {
    const instance = server("manager", allScopes);
    const client = new Client({ name: "sidebar-branding-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await instance.connect(serverTransport);
    try {
      await client.connect(clientTransport);
      expect(client.getServerVersion()).toMatchObject({ name: "personal-hub", title: "Personal Hub", icons: HUB_ICONS });
    } finally { await client.close(); await instance.close(); }
  });
  it.each([
    { role: "reader" as const, scopes: allScopes, withOAuth: true, expected: readTools },
    { role: "agent" as const, scopes: allScopes, withOAuth: true, expected: [...readTools, ...writeTools, "report_run"] },
    { role: "manager" as const, scopes: ["hub:read"], withOAuth: true, expected: [...readTools, "get_entry_counts"] },
    { role: "manager" as const, scopes: ["hub:write"], withOAuth: true, expected: [...readTools, ...writeTools, "report_run", "get_entry_counts", ...managementWriteTools] },
    { role: "manager" as const, scopes: ["hub:admin"], withOAuth: true, expected: [...readTools, ...writeTools, "report_run", "get_entry_counts", ...managementWriteTools, ...adminTools, ...oauthTools] },
    { role: "admin" as const, scopes: allScopes, withOAuth: true, expected: [...readTools, ...writeTools, "get_entry_counts", ...managementWriteTools, ...adminTools, ...oauthTools] },
    { role: "manager" as const, scopes: allScopes, withOAuth: false, expected: [...readTools, ...writeTools, "report_run", "get_entry_counts", ...managementWriteTools, ...adminTools] },
  ])("keeps $role tools restricted to granted scopes and available OAuth helpers", async ({ role, scopes, withOAuth, expected }) => {
    const tools = await discover(server(role, scopes, env.APP_ORIGIN, withOAuth));
    expect(tools.map((tool) => tool.name).sort()).toEqual([...expected].sort());
  });

  it("keeps theme-aware branding available without external image fetches across roles and origins", async () => {
    const manager = await discover(server("manager", allScopes, "http://localhost:5173"));
    const reader = await discover(server("reader", ["hub:read"], "https://personal-hub.echem.ai"));
    const first = manager.find((tool) => tool.name === "open_hub_panel")!;
    const second = reader.find((tool) => tool.name === "open_hub_panel")!;
    expect(first.icons).toEqual(HUB_ICONS);
    expect(second.icons).toEqual(HUB_ICONS);
    expect(second.icons?.map((icon) => icon.theme)).toEqual(["light", "dark"]);
    for (const icon of second.icons!) {
      expect(icon.src).toMatch(/^data:image\/svg\+xml,/);
      const svg = decodeURIComponent(icon.src.split(",")[1]!);
      expect(svg).toContain('width="48" height="48"');
      expect(svg).not.toContain("currentColor");
    }
    expect(second._meta).toEqual(first._meta);
    expect(second.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    expect(second.execution).toEqual({ taskSupport: "forbidden" });
    expect(reader.some((tool) => tool.name === "create_agent")).toBe(false);
    expect(manager.find((tool) => tool.name === "delete_entry")?.annotations?.destructiveHint).toBe(true);
  });

  it("advertises the same input schema as SDK discovery for coercion, defaults and nested refinements", async () => {
    const reference = new McpServer({ name: "sdk-control", version: "1" });
    reference.registerTool("list_entries", { inputSchema: entryQuerySchema }, async () => ({ content: [] }));
    reference.registerTool("create_entry", { inputSchema: createEntrySchema }, async () => ({ content: [] }));
    const sdkTools = await discover(reference);
    const tools = await discover(server("agent", allScopes));
    expect(tools.find((tool) => tool.name === "list_entries")?.inputSchema)
      .toEqual(sdkTools.find((tool) => tool.name === "list_entries")?.inputSchema);
    const nestedEntrySchema = { ...sdkTools.find((tool) => tool.name === "create_entry")!.inputSchema };
    delete nestedEntrySchema.$schema;
    expect(tools.find((tool) => tool.name === "create_entry")?.inputSchema.properties?.entry)
      .toEqual(nestedEntrySchema);
  });
});
