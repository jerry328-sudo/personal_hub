import type { Actor } from "../env";
import { cursorScopeChanged, invalidCursor } from "./errors";

/**
 * 游标里与授权相关的部分，与筛选条件指纹分开保存。
 * 权限版本变化要能区分于“筛选条件变化”，因此必须是独立字段。
 */
export type CursorScope = {
  role: "admin" | "agent" | "manager" | "reader";
  /** 只读身份 ID；其他角色为 null。 */
  reader: string | null;
  /** 只读身份的权限版本；其他角色为 null。 */
  revision: number | null;
};

type CursorEnvelope = {
  v: 2;
  scope: [string, string | null, number | null];
  fingerprint: string;
  value: string[];
};

export function cursorScopeFor(actor: Actor): CursorScope {
  if (actor.type === "admin") return { role: "admin", reader: null, revision: null };
  if (actor.role === "reader") {
    return { role: "reader", reader: actor.agentId, revision: actor.permissionsRevision };
  }
  return { role: actor.role, reader: null, revision: null };
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

export function queryFingerprint(value: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(value).sort().map((key) => [key, value[key] ?? null]));
}

export function encodeCursor(value: string[], fingerprint: string, scope: CursorScope): string {
  const envelope: CursorEnvelope = {
    v: 2,
    scope: [scope.role, scope.reader, scope.revision],
    fingerprint,
    value,
  };
  return base64UrlEncode(JSON.stringify(envelope));
}

/**
 * 解码并校验游标。三类失败刻意区分：
 * - 损坏、角色不同、身份不同、筛选条件变化 → invalid_cursor
 * - 同一只读身份的权限版本变化 → cursor_scope_changed（调用方重读第一页）
 */
export function decodeCursor(
  text: string | undefined,
  fingerprint: string,
  scope: CursorScope,
): string[] | null {
  if (!text) return null;

  let parsed: CursorEnvelope;
  try {
    parsed = JSON.parse(base64UrlDecode(text)) as CursorEnvelope;
  } catch {
    throw invalidCursor();
  }

  if (parsed.v !== 2 || typeof parsed.fingerprint !== "string" || !Array.isArray(parsed.value)) {
    throw invalidCursor();
  }
  if (!parsed.value.every((item) => typeof item === "string")) throw invalidCursor();
  if (!Array.isArray(parsed.scope) || parsed.scope.length !== 3) throw invalidCursor();

  const [role, reader, revision] = parsed.scope;
  if (typeof role !== "string") throw invalidCursor();
  if (typeof reader !== "string" && reader !== null) throw invalidCursor();
  if (typeof revision !== "number" && revision !== null) throw invalidCursor();

  if (parsed.fingerprint !== fingerprint) throw invalidCursor();
  if (role !== scope.role || reader !== scope.reader) throw invalidCursor();
  if (revision !== scope.revision) throw cursorScopeChanged();

  return parsed.value;
}
