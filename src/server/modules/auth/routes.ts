import { Hono } from "hono";
import { ZodError, type ZodType } from "zod";
import { issueKeySchema, loginSchema } from "../../../shared/validation";
import type { AppEnv } from "../../env";
import { serviceContext } from "../../env";
import { badRequest, forbidden } from "../../shared/errors";
import {
  applyPrivateHeaders,
  readLimitedJson,
  requireSameOrigin,
} from "../../shared/http";
import { LIMITS } from "../../../shared/limits";
import { requireAdminSession } from "./middleware";
import {
  getAdminSession,
  issueAgentKey,
  listAgentKeys,
  loginAdmin,
  logoutAdmin,
  revokeAgentKey,
} from "./service";

function parseBody<T>(schema: ZodType<T>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      throw badRequest("请求参数无效", error.issues);
    }
    throw error;
  }
}

function sameOrigin(request: Request, expectedOrigin: string): void {
  try {
    requireSameOrigin(request, expectedOrigin);
  } catch {
    throw forbidden("请求来源不受信任");
  }
}

function pathId(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw badRequest(`${label}格式无效`);
  }
  return value;
}

function privateResponse(response: Response): Response {
  applyPrivateHeaders(response.headers);
  return response;
}

export function registerAuthRoutes(app: Hono<AppEnv>): void {
  app.post("/api/v1/auth/login", async (c) => {
    sameOrigin(c.req.raw, c.env.APP_ORIGIN);
    const body = await readLimitedJson(c.req.raw, LIMITS.jsonRequestBytes);
    const input = parseBody(loginSchema, body);
    const result = await loginAdmin(c.env, c.req.raw, input);
    const response = c.json(result.session, 200);
    response.headers.append("Set-Cookie", result.cookie);
    return privateResponse(response);
  });

  app.get("/api/v1/auth/session", requireAdminSession(), async (c) => {
    const session = await getAdminSession(serviceContext(c));
    return privateResponse(c.json(session, 200));
  });

  app.post("/api/v1/auth/logout", requireAdminSession(), async (c) => {
    sameOrigin(c.req.raw, c.env.APP_ORIGIN);
    const cookie = await logoutAdmin(serviceContext(c));
    const response = new Response(null, { status: 204 });
    response.headers.append("Set-Cookie", cookie);
    return privateResponse(response);
  });

  app.get(
    "/api/v1/admin/agents/:id/keys",
    requireAdminSession(),
    async (c) => {
      const agentId = pathId(c.req.param("id"), "Agent ID");
      const items = await listAgentKeys(serviceContext(c), agentId);
      return privateResponse(c.json({ items }, 200));
    },
  );

  app.post(
    "/api/v1/admin/agents/:id/keys",
    requireAdminSession(),
    async (c) => {
      sameOrigin(c.req.raw, c.env.APP_ORIGIN);
      const agentId = pathId(c.req.param("id"), "Agent ID");
      const body = await readLimitedJson(c.req.raw, LIMITS.jsonRequestBytes);
      const input = parseBody(issueKeySchema, body);
      const issued = await issueAgentKey(serviceContext(c), agentId, input);
      return privateResponse(c.json(issued, 201));
    },
  );

  app.delete(
    "/api/v1/admin/agents/:id/keys/:keyId",
    requireAdminSession(),
    async (c) => {
      sameOrigin(c.req.raw, c.env.APP_ORIGIN);
      const agentId = pathId(c.req.param("id"), "Agent ID");
      const keyId = pathId(c.req.param("keyId"), "Key ID");
      await revokeAgentKey(serviceContext(c), agentId, keyId);
      return privateResponse(new Response(null, { status: 204 }));
    },
  );
}
