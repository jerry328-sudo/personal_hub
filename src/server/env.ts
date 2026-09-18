import type { Context } from "hono";

export type AgentScope = "own" | "all";
export type AgentStatus = "active" | "disabled" | "removed" | "deleting";

export type AdminActor = {
  type: "admin";
  sessionId: string;
};

export type AgentActor = {
  type: "agent";
  agentId: string;
  keyId: string;
  scope: AgentScope;
  status: AgentStatus;
};

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
