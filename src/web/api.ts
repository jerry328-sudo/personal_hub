import type {
  AgentDto,
  AgentKeyMetadataDto,
  AppendVersionInput,
  AttachmentDto,
  CompletionFilter,
  CreateAgentInput,
  CreateEntryInput,
  CreateTaskInput,
  EntryBriefDto,
  EntryFullDto,
  EntryStateDto,
  EntryVersionBriefDto,
  EntryVersionDto,
  IssuedKeyDto,
  Page,
  PatchEntryStateInput,
  PatchTaskInput,
  PurgeProgressDto,
  SessionDto,
  TaskDto,
  UpdateAgentInput,
} from "../shared/contracts";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly details?: unknown;

  constructor(status: number, message: string, code = "http_error", requestId?: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }
}

type QueryValue = string | number | boolean | null | undefined;

function withQuery<T extends object>(path: string, query?: T): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query as Record<string, QueryValue>)) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `${path}?${text}` : path;
}

function assertSameOrigin(path: string): string {
  const url = new URL(path, window.location.origin);
  if (url.origin !== window.location.origin) throw new Error("API 请求必须使用当前站点地址");
  return `${url.pathname}${url.search}`;
}

export async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  const isForm = init.body instanceof FormData;
  if (init.body && !isForm && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  let response: Response;
  try {
    response = await fetch(assertSameOrigin(path), {
      ...init,
      credentials: "same-origin",
      headers,
    });
  } catch {
    throw new ApiError(0, "暂时无法连接服务，请检查网络后重试", "network_error");
  }

  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await response.json().catch(() => null) as unknown
    : await response.text().catch(() => "");

  if (!response.ok) {
    const error = body && typeof body === "object" && "error" in body
      ? (body as { error?: { code?: string; message?: string; request_id?: string; details?: unknown } }).error
      : undefined;
    const apiError = new ApiError(
      response.status,
      error?.message || `请求失败（${response.status}）`,
      error?.code,
      error?.request_id,
      error?.details,
    );
    if (response.status === 401) window.dispatchEvent(new CustomEvent("personal-hub:unauthorized"));
    throw apiError;
  }
  return body as T;
}

function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

export const sessionApi = {
  get: (signal?: AbortSignal) => requestJson<SessionDto>("/api/v1/auth/session", { signal }),
  login: (secret: string) => requestJson<SessionDto>("/api/v1/auth/login", {
    method: "POST",
    body: jsonBody({ secret }),
  }),
  logout: () => requestJson<void>("/api/v1/auth/logout", { method: "POST" }),
};

export interface AgentListQuery {
  status?: "active" | "disabled" | "removed" | "deleting" | "all";
  scope?: "own" | "all";
  cursor?: string;
  limit?: number;
}

export interface CreateAgentResult {
  agent: AgentDto;
  key: IssuedKeyDto;
}

export const agentsApi = {
  list: (query: AgentListQuery = {}, signal?: AbortSignal) =>
    requestJson<Page<AgentDto>>(withQuery("/api/v1/admin/agents", query), { signal }),
  listAll: async (query: Omit<AgentListQuery, "cursor"> = {}, signal?: AbortSignal) => {
    const items: AgentDto[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await requestJson<Page<AgentDto>>(
        withQuery("/api/v1/admin/agents", { ...query, cursor, limit: query.limit ?? 100 }),
        { signal },
      );
      items.push(...page.items);
      cursor = page.next_cursor ?? undefined;
      if (cursor && seen.has(cursor)) throw new ApiError(0, "Agent 分页游标重复", "pagination_error");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return items;
  },
  create: (input: CreateAgentInput) => requestJson<CreateAgentResult>("/api/v1/admin/agents", {
    method: "POST",
    body: jsonBody(input),
  }),
  update: (id: string, input: UpdateAgentInput) =>
    requestJson<AgentDto>(`/api/v1/admin/agents/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: jsonBody(input),
    }),
  enable: (id: string) => requestJson<AgentDto>(`/api/v1/admin/agents/${encodeURIComponent(id)}/enable`, { method: "POST" }),
  disable: (id: string) => requestJson<AgentDto>(`/api/v1/admin/agents/${encodeURIComponent(id)}/disable`, { method: "POST" }),
  remove: (id: string) => requestJson<AgentDto>(`/api/v1/admin/agents/${encodeURIComponent(id)}/remove`, { method: "POST" }),
  restore: (id: string) => requestJson<AgentDto>(`/api/v1/admin/agents/${encodeURIComponent(id)}/restore`, { method: "POST" }),
  purgeStep: (id: string) => requestJson<PurgeProgressDto>(`/api/v1/admin/agents/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

export const keysApi = {
  list: (agentId: string, signal?: AbortSignal) =>
    requestJson<{ items: AgentKeyMetadataDto[] }>(`/api/v1/admin/agents/${encodeURIComponent(agentId)}/keys`, { signal }),
  issue: (agentId: string, expiresAt?: string | null) =>
    requestJson<IssuedKeyDto>(`/api/v1/admin/agents/${encodeURIComponent(agentId)}/keys`, {
      method: "POST",
      body: jsonBody({ expires_at: expiresAt ?? null }),
    }),
  revoke: (agentId: string, keyId: string) =>
    requestJson<void>(`/api/v1/admin/agents/${encodeURIComponent(agentId)}/keys/${encodeURIComponent(keyId)}`, { method: "DELETE" }),
};

export interface EntryListQuery {
  agent_id?: string;
  view?: "brief" | "full";
  completion?: CompletionFilter;
  archived?: "all" | "yes" | "no";
  important?: "all" | "yes" | "no";
  order?: "id_asc" | "updated_desc" | "created_asc";
  cursor?: string;
  limit?: number;
  query?: string;
}

export const entriesApi = {
  list: <T extends EntryBriefDto | EntryFullDto = EntryBriefDto>(query: EntryListQuery, signal?: AbortSignal) =>
    requestJson<Page<T>>(withQuery("/api/v1/admin/entries", query), { signal }),
  get: (id: string, signal?: AbortSignal) =>
    requestJson<EntryFullDto>(`/api/v1/admin/entries/${encodeURIComponent(id)}`, { signal }),
  create: (agentId: string, input: CreateEntryInput) =>
    requestJson<{ id: string; version: number }>(`/api/v1/admin/agents/${encodeURIComponent(agentId)}/entries`, {
      method: "POST",
      body: jsonBody(input),
    }),
  appendVersion: (id: string, input: AppendVersionInput) =>
    requestJson<{ id: string; version: number }>(`/api/v1/admin/entries/${encodeURIComponent(id)}/versions`, {
      method: "POST",
      body: jsonBody(input),
    }),
  listVersions: (id: string, cursor?: string, signal?: AbortSignal) =>
    requestJson<Page<EntryVersionBriefDto>>(withQuery(`/api/v1/admin/entries/${encodeURIComponent(id)}/versions`, { cursor, limit: 100 }), { signal }),
  getVersion: (id: string, version: number, signal?: AbortSignal) =>
    requestJson<EntryVersionDto>(`/api/v1/admin/entries/${encodeURIComponent(id)}/versions/${version}`, { signal }),
  setState: (id: string, input: PatchEntryStateInput) =>
    requestJson<EntryStateDto>(`/api/v1/admin/entries/${encodeURIComponent(id)}/state`, {
      method: "PATCH",
      body: jsonBody(input),
    }),
  delete: (id: string) => requestJson<void>(`/api/v1/admin/entries/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

export interface TaskListQuery {
  agent_id?: string;
  done?: "all" | "yes" | "no";
  cursor?: string;
  limit?: number;
}

export const tasksApi = {
  list: (query: TaskListQuery = {}, signal?: AbortSignal) =>
    requestJson<Page<TaskDto>>(withQuery("/api/v1/admin/tasks", query), { signal }),
  create: (input: CreateTaskInput) => requestJson<TaskDto>("/api/v1/admin/tasks", {
    method: "POST",
    body: jsonBody(input),
  }),
  update: (id: string, input: PatchTaskInput) =>
    requestJson<TaskDto>(`/api/v1/admin/tasks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: jsonBody(input),
    }),
  delete: (id: string) => requestJson<void>(`/api/v1/admin/tasks/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

export const attachmentsApi = {
  upload: (agentId: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return requestJson<AttachmentDto>(`/api/v1/admin/agents/${encodeURIComponent(agentId)}/attachments`, {
      method: "POST",
      body: form,
    });
  },
};

export function notifyDataChanged(): void {
  window.dispatchEvent(new CustomEvent("personal-hub:data-changed"));
}
