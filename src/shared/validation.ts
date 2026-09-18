import { z } from "zod";
import { LIMITS, utf8Size } from "./limits";

const nullableHttpUrl = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "仅支持 http 或 https 地址").nullable().optional();

const isoDateTime = z.string().datetime({ offset: true });

export const createAgentSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.agentNameCharacters),
  description: z.string().trim().max(LIMITS.agentDescriptionCharacters).optional().default(""),
  scope: z.enum(["own", "all"]).optional().default("own"),
  display_mode: z.enum(["feed", "list", "report"]).optional().default("feed"),
  key_expires_at: isoDateTime.nullable().optional(),
}).strict();

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
