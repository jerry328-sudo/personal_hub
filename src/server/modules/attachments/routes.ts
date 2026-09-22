import type { Hono } from "hono";
import type { AppEnv } from "../../env";
import { serviceContext } from "../../env";
import { badRequest, forbidden } from "../../shared/errors";
import { applyPrivateHeaders } from "../../shared/http";
import {
  ALL_ROLES,
  requireAdminSession,
  requireAgentRole,
  requireIdentity,
} from "../auth/middleware";
import { getAttachmentMedia, uploadAttachment } from "./service";

function requireAdminWriteOrigin(request: Request, expectedOrigin: string): void {
  if (request.headers.get("Origin") !== expectedOrigin) {
    throw forbidden("请求来源无效");
  }
}

function pathId(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw badRequest(`${label}格式无效`);
  return value;
}

function privateResponse(response: Response): Response {
  applyPrivateHeaders(response.headers);
  return response;
}

export function registerAttachmentRoutes(app: Hono<AppEnv>): void {
  app.post(
    "/api/v1/agent/attachments",
    requireAgentRole(["agent"]),
    async (c) => {
      const actor = c.get("actor");
      if (actor.type !== "agent" || actor.role !== "agent") throw forbidden();
      const attachment = await uploadAttachment(serviceContext(c), actor.agentId, c.req.raw);
      return privateResponse(c.json(attachment, 201));
    },
  );

  app.post(
    "/api/v1/manager/agents/:agentId/attachments",
    requireAgentRole(["manager"]),
    async (c) => {
      const attachment = await uploadAttachment(
        serviceContext(c),
        pathId(c.req.param("agentId"), "Agent ID"),
        c.req.raw,
      );
      return privateResponse(c.json(attachment, 201));
    },
  );

  app.post(
    "/api/v1/admin/agents/:agentId/attachments",
    requireAdminSession(),
    async (c) => {
      requireAdminWriteOrigin(c.req.raw, c.env.APP_ORIGIN);
      const attachment = await uploadAttachment(
        serviceContext(c),
        pathId(c.req.param("agentId"), "Agent ID"),
        c.req.raw,
      );
      return privateResponse(c.json(attachment, 201));
    },
  );

  app.get(
    "/api/v1/media/:id",
    requireIdentity(ALL_ROLES),
    async (c) => getAttachmentMedia(
      serviceContext(c),
      pathId(c.req.param("id"), "附件 ID"),
    ),
  );
}
