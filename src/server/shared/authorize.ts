import type { Actor, AgentActor } from "../env";
import { forbidden } from "./errors";

export type ReadScope =
  | { kind: "own"; agentId: string }
  | { kind: "all"; agentId?: string };

export function requireAdminActor(actor: Actor): asserts actor is Extract<Actor, { type: "admin" }> {
  if (actor.type !== "admin") throw forbidden();
}

export function requireOwnAgentActor(actor: Actor): asserts actor is AgentActor & { scope: "own" } {
  if (actor.type !== "agent" || actor.scope !== "own") throw forbidden();
  if (actor.status !== "active") throw forbidden("此 Agent 当前未启用");
}

export function requireManagerActor(actor: Actor): asserts actor is AgentActor & { scope: "all" } {
  if (actor.type !== "agent" || actor.scope !== "all") throw forbidden();
  if (actor.status !== "active") throw forbidden("总管 Agent 当前未启用");
}

export function resolveReadScope(actor: Actor, requestedAgentId?: string): ReadScope {
  if (actor.type === "admin") return { kind: "all", ...(requestedAgentId ? { agentId: requestedAgentId } : {}) };
  if (actor.scope === "own") return { kind: "own", agentId: actor.agentId };
  if (actor.status !== "active") throw forbidden("总管 Agent 当前未启用");
  return { kind: "all", ...(requestedAgentId ? { agentId: requestedAgentId } : {}) };
}

export function assertCanReadOwner(actor: Actor, ownerId: string): void {
  if (actor.type === "admin") return;
  if (actor.status !== "active" && !(actor.scope === "own" && actor.agentId === ownerId)) {
    throw forbidden("此 Agent 当前不可访问业务数据");
  }
  if (actor.scope === "own" && actor.agentId !== ownerId) throw forbidden();
}

export function assertCanWriteOwner(actor: Actor, ownerId: string): void {
  if (actor.type === "admin") return;
  if (actor.status !== "active") throw forbidden("此 Agent 当前未启用");
  if (actor.scope === "own" && actor.agentId !== ownerId) throw forbidden();
  if (actor.scope === "all" && actor.agentId === ownerId) throw forbidden("总管身份不能作为内容归属");
}

export function createdByActor(actor: Actor): string {
  return actor.type === "admin" ? "manual" : actor.agentId;
}
