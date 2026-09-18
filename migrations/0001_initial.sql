PRAGMA foreign_keys = ON;

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 1000),
  scope TEXT NOT NULL CHECK(scope IN ('own', 'all')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled', 'removed', 'deleting')),
  deleting_at TEXT,
  display_mode TEXT NOT NULL DEFAULT 'feed' CHECK(display_mode IN ('feed', 'list', 'report')),
  main_entry_id TEXT,
  created_at TEXT NOT NULL,
  last_report_at TEXT,
  last_result TEXT CHECK(last_result IS NULL OR last_result IN ('success', 'failed')),
  last_note TEXT CHECK(last_note IS NULL OR length(last_note) <= 2000),
  CHECK((status = 'deleting' AND deleting_at IS NOT NULL) OR (status != 'deleting' AND deleting_at IS NULL))
);

CREATE UNIQUE INDEX only_one_active_manager
  ON agents(scope) WHERE scope = 'all' AND status = 'active';

CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1)),
  read_version INTEGER NOT NULL DEFAULT 0 CHECK(read_version >= 0),
  completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0, 1)),
  completed_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE RESTRICT,
  UNIQUE(id, agent_id),
  CHECK((completed = 1 AND completed_at IS NOT NULL) OR (completed = 0 AND completed_at IS NULL))
);

CREATE TABLE entry_versions (
  entry_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  created_by_agent_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  content TEXT NOT NULL,
  url TEXT,
  important INTEGER NOT NULL DEFAULT 0 CHECK(important IN (0, 1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(entry_id, version),
  FOREIGN KEY(entry_id) REFERENCES entries(id) ON DELETE CASCADE
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  entry_id TEXT,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  done INTEGER NOT NULL DEFAULT 0 CHECK(done IN (0, 1)),
  due_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE RESTRICT,
  FOREIGN KEY(entry_id, agent_id) REFERENCES entries(id, agent_id) ON DELETE RESTRICT
);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL CHECK(length(filename) BETWEEN 1 AND 255),
  content_type TEXT NOT NULL CHECK(content_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 10485760),
  created_by_agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE RESTRICT
);

CREATE TABLE agent_keys (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT,
  FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE TABLE admin_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX entries_agent_id_id ON entries(agent_id, id);
CREATE INDEX entries_agent_created ON entries(agent_id, created_at, id);
CREATE INDEX versions_entry_version ON entry_versions(entry_id, version DESC);
CREATE INDEX tasks_agent_done_id ON tasks(agent_id, done, id);
CREATE INDEX attachments_agent_id ON attachments(agent_id, id);
CREATE INDEX agent_keys_agent_id ON agent_keys(agent_id, id);
CREATE INDEX admin_sessions_expires ON admin_sessions(expires_at);

INSERT INTO agents (
  id, name, description, scope, status, display_mode, created_at
) VALUES (
  'manual', '手动记录', '管理员手动创建的内容与待办。', 'own', 'active', 'feed', datetime('now')
);
