import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AgentDto, EntryFullDto, EntryVersionDto, TaskDto } from "../../src/shared/contracts";
import type { PanelSnapshot } from "../../src/shared/panel";
import { HUB_ICONS } from "../../src/shared/hub-icon";

// A local test host, never included in the plugin or Worker build. No production connection.
const readonly = new URLSearchParams(location.search).get("role") === "reader";
const source: AgentDto = { id: "paper", name: "论文进展", description: "论文修改与研究记录", role: "agent", status: "active", deleting_at: null,
  display_mode: "report", main_entry_id: "e2", created_at: "2026-10-05T01:40:00Z", last_report_at: null, last_result: null, last_note: null, read_mode: null, read_source_count: null };
const sources = [source, { ...source, id: "manual", name: "手动记录", display_mode: "list" as const, description: "随手记录与行动清单" }];
const entries: EntryFullDto[] = Array.from({ length: 57 }, (_, index) => ({ id: `e${index + 1}`, agent_id: "paper", created_at: "2026-10-04T01:00:00Z", version: index === 0 ? 2 : 1,
  title: index === 0 ? "铅酸电池稿件：讨论部分修订" : `研究记录 ${String(index + 1).padStart(2, "0")}`,
  content: index === 0 ? "## 本轮更新\n\n整理讨论部分的论证顺序，明确已完成的修改与仍待确认的问题。\n\n## 已完成\n\n- 调整退化路径的论证顺序\n- 统一正文与图注中的术语\n\n## 下一步\n\n1. 核对实验数据与结论是否对应\n2. 补充局限性与适用范围\n3. 整理下一轮讨论的问题" : `这是一条研究记录，用于检查分页、搜索和来源展示。编号 ${index + 1}。`,
  url: null, important: index === 0, updated_at: "2026-10-05T01:40:00Z", created_by_agent_id: "paper", archived: false, read_version: 0, completed: false, completed_at: null }));
entries.push({ ...entries[0]!, id: "archived-source", title: "已归档记录", archived: true });
const baseTask: TaskDto = { id: "t1", agent_id: "paper", entry_id: "e1", title: "核对讨论部分的实验依据", due_at: null, done: false, created_at: "2026-10-05T01:00:00Z" };
let tasks: TaskDto[] = [baseTask, { ...baseTask, id: "t2", entry_id: "e2", title: "整理下一轮讨论的问题" },
  { ...baseTask, id: "t3", agent_id: "manual", entry_id: null, title: "整理参考文献" },
  ...Array.from({ length: 13 }, (_, i) => ({ ...baseTask, id: `done-${i}`, title: `已完成事项 ${i + 1}`, done: true })),
  ...Array.from({ length: 21 }, (_, i) => ({ ...baseTask, id: `archived-${i}`, entry_id: "archived-source", title: `归档关联事项 ${i + 1}` }))];
// Simulate the one-time database migration before the new UI is served.
tasks = tasks.filter((task) => !entries.some((entry) => entry.id === task.entry_id && entry.archived));
const identity: PanelSnapshot["identity"] = { role: readonly ? "reader" : "manager", agent_id: "hubadmin", can_write: !readonly, can_manage_entries: !readonly, can_manage_sources: !readonly };
const frame = document.querySelector<HTMLIFrameElement>("#panel")!;
const sidebarIcon = document.querySelector<HTMLImageElement>("#sidebar-icon");
if (sidebarIcon) sidebarIcon.src = HUB_ICONS.find((icon) => icon.theme === (new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light"))!.src;
const counter = document.querySelector("#context-count")!;
const status = document.querySelector("#test-status")!;
const calls: string[] = [];
const ok = (result: unknown): CallToolResult => ({ content: [], structuredContent: { result } });
const fail = (message: string): CallToolResult => ({ isError: true, content: [], structuredContent: { result: { error: { code: "not_found", message } } } });
function snapshot(): PanelSnapshot {
  const inbox = entries.filter((item) => !item.archived);
  return { identity, app_origin: "https://personal-hub.echem.ai", sources: { items: sources, next_cursor: null },
    entries: { items: inbox.slice(0, 50), next_cursor: inbox.length > 50 ? "50" : null }, entry: inbox[0] ?? null };
}
function versionOf(entry: EntryFullDto, version: number): EntryVersionDto {
  return { entry_id: entry.id, version, created_by_agent_id: "paper", title: entry.title,
    content: version === entry.version ? entry.content : "## 初始记录\n\n整理讨论部分的提纲。", important: entry.important,
    created_at: entry.updated_at, url: null, state: { archived: entry.archived, read_version: entry.read_version, completed: entry.completed, completed_at: null } };
}
const bridge = new AppBridge(null, { name: "Personal Hub QA host", version: "1.0.0" }, {
  serverTools: {}, updateModelContext: { text: {}, structuredContent: {} }, openLinks: {}, experimental: { "openai/modelContext": {} },
}, { hostContext: { theme: new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light", displayMode: "fullscreen", availableDisplayModes: ["fullscreen"], containerDimensions: { height: frame.clientHeight, width: frame.clientWidth } } });
const dimensions = new ResizeObserver(() => { bridge.setHostContext({ containerDimensions: { height: frame.clientHeight, width: frame.clientWidth } }); });
dimensions.observe(frame);
document.querySelector("#safe-area")?.addEventListener("click", () => { bridge.setHostContext({ safeAreaInsets: { top: 12, right: 8, bottom: 64, left: 8 } }); });
bridge.oncalltool = async ({ name, arguments: args = {} }) => {
  calls.push(name); status.textContent = `测试宿主 · 已调用 ${calls.length} 次 · ${name}`;
  if (readonly && ["update_entry_state", "create_task", "update_task", "delete_task", "clear_completed_tasks", "update_agent", "set_agent_status"].includes(name)) return fail("当前身份只读");
  const entry = entries.find((item) => item.id === args.id);
  if (name === "open_hub_panel") return { content: [], _meta: { personalHub: snapshot() } };
  if (name === "list_agents") return ok({ items: sources, next_cursor: null });
  if (name === "list_entries") {
    const filtered = entries.filter((item) => item.archived === (args.archived === "yes") && (!args.agent_id || item.agent_id === args.agent_id)
      && (!args.query || `${item.title} ${item.content}`.includes(String(args.query))) && (args.read !== "unread" || item.version > item.read_version) && (args.important !== "yes" || item.important));
    const offset = Number(args.cursor ?? 0); const limit = Number(args.limit ?? 50);
    return ok({ items: filtered.slice(offset, offset + limit), next_cursor: offset + limit < filtered.length ? String(offset + limit) : null });
  }
  if (name === "get_entry") return entry ? ok(entry) : fail("条目不存在");
  if (name === "get_entry_version") return entry && Number(args.version) <= entry.version ? ok(versionOf(entry, Number(args.version))) : fail("版本不存在");
  if (name === "list_entry_versions") return entry ? ok({ items: Array.from({ length: entry.version }, (_, index) => versionOf(entry, entry.version - index)), next_cursor: null }) : fail("条目不存在");
  if (name === "update_entry_state") {
    if (!entry) return fail("条目不存在"); Object.assign(entry, args.state);
    if (entry.archived) tasks = tasks.filter((task) => task.entry_id !== entry.id);
    return ok(entry);
  }
  if (name === "list_tasks") {
    const filtered = tasks.filter((task) => (args.done === "yes" ? task.done : args.done === "no" ? !task.done : true)
      && (!args.agent_id || task.agent_id === args.agent_id));
    const offset = Number(args.cursor ?? 0); const limit = Number(args.limit ?? 100);
    return ok({ items: filtered.slice(offset, offset + limit), next_cursor: offset + limit < filtered.length ? String(offset + limit) : null });
  }
  if (name === "clear_completed_tasks") {
    const matches = (task: TaskDto) => task.done && (!args.agent_id || task.agent_id === args.agent_id);
    const count = tasks.filter(matches).length;
    if (new URLSearchParams(location.search).has("fail_clear")) return fail("D1 quota failure fixture");
    tasks = tasks.filter((task) => !matches(task)); return ok({ cleared: count });
  }
  if (name === "create_task") {
    if (entries.some((item) => item.id === args.entry_id && item.archived)) return fail("已归档记录不能创建关联待办");
    if (!sources.some((item) => item.id === args.agent_id && item.status === "active")) return fail("待办来源不存在或不可写");
    const task: TaskDto = { id: `t${tasks.length + 1}`, title: String(args.title), agent_id: String(args.agent_id), entry_id: args.entry_id ? String(args.entry_id) : null,
      due_at: args.due_at ? String(args.due_at) : null, done: false, created_at: new Date().toISOString() };
    tasks.push(task); return ok(task);
  }
  if (name === "update_task") { const task = tasks.find((item) => item.id === args.id); if (!task) return fail("待办不存在"); Object.assign(task, args.task); return ok(task); }
  if (name === "delete_task") { tasks = tasks.filter((task) => task.id !== args.id); return ok({ success: true }); }
  if (name === "update_agent") { const target = sources.find((item) => item.id === args.id); if (target) Object.assign(target, args.agent); return ok(target); }
  if (name === "set_agent_status") { const target = sources.find((item) => item.id === args.id); if (target) target.status = args.action === "disable" ? "disabled" : "active"; return ok(target); }
  return fail(`未实现的测试调用：${name}`);
};
bridge.onupdatemodelcontext = async (params) => {
  const count = params.content?.length ?? 0; counter.textContent = `聊天引用 ${count} 条`;
  document.querySelector("#context-text")!.textContent = JSON.stringify(params);
  const context = { ...params, updateId: crypto.randomUUID() };
  bridge.setHostContext({ "openai/modelContext": context });
  return { _meta: { "openai/modelContext": { updateId: context.updateId } } };
};
bridge.onopenlink = async () => ({ isError: false });
bridge.oninitialized = () => { void bridge.sendToolInput({ arguments: {} }).then(() => bridge.sendToolResult({ content: [], _meta: { personalHub: snapshot() } })); };
document.querySelector("#remove-context")!.addEventListener("click", () => { counter.textContent = "聊天引用 0 条"; bridge.setHostContext({ "openai/modelContext": null }); });
await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
frame.src = "/panel.html";
