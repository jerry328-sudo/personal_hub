export type AgentScope = "own" | "all";
export type AgentStatus = "active" | "disabled" | "removed" | "deleting";
export type DisplayMode = "feed" | "list" | "report";
export type RunResult = "success" | "failed";
export type CompletionFilter = "all" | "open" | "done";

/** 对外角色。`scope` 只是数据库分区表示，业务与前端一律按 role 判断。 */
export type AgentRole = "agent" | "manager" | "reader";
export type AgentAccessMode = "read_write" | "read_only";
export type AgentReadMode = "selected" | "all";

export interface AgentDto {
  id: string;
  name: string;
  description: string;
  role: AgentRole;
  status: AgentStatus;
  deleting_at: string | null;
  display_mode: DisplayMode;
  main_entry_id: string | null;
  created_at: string;
  last_report_at: string | null;
  last_result: RunResult | null;
  last_note: string | null;
  /** 仅只读身份有意义；其他角色恒为 null。 */
  read_mode: AgentReadMode | null;
  /** 只读身份的已授权来源数量（不含 all 模式的隐式范围）；其他角色为 null。 */
  read_source_count: number | null;
}

/** 创建只读身份时的读取范围输入。all 与非空 agent_ids 互斥。 */
export interface ReadAccessInput {
  mode: AgentReadMode;
  agent_ids?: string[];
}

/** 管理员读取授权配置时的授权目标摘要。 */
export interface ReadAccessSourceDto {
  id: string;
  name: string;
  status: AgentStatus;
}

export interface ReadAccessDto {
  agent_id: string;
  mode: AgentReadMode;
  revision: number;
  sources: ReadAccessSourceDto[];
}

export interface UpdateReadAccessInput {
  base_revision: number;
  mode: AgentReadMode;
  agent_ids?: string[];
}

/** 只读身份自述。字段为固定白名单，不暴露密钥或全站身份列表。 */
export interface ReaderSelfDto {
  id: string;
  name: string;
  description: string;
  role: "reader";
  mode: AgentReadMode;
  permissions_revision: number;
}

/** 只读身份可访问的来源。字段为固定白名单，排除运行备注与管理字段。 */
export interface ReaderSourceDto {
  id: string;
  name: string;
  description: string;
  display_mode: DisplayMode;
  status: AgentStatus;
  main_entry_id: string | null;
}

export interface EntryStateDto {
  archived: boolean;
  archived_at?: string | null;
  read_version: number;
  completed: boolean;
  completed_at: string | null;
}

export interface EntryBriefDto extends EntryStateDto {
  id: string;
  agent_id: string;
  created_at: string;
  version: number;
  title: string;
  important: boolean;
  updated_at: string;
  created_by_agent_id: string;
}

export interface EntryFullDto extends EntryBriefDto {
  content: string;
  url: string | null;
}

export interface EntryVersionDto {
  entry_id: string;
  version: number;
  created_by_agent_id: string;
  title: string;
  content: string;
  url: string | null;
  important: boolean;
  created_at: string;
  state: EntryStateDto;
}

export interface EntryVersionBriefDto {
  entry_id: string;
  version: number;
  title: string;
  important: boolean;
  created_by_agent_id: string;
  created_at: string;
}

export interface TaskDto {
  id: string;
  agent_id: string;
  entry_id: string | null;
  title: string;
  done: boolean;
  due_at: string | null;
  created_at: string;
}

export interface AttachmentDto {
  id: string;
  agent_id: string;
  url: string;
  filename: string;
  content_type: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  size: number;
  created_at: string;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    request_id: string;
    details?: unknown;
  };
}

export interface CreateEntryInput {
  title: string;
  content: string;
  url?: string | null;
  important?: boolean;
}

export interface AppendVersionInput extends CreateEntryInput {
  base_version: number;
}

export interface PatchEntryStateInput {
  archived?: boolean;
  read_version?: number;
  completed?: boolean;
}

export interface CreateTaskInput {
  title: string;
  entry_id?: string | null;
  agent_id?: string;
  due_at?: string | null;
}

export interface PatchTaskInput {
  title?: string;
  due_at?: string | null;
  done?: boolean;
}

export interface CreateAgentInput {
  name: string;
  description?: string;
  /** 旧字段，仅接受普通/总管；新请求应改用 role。 */
  scope?: AgentScope;
  role?: AgentRole;
  read_access?: ReadAccessInput;
  display_mode?: DisplayMode;
  key_expires_at?: string | null;
}

export interface UpdateAgentInput {
  name?: string;
  description?: string;
  display_mode?: DisplayMode;
  main_entry_id?: string | null;
}

export interface ReportInput {
  result: RunResult;
  note?: string | null;
}

export interface IssuedKeyDto {
  id: string;
  agent_id: string;
  secret: string;
  created_at: string;
  expires_at: string | null;
}

export interface AgentKeyMetadataDto {
  id: string;
  agent_id: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
}

export interface SessionDto {
  authenticated: true;
  expires_at: string;
}

export interface PasskeyDto {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

export interface ChangeAdminSecretInput {
  current_secret: string;
  new_secret: string;
}

export interface PurgeProgressDto {
  agent_id: string;
  status: "pending" | "done";
  removed_objects: number;
  remaining_objects: number;
}
