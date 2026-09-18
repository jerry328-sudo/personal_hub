import { z } from "zod";
import type { Context, Handler, Hono } from "hono";
import type { ZodType } from "zod";
import type { AppendVersionInput, CreateEntryInput, PatchEntryStateInput } from "../../../shared/contracts";
import { LIMITS } from "../../../shared/limits";
import {
  appendVersionSchema,
  createEntrySchema,
  entryQuerySchema,
  patchEntryStateSchema,
  type EntryQuery,
} from "../../../shared/validation";
import { serviceContext, type AppEnv } from "../../env";
import { requireAdminActor, requireManagerActor, requireOwnAgentActor } from "../../shared/authorize";
import { badRequest } from "../../shared/errors";
import { readLimitedJson, requireSameOrigin } from "../../shared/http";
import {
  appendEntryVersion,
  createEntry,
  deleteEntry,
  getEntry,
  getEntryVersion,
  listEntries,
  listEntryVersions,
  updateEntryState,
  type EntryAudience,
  type VersionPageQuery,
} from "./service";

const entityIdSchema = z.string().trim().min(1).max(200);
const versionSchema = z.string().regex(/^[1-9]\d*$/).transform(Number).refine(Number.isSafeInteger);
const versionPageSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.maxPageSize).optional(),
}).strict();

function validationDetails(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

async function parseJson<T>(c: Context<AppEnv>, schema: ZodType<T>): Promise<T> {
  const value = await readLimitedJson(c.req.raw, LIMITS.jsonRequestBytes);
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw badRequest("请求参数无效", validationDetails(parsed.error));
  return parsed.data;
}

function parseQuery<T>(c: Context<AppEnv>, schema: ZodType<T>): T {
  const value = Object.fromEntries(new URL(c.req.url).searchParams.entries());
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw badRequest("查询参数无效", validationDetails(parsed.error));
  return parsed.data;
}

function parseId(value: string | undefined, label = "资源编号"): string {
  const parsed = entityIdSchema.safeParse(value);
  if (!parsed.success) throw badRequest(`${label}无效`);
  return parsed.data;
}

function parseVersion(value: string | undefined): number {
  const parsed = versionSchema.safeParse(value);
  if (!parsed.success) throw badRequest("版本号无效");
  return parsed.data;
}

function assertAudience(c: Context<AppEnv>, audience: EntryAudience): void {
  const actor = c.get("actor");
  if (audience === "agent") requireOwnAgentActor(actor);
  else if (audience === "manager") requireManagerActor(actor);
  else requireAdminActor(actor);
}

function privateResponse(c: Context<AppEnv>): void {
  c.header("Cache-Control", "private, no-store");
  c.header("X-Content-Type-Options", "nosniff");
}

function listHandler(audience: EntryAudience): Handler<AppEnv> {
  return async (c) => {
    privateResponse(c);
    assertAudience(c, audience);
    const query = parseQuery<EntryQuery>(c, entryQuerySchema);
    return c.json(await listEntries(serviceContext(c), query, audience));
  };
}

function detailHandler(audience: EntryAudience): Handler<AppEnv> {
  return async (c) => {
    privateResponse(c);
    assertAudience(c, audience);
    return c.json(await getEntry(serviceContext(c), parseId(c.req.param("id"), "条目编号")));
  };
}

function appendHandler(audience: EntryAudience): Handler<AppEnv> {
  return async (c) => {
    privateResponse(c);
    assertAudience(c, audience);
    if (audience === "admin") requireSameOrigin(c.req.raw, c.env.APP_ORIGIN);
    const input = await parseJson<AppendVersionInput>(c, appendVersionSchema);
    const result = await appendEntryVersion(
      serviceContext(c),
      parseId(c.req.param("id"), "条目编号"),
      input,
    );
    return c.json(result, 201);
  };
}

function versionsHandler(audience: EntryAudience): Handler<AppEnv> {
  return async (c) => {
    privateResponse(c);
    assertAudience(c, audience);
    const page = parseQuery<VersionPageQuery>(c, versionPageSchema);
    return c.json(await listEntryVersions(
      serviceContext(c),
      parseId(c.req.param("id"), "条目编号"),
      page,
    ));
  };
}

function versionDetailHandler(audience: EntryAudience): Handler<AppEnv> {
  return async (c) => {
    privateResponse(c);
    assertAudience(c, audience);
    return c.json(await getEntryVersion(
      serviceContext(c),
      parseId(c.req.param("id"), "条目编号"),
      parseVersion(c.req.param("version")),
    ));
  };
}

export function registerEntryRoutes(app: Hono<AppEnv>): void {
  app.get("/api/v1/agent/entries", listHandler("agent"));
  app.get("/api/v1/agent/entries/:id", detailHandler("agent"));
  app.post("/api/v1/agent/entries", async (c) => {
    privateResponse(c);
    const actor = c.get("actor");
    requireOwnAgentActor(actor);
    const input = await parseJson<CreateEntryInput>(c, createEntrySchema);
    return c.json(await createEntry(serviceContext(c), actor.agentId, input), 201);
  });
  app.post("/api/v1/agent/entries/:id/versions", appendHandler("agent"));
  app.get("/api/v1/agent/entries/:id/versions", versionsHandler("agent"));
  app.get("/api/v1/agent/entries/:id/versions/:version", versionDetailHandler("agent"));

  app.get("/api/v1/manager/entries", listHandler("manager"));
  app.get("/api/v1/manager/entries/:id", detailHandler("manager"));
  app.post("/api/v1/manager/agents/:agentId/entries", async (c) => {
    privateResponse(c);
    requireManagerActor(c.get("actor"));
    const input = await parseJson<CreateEntryInput>(c, createEntrySchema);
    return c.json(await createEntry(
      serviceContext(c),
      parseId(c.req.param("agentId"), "Agent 编号"),
      input,
    ), 201);
  });
  app.post("/api/v1/manager/entries/:id/versions", appendHandler("manager"));
  app.get("/api/v1/manager/entries/:id/versions", versionsHandler("manager"));
  app.get("/api/v1/manager/entries/:id/versions/:version", versionDetailHandler("manager"));

  app.get("/api/v1/admin/entries", listHandler("admin"));
  app.get("/api/v1/admin/entries/:id", detailHandler("admin"));
  app.post("/api/v1/admin/agents/:agentId/entries", async (c) => {
    privateResponse(c);
    requireAdminActor(c.get("actor"));
    requireSameOrigin(c.req.raw, c.env.APP_ORIGIN);
    const input = await parseJson<CreateEntryInput>(c, createEntrySchema);
    return c.json(await createEntry(
      serviceContext(c),
      parseId(c.req.param("agentId"), "Agent 编号"),
      input,
    ), 201);
  });
  app.post("/api/v1/admin/entries/:id/versions", appendHandler("admin"));
  app.get("/api/v1/admin/entries/:id/versions", versionsHandler("admin"));
  app.get("/api/v1/admin/entries/:id/versions/:version", versionDetailHandler("admin"));
  app.patch("/api/v1/admin/entries/:id/state", async (c) => {
    privateResponse(c);
    requireAdminActor(c.get("actor"));
    requireSameOrigin(c.req.raw, c.env.APP_ORIGIN);
    const input = await parseJson<PatchEntryStateInput>(c, patchEntryStateSchema);
    return c.json(await updateEntryState(
      serviceContext(c),
      parseId(c.req.param("id"), "条目编号"),
      input,
    ));
  });
  app.delete("/api/v1/admin/entries/:id", async (c) => {
    privateResponse(c);
    requireAdminActor(c.get("actor"));
    requireSameOrigin(c.req.raw, c.env.APP_ORIGIN);
    await deleteEntry(serviceContext(c), parseId(c.req.param("id"), "条目编号"));
    return c.body(null, 204);
  });
}
