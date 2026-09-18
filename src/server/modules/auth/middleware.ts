import type { MiddlewareHandler } from "hono";
import type { Actor, AgentScope, AppContext, AppEnv } from "../../env";
import { forbidden, unauthenticated } from "../../shared/errors";
import {
  actorHasRole,
  authenticateRequest,
  type IdentityRole,
} from "./service";

const ALL_ROLES: readonly IdentityRole[] = ["admin", "agent", "manager"];

function currentActor(c: AppContext): Actor | undefined {
  return c.get("actor") as Actor | undefined;
}

async function resolveActor(c: AppContext): Promise<Actor | null> {
  return currentActor(c) ?? authenticateRequest(c.req.raw, c.env);
}

export function optionalIdentity(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const actor = await resolveActor(c);
    if (actor) c.set("actor", actor);
    await next();
  };
}

export function requireIdentity(
  roles: readonly IdentityRole[] = ALL_ROLES,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const actor = await resolveActor(c);
    if (!actor) throw unauthenticated();
    if (!actorHasRole(actor, roles)) throw forbidden();
    c.set("actor", actor);
    await next();
  };
}

export function requireAdminSession(): MiddlewareHandler<AppEnv> {
  return requireIdentity(["admin"]);
}

export function requireAgentKey(scope?: AgentScope): MiddlewareHandler<AppEnv> {
  const roles: readonly IdentityRole[] =
    scope === "own" ? ["agent"] : scope === "all" ? ["manager"] : ["agent", "manager"];
  return requireIdentity(roles);
}
