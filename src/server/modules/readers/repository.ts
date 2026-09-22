import type { AgentStatus, DisplayMode } from "../../../shared/contracts";
import type { ReaderScope } from "../../shared/authorize";
import { appendReadAccessPredicate, appendSingleOwnerPredicate } from "../../shared/read-access";

export type ReadableSourceRow = {
  id: string;
  name: string;
  description: string;
  display_mode: DisplayMode;
  status: AgentStatus;
  main_entry_id: string | null;
};

export type ReadableSourcePage = {
  items: ReadableSourceRow[];
  hasMore: boolean;
};

/**
 * 分页列出当前只读身份可访问的来源。授权条件下推到 SQL，在分页之前过滤；
 * 不从 D1 拉全量再在 JavaScript 里筛选。
 *
 * main_entry_id 只在对应条目确实存在且同属该 owner 时返回，否则为 null。
 */
export async function listReadableAgentRows(
  db: D1Database,
  reader: ReaderScope,
  options: { afterId?: string; limit: number },
): Promise<ReadableSourcePage> {
  const where: string[] = [];
  const bindings: unknown[] = [];
  appendReadAccessPredicate("a.id", reader, where, bindings);
  if (options.afterId !== undefined) {
    where.push("a.id > ?");
    bindings.push(options.afterId);
  }
  bindings.push(options.limit + 1);

  const result = await db.prepare(`
    SELECT
      a.id,
      a.name,
      a.description,
      a.display_mode,
      a.status,
      CASE WHEN a.main_entry_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM entries e
        WHERE e.id = a.main_entry_id AND e.agent_id = a.id
      ) THEN a.main_entry_id ELSE NULL END AS main_entry_id
    FROM agents AS a
    WHERE ${where.join(" AND ")}
    ORDER BY a.id ASC
    LIMIT ?
  `).bind(...bindings).all<ReadableSourceRow>();

  const rows = result.results ?? [];
  return {
    items: rows.slice(0, options.limit),
    hasMore: rows.length > options.limit,
  };
}

/** 只读身份自身的展示字段。刻意不返回运行备注或密钥相关信息。 */
export async function findReaderIdentity(
  db: D1Database,
  readerId: string,
): Promise<{ name: string; description: string } | null> {
  return db.prepare(`
    SELECT name, description
    FROM agents
    WHERE id = ? AND scope = 'all' AND access_mode = 'read_only'
  `).bind(readerId).first<{ name: string; description: string }>();
}

/** 单个来源是否在授权范围内。用于显式指定 agent_id 时的 404 语义。 */
export async function findReadableSource(
  db: D1Database,
  reader: ReaderScope,
  ownerId: string,
): Promise<boolean> {
  const where: string[] = [];
  const bindings: unknown[] = [];
  appendSingleOwnerPredicate("a.id", reader, ownerId, where, bindings);
  const row = await db.prepare(`
    SELECT 1 AS found
    FROM agents AS a
    WHERE ${where.join(" AND ")}
  `).bind(...bindings).first<{ found: number }>();
  return row !== null;
}
