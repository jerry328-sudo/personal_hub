import type { MiddlewareHandler } from "hono";
import type { Actor, AppEnv } from "../env";
import { normalizeError, rateLimited, serviceUnavailable } from "./errors";

/**
 * 只读身份的机器接口限流。按已验证的 reader Agent ID 计数，同一身份的
 * 不同密钥共用额度；不按 key ID 分桶，避免切换密钥绕过。
 *
 * Cloudflare Rate Limiting 是按 Cloudflare 地点计数、最终一致的保护，
 * 不是全球精确额度，首版也不做每日/月度硬配额。
 */
export async function enforceReaderRateLimit(
  env: CloudflareBindings,
  actor: Actor | undefined,
): Promise<void> {
  if (!actor || actor.type !== "agent" || actor.role !== "reader") return;

  const limiter = env.READER_RATE_LIMITER;
  if (!limiter || typeof limiter.limit !== "function") {
    console.error(JSON.stringify({
      event: "reader_rate_limit_binding_missing",
      reader_agent_id: actor.agentId,
    }));
    throw serviceUnavailable("只读接口限流不可用");
  }

  let outcome: RateLimitOutcome;
  try {
    outcome = await limiter.limit({ key: actor.agentId });
  } catch (error) {
    console.error(JSON.stringify({
      event: "reader_rate_limit_failed",
      reader_agent_id: actor.agentId,
      message: normalizeError(error).code,
    }));
    throw serviceUnavailable("只读接口限流不可用");
  }
  if (!outcome.success) throw rateLimited();
}

export function readerRateLimitMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await enforceReaderRateLimit(c.env, c.get("actor"));
    await next();
  };
}
