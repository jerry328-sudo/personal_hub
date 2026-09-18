export type AgentScope = "own" | "all";
export type AgentStatus = "active" | "disabled" | "removed" | "deleting";
export type DisplayMode = "feed" | "list" | "report";
export type RunResult = "success" | "failed";
export type CompletionFilter = "all" | "open" | "done";

export interface AgentDto {
  id: string;
  name: string;
  description: string;
  scope: AgentScope;
  status: AgentStatus;
  deleting_at: string | null;
  display_mode: DisplayMode;
  main_entry_id: string | null;
  created_at: string;
  last_report_at: string | null;
  last_result: RunResult | null;
  last_note: string | null;
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
  scope?: AgentScope;
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
