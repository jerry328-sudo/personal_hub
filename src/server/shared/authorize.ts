import type { AgentActor, Actor, AgentReadMode } from "../env";
import { forbidden } from "./errors";

export type OwnAgentActor = Extract<AgentActor, { role: "agent" }>;
export type ManagerActor = Extract<AgentActor, { role: "manager" }>;
export type ReaderActor = Extract<AgentActor, { role: "reader" }>;

/** 只读身份在单次请求中的授权快照。权限版本用于让授权变更后的旧请求失效。 */
export type ReaderScope = {
  readerAgentId: string;
  permissionsRevision: number;
  readMode: AgentReadMode;
};

/**
 * 三个明确分支，避免用“空 agentIds 数组”同时表示无权限和全部权限。
 * reader 分支不缓存 grants，而是在 SQL 中关联授权表实时判断。
 */
export type ReadScope =
  | { kind: "own"; agentId: string }
  | { kind: "all"; agentId?: string }
  | { kind: "reader"; reader: ReaderScope; agentId?: string };

export function requireAdminActor(actor: Actor): asserts actor is Extract<Actor, { type: "admin" }> {
  if (actor.type !== "admin") throw forbidden();
}

export function requireOwnAgentActor(actor: Actor): asserts actor is OwnAgentActor {
  if (actor.type !== "agent" || actor.role !== "agent") throw forbidden();
  if (actor.status !== "active") throw forbidden("此 Agent 当前未启用");
}

export function requireManagerActor(actor: Actor): asserts actor is ManagerActor {
  if (actor.type !== "agent" || actor.role !== "manager") throw forbidden();
  if (actor.status !== "active") throw forbidden("总管 Agent 当前未启用");
}

export function requireReaderActor(actor: Actor): asserts actor is ReaderActor {
  if (actor.type !== "agent" || actor.role !== "reader") throw forbidden();
  if (actor.status !== "active") throw forbidden("此只读身份当前未启用");
}

export function readerScopeOf(actor: Actor): ReaderScope {
  requireReaderActor(actor);
  return {
    readerAgentId: actor.agentId,
    permissionsRevision: actor.permissionsRevision,
    readMode: actor.readMode,
  };
}

export function resolveReaderReadScope(actor: Actor, requestedAgentId?: string): ReadScope {
  return {
    kind: "reader",
    reader: readerScopeOf(actor),
    ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
  };
}

export function resolveReadScope(actor: Actor, requestedAgentId?: string): ReadScope {
  if (actor.type === "admin") return { kind: "all", ...(requestedAgentId ? { agentId: requestedAgentId } : {}) };
  if (actor.role === "agent") return { kind: "own", agentId: actor.agentId };
  if (actor.role === "manager") {
    if (actor.status !== "active") throw forbidden("总管 Agent 当前未启用");
    return { kind: "all", ...(requestedAgentId ? { agentId: requestedAgentId } : {}) };
  }
  return resolveReaderReadScope(actor, requestedAgentId);
}

/**
 * 对只读身份默认拒绝。只读读取必须走 resolveReaderReadScope 与相应 repository
 * 查询，不给这个 helper 添加“已授权”绕过参数，漏接入的调用路径会失败而不是返回内容。
 */
export function assertCanReadOwner(actor: Actor, ownerId: string): void {
  if (actor.type === "admin") return;
  if (actor.role === "reader") throw forbidden("只读身份必须通过授权范围查询读取");
  if (actor.status !== "active" && !(actor.role === "agent" && actor.agentId === ownerId)) {
    throw forbidden("此 Agent 当前不可访问业务数据");
  }
  if (actor.role === "agent" && actor.agentId !== ownerId) throw forbidden();
}

export function assertCanWriteOwner(actor: Actor, ownerId: string): void {
  if (actor.type === "admin") return;
  if (actor.role === "reader") throw forbidden("只读身份不能写入业务数据");
  if (actor.status !== "active") throw forbidden("此 Agent 当前未启用");
  if (actor.role === "agent" && actor.agentId !== ownerId) throw forbidden();
  if (actor.role === "manager" && actor.agentId === ownerId) throw forbidden("总管身份不能作为内容归属");
}

export function createdByActor(actor: Actor): string {
  return actor.type === "admin" ? "manual" : actor.agentId;
}
