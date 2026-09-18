PRAGMA foreign_keys = ON;

CREATE TABLE attachment_upload_leases (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE RESTRICT,
  CHECK(expires_at > created_at)
);

CREATE INDEX attachment_upload_leases_agent_expiry
  ON attachment_upload_leases(agent_id, expires_at, id);
