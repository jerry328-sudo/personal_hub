import type { Hono } from "hono";
import { z } from "zod";
import { LIMITS } from "../../../shared/limits";
import {
  createAgentSchema,
  reportSchema,
  updateAgentSchema,
  updateReadAccessSchema,
} from "../../../shared/validation";
import type { AppEnv } from "../../env";
import { serviceContext } from "../../env";
import { badRequest } from "../../shared/errors";
import { readLimitedJson, requireSameOrigin } from "../../shared/http";
import { requireAdminSession, requireAgentRole } from "../auth/middleware";
import { purgeAgentStep, type AgentPurgeDependencies } from "./lifecycle";
import { getReaderAccess, replaceReaderAccess } from "./read-access";
import {
  createAgent,
  disableAgent,
  enableAgent,
  getSelfAgent,
  listAgents,
  removeAgent,
  reportRun,
  restoreAgent,
  updateAgent,
} from "./service";

const agentListQuerySchema = z.object({
  status: z.enum(["active", "disabled", "removed", "deleting", "all"]).optional(),
  scope: z.enum(["own", "all"]).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.maxPageSize).optional(),
}).strict();

async function parseJson<TSchema extends z.ZodType>(request: Request, schema: TSchema): Promise<z.output<TSchema>> {
  const body = await readLimitedJson(request, LIMITS.jsonRequestBytes);
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw badRequest("请求参数无效", parsed.error.flatten());
  return parsed.data;
}

function parseAgentListQuery(value: Record<string, string>): z.output<typeof agentListQuerySchema> {
  const parsed = agentListQuerySchema.safeParse(value);
  if (!parsed.success) throw badRequest("查询参数无效", parsed.error.flatten());
  return parsed.data;
}

function requireAdminWriteOrigin(request: Request, env: CloudflareBindings): void {
  requireSameOrigin(request, env.APP_ORIGIN);
}

export type AgentRouteDependencies = AgentPurgeDependencies;

export function registerAgentRoutes(app: Hono<AppEnv>, dependencies: AgentRouteDependencies): void {
  const adminOnly = requireAdminSession();
  const ownAgentOnly = requireAgentRole(["agent"]);
  const managerOnly = requireAgentRole(["manager"]);

  app.get("/api/v1/admin/agents", adminOnly, async (c) => {
    const query = parseAgentListQuery(c.req.query());
    return c.json(await listAgents(serviceContext(c), query, "admin"));
  });

  app.post("/api/v1/admin/agents", adminOnly, async (c) => {
    requireAdminWriteOrigin(c.req.raw, c.env);
    const input = await parseJson(c.req.raw, createAgentSchema);
    return c.json(await createAgent(serviceContext(c), input), 201);
  });

  app.patch("/api/v1/admin/agents/:id", adminOnly, async (c) => {
    requireAdminWriteOrigin(c.req.raw, c.env);
    const input = await parseJson(c.req.raw, updateAgentSchema);
    return c.json(await updateAgent(serviceContext(c), c.req.param("id"), input));
  });

  app.post("/api/v1/admin/agents/:id/enable", adminOnly, async (c) => {
    requireAdminWriteOrigin(c.req.raw, c.env);
    return c.json(await enableAgent(serviceContext(c), c.req.param("id")));
  });

  app.post("/api/v1/admin/agents/:id/disable", adminOnly, async (c) => {
    requireAdminWriteOrigin(c.req.raw, c.env);
    return c.json(await disableAgent(serviceContext(c), c.req.param("id")));
  });

  app.post("/api/v1/admin/agents/:id/remove", adminOnly, async (c) => {
    requireAdminWriteOrigin(c.req.raw, c.env);
    return c.json(await removeAgent(serviceContext(c), c.req.param("id")));
  });

  app.post("/api/v1/admin/agents/:id/restore", adminOnly, async (c) => {
    requireAdminWriteOrigin(c.req.raw, c.env);
    return c.json(await restoreAgent(serviceContext(c), c.req.param("id")));
  });

  app.delete("/api/v1/admin/agents/:id", adminOnly, async (c) => {
    requireAdminWriteOrigin(c.req.raw, c.env);
    const progress = await purgeAgentStep(serviceContext(c), c.req.param("id"), dependencies);
    return c.json(progress, progress.status === "pending" ? 202 : 200);
  });

  app.get("/api/v1/admin/agents/:id/read-access", adminOnly, async (c) => {
    return c.json(await getReaderAccess(serviceContext(c), c.req.param("id")));
  });

  app.put("/api/v1/admin/agents/:id/read-access", adminOnly, async (c) => {
    requireAdminWriteOrigin(c.req.raw, c.env);
    const input = await parseJson(c.req.raw, updateReadAccessSchema);
    return c.json(await replaceReaderAccess(serviceContext(c), c.req.param("id"), input));
  });

  app.get("/api/v1/agent", ownAgentOnly, async (c) => {
    return c.json(await getSelfAgent(serviceContext(c)));
  });

  app.post("/api/v1/agent/report", ownAgentOnly, async (c) => {
    const input = await parseJson(c.req.raw, reportSchema);
    return c.json(await reportRun(serviceContext(c), input));
  });

  app.get("/api/v1/manager/agents", managerOnly, async (c) => {
    const query = parseAgentListQuery(c.req.query());
    return c.json(await listAgents(serviceContext(c), query, "manager"));
  });

  app.post("/api/v1/manager/report", managerOnly, async (c) => {
    const input = await parseJson(c.req.raw, reportSchema);
    return c.json(await reportRun(serviceContext(c), input));
  });
}
