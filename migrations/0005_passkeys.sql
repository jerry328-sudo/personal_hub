ALTER TABLE admin_credentials ADD COLUMN webauthn_user_id TEXT;
UPDATE admin_credentials SET webauthn_user_id = lower(hex(randomblob(16))) WHERE id = 1;

CREATE TABLE admin_passkeys (
  id TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  user_handle TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  credential_revision INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
ALTER TABLE admin_sessions ADD COLUMN passkey_id TEXT REFERENCES admin_passkeys(id);

CREATE TABLE webauthn_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('register', 'login')),
  session_id TEXT,
  credential_revision INTEGER NOT NULL,
  name TEXT,
  user_handle TEXT,
  expires_at TEXT NOT NULL
);
CREATE INDEX webauthn_challenges_expiry ON webauthn_challenges(expires_at);
