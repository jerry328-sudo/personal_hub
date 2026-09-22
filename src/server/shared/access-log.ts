import type { MiddlewareHandler } from "hono";
import type { AgentReadMode } from "../../shared/contracts";
import type { AppContext, AppEnv } from "../env";
import { normalizeError } from "./errors";

const RESOURCE_PARAM_NAMES = ["id", "agentId", "version", "key_id", "attachment_id"] as const;

/**
 * 只读身份的访问日志。复用 Workers Logs，逐条按白名单字段构造，
 * 绝不写入密钥、Cookie、正文或完整查询串。
 *
 * 这是尽力记录的运维日志，不是完整的合规审计：平台留存有限
 * （Free 3 天 / Paid 7 天），超出留存或采样限制的记录不可恢复。
 */
export type ReaderAccessLogInput = {
  requestId: string;
  readerAgentId: string;
  keyId: string;
  method: string;
  route: string;
  resourceId?: string | undefined;
  status: number;
  code: string | null;
  permissionsRevision: number;
};

export function recordReaderAccess(input: ReaderAccessLogInput): void {
  console.log(JSON.stringify({
    event: "reader_api_access",
    at: new Date().toISOString(),
    request_id: input.requestId,
    reader_agent_id: input.readerAgentId,
    key_id: input.keyId,
    method: input.method,
    route: input.route,
    ...(input.resourceId === undefined ? {} : { resource_id: input.resourceId }),
    status: input.status,
    code: input.code,
    permissions_revision: input.permissionsRevision,
  }));
}

export type ReaderAccessChangeInput = {
  requestId: string;
  readerAgentId: string;
  previousRevision: number | null;
  revision: number;
  mode: AgentReadMode;
  sourceCount: number;
  result: "updated" | "rejected";
};

export function recordReaderAccessChange(input: ReaderAccessChangeInput): void {
  console.log(JSON.stringify({
    event: "reader_access_change",
    at: new Date().toISOString(),
    actor: "admin",
    request_id: input.requestId,
    reader_agent_id: input.readerAgentId,
    previous_revision: input.previousRevision,
    revision: input.revision,
    mode: input.mode,
    source_count: input.sourceCount,
    result: input.result,
  }));
}

/**
 * 挂在全局 API 链上，保证成功、拒绝、限流和服务端错误都被记录。
 * 只记录路由模板与白名单字段，不触碰请求/响应体、查询串或凭证。
 */
export function readerAccessLogMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    try {
      await next();
    } catch (rawError) {
      const normalized = normalizeError(rawError);
      // 交给统一的 onError 处理，这里只负责记录。
      logRequest(c, { status: normalized.status, code: normalized.code });
      throw rawError;
    }
    // Hono 会在下游将异常转为响应，await next() 通常不会重新抛出。
    // 不读取响应体，避免消耗图片流或将业务内容带入日志。
    logRequest(c, {
      status: c.res.status,
      code: c.error ? normalizeError(c.error).code : c.res.status >= 400 ? "http_error" : "ok",
    });
  };
}

function logRequest(c: AppContext, outcome: { status: number; code: string }): void {
  const actor = c.get("actor");
  if (!actor || actor.type !== "agent" || actor.role !== "reader") return;

  let resourceId: string | undefined;
  for (const name of RESOURCE_PARAM_NAMES) {
    const value = c.req.param(name);
    if (value) {
      resourceId = value;
      break;
    }
  }

  recordReaderAccess({
    requestId: c.get("requestId") || "unknown",
    readerAgentId: actor.agentId,
    keyId: actor.keyId,
    method: c.req.method,
    route: c.req.routePath || new URL(c.req.url).pathname,
    resourceId,
    status: outcome.status,
    code: outcome.code,
    permissionsRevision: actor.permissionsRevision,
  });
}
