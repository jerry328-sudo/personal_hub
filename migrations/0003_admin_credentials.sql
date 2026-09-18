CREATE TABLE admin_credentials (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  secret_hash TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  updated_at TEXT
);

INSERT INTO admin_credentials (id, revision) VALUES (1, 0);
ALTER TABLE admin_sessions ADD COLUMN credential_revision INTEGER NOT NULL DEFAULT 0;
