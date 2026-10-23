import type { Hono } from "hono";
import { taskTagQuerySchema, taskTagSchema } from "../../../shared/validation";
import type { AppEnv } from "../../env";
import { serviceContext } from "../../env";
import { requireAgentRole, requireManagementAccess, requireReaderKey } from "../auth/middleware";
import { badRequest } from "../../shared/errors";
import { readLimitedJson, requireManagementWriteOrigin } from "../../shared/http";
import { LIMITS } from "../../../shared/limits";
import { createTaskTag, deleteTaskTag, listTaskTags, updateTaskTag } from "./service";

export function registerTaskTagRoutes(app: Hono<AppEnv>) {
  for (const role of ["admin", "manager", "agent", "reader"] as const) {
    const access = role === "admin" ? requireManagementAccess() : role === "reader" ? requireReaderKey() : requireAgentRole([role]);
    const path = `/api/v1/${role}/task-tags`;
    app.get(path, access, async (c) => {
      const query = taskTagQuerySchema.safeParse(c.req.query());
      if (!query.success) throw badRequest("标签查询参数无效");
      return c.json(await listTaskTags(serviceContext(c), query.data));
    });
    if (role !== "admin" && role !== "manager") continue;
    app.post(path, access, async (c) => {
      requireManagementWriteOrigin(c.req.raw, c.env.APP_ORIGIN, c.get("actor"));
      const input = taskTagSchema.safeParse(await readLimitedJson(c.req.raw, LIMITS.jsonRequestBytes));
      if (!input.success) throw badRequest("标签名称无效");
      return c.json(await createTaskTag(serviceContext(c), input.data), 201);
    });
    app.patch(`${path}/:id`, access, async (c) => {
      requireManagementWriteOrigin(c.req.raw, c.env.APP_ORIGIN, c.get("actor"));
      const input = taskTagSchema.safeParse(await readLimitedJson(c.req.raw, LIMITS.jsonRequestBytes));
      if (!input.success) throw badRequest("标签名称无效");
      return c.json(await updateTaskTag(serviceContext(c), c.req.param("id"), input.data));
    });
    app.delete(`${path}/:id`, access, async (c) => {
      requireManagementWriteOrigin(c.req.raw, c.env.APP_ORIGIN, c.get("actor"));
      await deleteTaskTag(serviceContext(c), c.req.param("id"));
      return c.body(null, 204);
    });
  }
}
