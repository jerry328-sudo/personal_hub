import type { Hono } from "hono";
import { z } from "zod";
import { LIMITS } from "../../../shared/limits";
import type { AppContext, AppEnv } from "../../env";
import { serviceContext } from "../../env";
import { badRequest } from "../../shared/errors";
import { requireReaderKey } from "../auth/middleware";
import {
  detailHandler,
  listHandler,
  versionDetailHandler,
  versionsHandler,
} from "../entries/routes";
import { readerTaskListHandler } from "../tasks/routes";
import { getReaderSelf, listReadableAgents } from "./service";

const readerSourceQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.maxPageSize).optional(),
}).strict();

function parseSourceQuery(c: AppContext): z.output<typeof readerSourceQuerySchema> {
  const parsed = readerSourceQuerySchema.safeParse(c.req.query());
  if (!parsed.success) throw badRequest("查询参数无效", parsed.error.issues);
  return parsed.data;
}

/**
 * 只读命名空间。这里只登记读取路由，不提供 report、上传或任何业务写入路由。
 * 条目与版本的 handler 复用已有读取实现，只换 audience，避免复制业务逻辑。
 */
export function registerReaderRoutes(app: Hono<AppEnv>): void {
  const readerOnly = requireReaderKey();

  app.get("/api/v1/reader", readerOnly, async (c) => {
    return c.json(await getReaderSelf(serviceContext(c)));
  });

  app.get("/api/v1/reader/agents", readerOnly, async (c) => {
    return c.json(await listReadableAgents(serviceContext(c), parseSourceQuery(c)));
  });

  app.get("/api/v1/reader/entries", readerOnly, listHandler("reader"));
  app.get("/api/v1/reader/entries/:id", readerOnly, detailHandler("reader"));
  app.get("/api/v1/reader/entries/:id/versions", readerOnly, versionsHandler("reader"));
  app.get("/api/v1/reader/entries/:id/versions/:version", readerOnly, versionDetailHandler("reader"));

  app.get("/api/v1/reader/tasks", readerOnly, readerTaskListHandler);
}
