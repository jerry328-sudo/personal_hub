import { z } from "zod";
import { LIMITS, utf8Size } from "./limits";

const nullableHttpUrl = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "仅支持 http 或 https 地址").nullable().optional();

const isoDateTime = z.string().datetime({ offset: true });

const readAccessShape = z.object({
  mode: z.enum(["selected", "all"]),
  agent_ids: z.array(z.string().min(1).max(200)).max(LIMITS.maxReadTargets).optional().default([]),
}).strict().refine(
  (value) => value.mode === "all" ? (value.agent_ids?.length ?? 0) === 0 : true,
  { message: "mode 为 all 时不能提交 agent_ids", path: ["agent_ids"] },
);

export const createAgentSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.agentNameCharacters),
  description: z.string().trim().max(LIMITS.agentDescriptionCharacters).optional().default(""),
  scope: z.enum(["own", "all"]).optional(),
  role: z.enum(["agent", "manager", "reader"]).optional(),
  read_access: readAccessShape.optional(),
  display_mode: z.enum(["feed", "list", "report"]).optional().default("feed"),
  key_expires_at: isoDateTime.nullable().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.role !== undefined && value.scope !== undefined) {
    ctx.addIssue({ code: "custom", message: "role 与 scope 不能同时提交", path: ["role"] });
    return;
  }
  if (value.read_access !== undefined && value.role !== "reader") {
    ctx.addIssue({ code: "custom", message: "只有只读身份可以提交 read_access", path: ["read_access"] });
    return;
  }
  if (value.role === "reader") {
    if (value.read_access === undefined) {
      ctx.addIssue({ code: "custom", message: "只读身份必须提供 read_access", path: ["read_access"] });
      return;
    }
    if (value.read_access.mode === "selected" && (value.read_access.agent_ids?.length ?? 0) === 0) {
      ctx.addIssue({ code: "custom", message: "新建只读身份至少选择一个来源", path: ["read_access", "agent_ids"] });
    }
  }
});

export const updateReadAccessSchema = z.object({
  base_revision: z.number().int().nonnegative(),
  mode: z.enum(["selected", "all"]),
  agent_ids: z.array(z.string().min(1).max(200)).max(LIMITS.maxReadTargets).optional().default([]),
}).strict().refine(
  (value) => value.mode === "all" ? (value.agent_ids?.length ?? 0) === 0 : true,
  { message: "mode 为 all 时不能提交 agent_ids", path: ["agent_ids"] },
);

export const updateAgentSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.agentNameCharacters).optional(),
  description: z.string().trim().max(LIMITS.agentDescriptionCharacters).optional(),
  display_mode: z.enum(["feed", "list", "report"]).optional(),
  main_entry_id: z.string().min(1).nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "至少提供一个字段");

const entryContent = {
  title: z.string().trim().min(1).max(LIMITS.titleCharacters),
  content: z.string().min(1).refine((value) => utf8Size(value) <= LIMITS.markdownBytes, "正文过大"),
  url: nullableHttpUrl,
  important: z.boolean().optional().default(false),
};

export const createEntrySchema = z.object(entryContent).strict();
export const appendVersionSchema = z.object({
  ...entryContent,
  base_version: z.number().int().positive(),
}).strict();

export const patchEntryStateSchema = z.object({
  archived: z.boolean().optional(),
  read_version: z.number().int().nonnegative().optional(),
  completed: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "至少提供一个状态字段");

export const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(LIMITS.taskTitleCharacters),
  entry_id: z.string().min(1).nullable().optional(),
  agent_id: z.string().min(1).optional(),
  due_at: isoDateTime.nullable().optional(),
}).strict();

export const patchTaskSchema = z.object({
  title: z.string().trim().min(1).max(LIMITS.taskTitleCharacters).optional(),
  due_at: isoDateTime.nullable().optional(),
  done: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "至少提供一个字段");

export const reportSchema = z.object({
  result: z.enum(["success", "failed"]),
  note: z.string().trim().max(LIMITS.reportNoteCharacters).nullable().optional(),
}).strict();

export const issueKeySchema = z.object({
  expires_at: isoDateTime.nullable().optional(),
}).strict();

export const loginSchema = z.object({
  secret: z.string().min(1).max(1024),
}).strict();

export const changeAdminSecretSchema = z.object({
  current_secret: z.string().min(1).max(1024),
  new_secret: z.string().min(32).max(1024),
}).strict().refine((value) => value.current_secret !== value.new_secret, "新密钥不能与旧密钥相同");

const entryQueryObject = z.object({
  agent_id: z.string().min(1).optional(),
  view: z.enum(["brief", "full"]).optional(),
  completion: z.enum(["all", "open", "done"]).optional(),
  archived: z.enum(["all", "yes", "no"]).optional(),
  important: z.enum(["all", "yes", "no"]).optional(),
  order: z.enum(["id_asc", "updated_desc", "created_asc"]).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.maxPageSize).optional(),
  query: z.string().trim().max(200).optional(),
  read: z.enum(["all", "unread", "updated", "read"]).optional(),
  start: isoDateTime.optional(),
  end: isoDateTime.optional(),
  time_field: z.enum(["updated", "created", "archived", "completed"]).optional(),
}).strict();

const validTimeRange = (value: { start?: string; end?: string }) => !value.start || !value.end || Date.parse(value.start) < Date.parse(value.end);
export const entryQuerySchema = entryQueryObject.refine(validTimeRange, "开始时间必须早于结束时间");

// Bulk actions accept filters only; a page cursor must never narrow their scope.
export const markReadQuerySchema = entryQueryObject.omit({ cursor: true, limit: true, view: true, order: true }).refine(validTimeRange, "开始时间必须早于结束时间");

export const taskQuerySchema = z.object({
  agent_id: z.string().min(1).optional(),
  done: z.enum(["all", "yes", "no"]).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.maxPageSize).optional(),
}).strict();

export type EntryQuery = z.infer<typeof entryQuerySchema>;
export type TaskQuery = z.infer<typeof taskQuerySchema>;
