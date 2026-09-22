PRAGMA foreign_keys = ON;

-- 访问模式与读取范围。已有 Agent 全部按可读可写处理，行为不变。
ALTER TABLE agents
  ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'read_write'
  CHECK(access_mode IN ('read_write', 'read_only'));

ALTER TABLE agents
  ADD COLUMN read_mode TEXT
  CHECK(read_mode IS NULL OR read_mode IN ('selected', 'all'));

-- 每次替换授权时递增，使旧分页游标失效。
ALTER TABLE agents
  ADD COLUMN permissions_revision INTEGER NOT NULL DEFAULT 0
  CHECK(permissions_revision >= 0);

-- 只读身份的 scope 仍然是 'all'（跨分区的数据库兼容表示），因此总管唯一性
-- 必须显式排除 read_only，否则一个只读身份会挤占总管名额。
DROP INDEX IF EXISTS only_one_active_manager;
CREATE UNIQUE INDEX only_one_active_manager
  ON agents(scope)
  WHERE scope = 'all' AND access_mode = 'read_write' AND status = 'active';

-- reader_agent_id → target_agent_id 的读取授权。删除任一端的 Agent 都会级联清理，
-- 因此不存在悬空授权行；同名重建不会继承旧授权。
CREATE TABLE agent_read_grants (
  reader_agent_id TEXT NOT NULL,
  target_agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (reader_agent_id, target_agent_id),
  FOREIGN KEY(reader_agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY(target_agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX agent_read_grants_by_target
  ON agent_read_grants(target_agent_id, reader_agent_id);
