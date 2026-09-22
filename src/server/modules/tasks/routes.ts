import type { Handler, Hono } from "hono";
import type { z } from "zod";
import { LIMITS } from "../../../shared/limits";
import {
  createTaskSchema,
  patchTaskSchema,
  taskQuerySchema,
} from "../../../shared/validation";
import type { AppContext, AppEnv } from "../../env";
import { serviceContext } from "../../env";
import {
  requireAdminSession,
  requireAgentRole,
} from "../auth/middleware";
import { badRequest } from "../../shared/errors";
import { readLimitedJson, requireSameOrigin } from "../../shared/http";
import {
  createTask,
  deleteTask,
  listTasks,
  updateTask,
} from "./service";

function setPrivateResponseHeaders(c: AppContext): void {
  c.header("Cache-Control", "private, no-store");
  c.header("X-Content-Type-Options", "nosniff");
}

function parseQuery(c: AppContext): z.infer<typeof taskQuerySchema> {
  const result = taskQuerySchema.safeParse(c.req.query());
  if (!result.success) throw badRequest("查询参数无效", result.error.issues);
  return result.data;
}

async function parseCreateBody(c: AppContext): Promise<z.infer<typeof createTaskSchema>> {
  const body = await readLimitedJson(c.req.raw, LIMITS.jsonRequestBytes);
  const result = createTaskSchema.safeParse(body);
  if (!result.success) throw badRequest("待办内容无效", result.error.issues);
  return result.data;
}

async function parsePatchBody(c: AppContext): Promise<z.infer<typeof patchTaskSchema>> {
  const body = await readLimitedJson(c.req.raw, LIMITS.jsonRequestBytes);
  const result = patchTaskSchema.safeParse(body);
  if (!result.success) throw badRequest("待办修改内容无效", result.error.issues);
  return result.data;
}

function requireAdminWriteOrigin(c: AppContext): void {
  requireSameOrigin(c.req.raw, c.env.APP_ORIGIN);
}

function taskId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw badRequest("待办 ID 格式无效");
  return value;
}

/** readers 模块复用同一个列表实现，只换一个身份准入。 */
export const readerTaskListHandler: Handler<AppEnv> = async (c) => {
  setPrivateResponseHeaders(c);
  return c.json(await listTasks(serviceContext(c), parseQuery(c)));
};

export function registerTaskRoutes(app: Hono<AppEnv>): void {
  app.get("/api/v1/agent/tasks", requireAgentRole(["agent"]), async (c) => {
    setPrivateResponseHeaders(c);
    return c.json(await listTasks(serviceContext(c), parseQuery(c)));
  });
  app.post("/api/v1/agent/tasks", requireAgentRole(["agent"]), async (c) => {
    setPrivateResponseHeaders(c);
    return c.json(await createTask(serviceContext(c), await parseCreateBody(c)), 201);
  });
  app.patch("/api/v1/agent/tasks/:id", requireAgentRole(["agent"]), async (c) => {
    setPrivateResponseHeaders(c);
    return c.json(await updateTask(serviceContext(c), taskId(c.req.param("id")), await parsePatchBody(c)));
  });
  app.delete("/api/v1/agent/tasks/:id", requireAgentRole(["agent"]), async (c) => {
    setPrivateResponseHeaders(c);
    await deleteTask(serviceContext(c), taskId(c.req.param("id")));
    return c.body(null, 204);
  });

  app.get("/api/v1/manager/tasks", requireAgentRole(["manager"]), async (c) => {
    setPrivateResponseHeaders(c);
    return c.json(await listTasks(serviceContext(c), parseQuery(c)));
  });
  app.post("/api/v1/manager/tasks", requireAgentRole(["manager"]), async (c) => {
    setPrivateResponseHeaders(c);
    return c.json(await createTask(serviceContext(c), await parseCreateBody(c)), 201);
  });
  app.patch("/api/v1/manager/tasks/:id", requireAgentRole(["manager"]), async (c) => {
    setPrivateResponseHeaders(c);
    return c.json(await updateTask(serviceContext(c), taskId(c.req.param("id")), await parsePatchBody(c)));
  });

  app.get("/api/v1/admin/tasks", requireAdminSession(), async (c) => {
    setPrivateResponseHeaders(c);
    return c.json(await listTasks(serviceContext(c), parseQuery(c)));
  });
  app.post("/api/v1/admin/tasks", requireAdminSession(), async (c) => {
    requireAdminWriteOrigin(c);
    setPrivateResponseHeaders(c);
    return c.json(await createTask(serviceContext(c), await parseCreateBody(c)), 201);
  });
  app.patch("/api/v1/admin/tasks/:id", requireAdminSession(), async (c) => {
    requireAdminWriteOrigin(c);
    setPrivateResponseHeaders(c);
    return c.json(await updateTask(serviceContext(c), taskId(c.req.param("id")), await parsePatchBody(c)));
  });
  app.delete("/api/v1/admin/tasks/:id", requireAdminSession(), async (c) => {
    requireAdminWriteOrigin(c);
    setPrivateResponseHeaders(c);
    await deleteTask(serviceContext(c), taskId(c.req.param("id")));
    return c.body(null, 204);
  });
}
