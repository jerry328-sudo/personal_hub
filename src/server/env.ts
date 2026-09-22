import type { Context } from "hono";
import type { AgentAccessMode, AgentReadMode, AgentRole } from "../shared/contracts";

/** 仅用于数据库边界与旧契约映射，运行时鉴权不再使用。 */
export type AgentScope = "own" | "all";
export type AgentStatus = "active" | "disabled" | "removed" | "deleting";

export type { AgentAccessMode, AgentReadMode, AgentRole };

/** 从 agents 行解码角色时的输入组合。 */
export type AgentRoleFields = {
  scope: AgentScope;
  accessMode: AgentAccessMode;
  readMode: AgentReadMode | null;
  permissionsRevision: number;
};

export type AdminActor = {
  type: "admin";
  sessionId: string;
};

type AgentActorBase = {
  type: "agent";
  agentId: string;
  keyId: string;
  status: AgentStatus;
};

/**
 * 认证边界产出的判别联合。刻意不暴露数据库 scope 与 access_mode，
 * 这样任何遗留的 `actor.scope === 'all'` 分支都会变成编译错误，
 * 而不是静默把只读身份当成总管。
 */
export type AgentActor = AgentActorBase & (
  | { role: "agent" }
  | { role: "manager" }
  | { role: "reader"; readMode: AgentReadMode; permissionsRevision: number }
);

export type Actor = AdminActor | AgentActor;

export type AppVariables = {
  actor: Actor;
  requestId: string;
};

export type AppEnv = {
  Bindings: CloudflareBindings;
  Variables: AppVariables;
};

export type AppContext = Context<AppEnv>;
export type ServiceContext = {
  env: CloudflareBindings;
  actor: Actor;
  requestId: string;
};

export function serviceContext(c: AppContext): ServiceContext {
  return {
    env: c.env,
    actor: c.get("actor"),
    requestId: c.get("requestId"),
  };
}
