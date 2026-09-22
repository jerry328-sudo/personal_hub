import type { MiddlewareHandler } from "hono";
import type { Actor, AppContext, AppEnv } from "../../env";
import { forbidden, unauthenticated } from "../../shared/errors";
import {
  actorHasRole,
  authenticateRequest,
  type IdentityRole,
} from "./service";

export const ALL_ROLES: readonly IdentityRole[] = ["admin", "agent", "manager", "reader"];

/**
 * 只读身份可触达的路径。全局网关据此拒绝 reader 进入其他命名空间，
 * 即使某条路由漏写角色名单也不会把只读密钥变成写权限。
 *
 * 精确路径与前缀分开写："/api" 如果当成前缀就会匹配整条 "/api/*"，
 * 等于完全不拦。
 */
const READER_EXACT_PATHS: readonly string[] = ["/api", "/api/docs"];
const READER_PREFIX_PATHS: readonly string[] = ["/api/v1/reader", "/api/v1/media"];

function readerMayReach(pathname: string): boolean {
  if (READER_EXACT_PATHS.includes(pathname)) return true;
  return READER_PREFIX_PATHS.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

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

/** 角色名单必须显式给出，避免新增路由被动继承过宽的准入范围。 */
export function requireIdentity(
  roles: readonly IdentityRole[],
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const actor = await resolveActor(c);
    if (!actor) throw unauthenticated();
    // 先写入上下文，后续的拒绝才能被访问日志记录到具体身份。
    c.set("actor", actor);
    if (!actorHasRole(actor, roles)) throw forbidden();
    await next();
  };
}

/**
 * 全局 API 身份认证。路径准入单独放在 reader 限流之后。
 */
export function requireApiIdentity(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const actor = await resolveActor(c);
    if (!actor) throw unauthenticated();
    c.set("actor", actor);
    await next();
  };
}

/** 已认证的 reader 先经过限流，再检查能否进入目标命名空间。 */
export function requireReaderPathAccess(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const actor = currentActor(c);
    if (actor?.type === "agent" && actor.role === "reader") {
      const pathname = new URL(c.req.url).pathname;
      if (!readerMayReach(pathname)) {
        throw forbidden("只读身份不能访问此接口");
      }
    }
    await next();
  };
}

export function requireAdminSession(): MiddlewareHandler<AppEnv> {
  return requireIdentity(["admin"]);
}

/** 普通 Agent 或总管 Agent，需要显式声明。 */
export function requireAgentRole(roles: readonly ("agent" | "manager")[]): MiddlewareHandler<AppEnv> {
  return requireIdentity(roles);
}

export function requireReaderKey(): MiddlewareHandler<AppEnv> {
  return requireIdentity(["reader"]);
}
