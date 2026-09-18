import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { badRequest, forbidden, payloadTooLarge } from "./errors";

export function createRequestId(): string {
  return crypto.randomUUID();
}

export function requestContext(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set("requestId", createRequestId());
    await next();
    c.header("X-Request-Id", c.get("requestId"));
  };
}

export function applyPrivateHeaders(headers: Headers): void {
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "same-origin");
}

export function requireSameOrigin(request: Request, expectedOrigin: string): void {
  const origin = request.headers.get("Origin");
  if (!origin || origin !== expectedOrigin) throw forbidden("写操作必须来自本站页面");
}

export async function readLimitedJson(request: Request, maxBytes: number): Promise<unknown> {
  const declared = request.headers.get("Content-Length");
  if (declared && Number(declared) > maxBytes) throw payloadTooLarge();
  if (!request.body) throw badRequest("请求体不能为空");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw payloadTooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw badRequest("请求体不是有效 JSON");
  }
}
