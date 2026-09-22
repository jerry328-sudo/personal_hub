import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ApiErrorBody } from "../../shared/contracts";

export class AppError extends Error {
  constructor(
    public readonly status: ContentfulStatusCode,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, "bad_request", message, details);
/** 游标损坏、身份不匹配或筛选条件变化。 */
export const invalidCursor = (message = "分页游标无效或不属于当前查询") => new AppError(400, "invalid_cursor", message);
/** 授权范围已变更，调用方应丢弃本次翻页结果并重读第一页。 */
export const cursorScopeChanged = (message = "授权范围已变更，请从第一页重新读取") =>
  new AppError(400, "cursor_scope_changed", message, { restart_from_first_page: true });
export const unauthenticated = (message = "需要登录或有效的 Agent 密钥") => new AppError(401, "unauthenticated", message);
export const forbidden = (message = "没有执行此操作的权限") => new AppError(403, "forbidden", message);
export const notFound = (message = "资源不存在") => new AppError(404, "not_found", message);
export const conflict = (message: string, details?: unknown) => new AppError(409, "conflict", message, details);
export const payloadTooLarge = (message = "请求内容过大") => new AppError(413, "payload_too_large", message);
export const unsupportedMedia = (message = "不支持的文件类型") => new AppError(415, "unsupported_media_type", message);
export const rateLimited = (message = "请求过于频繁，请稍后重试") =>
  new AppError(429, "rate_limited", message, undefined, { "Retry-After": "60" });
export const serviceUnavailable = (message = "服务暂时不可用") => new AppError(503, "service_unavailable", message);

export function errorBody(error: AppError, requestId: string): ApiErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      request_id: requestId,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}

export function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof HTTPException) {
    return new AppError(error.status, "http_error", error.message || "请求失败");
  }
  return new AppError(500, "internal_error", "服务器暂时无法处理请求");
}
