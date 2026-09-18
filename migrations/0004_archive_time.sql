ALTER TABLE entries ADD COLUMN archived_at TEXT;

-- Historical archive times were not recorded. Preserve their latest content
-- timestamp as an explicit approximation; future transitions record real time.
UPDATE entries SET archived_at = COALESCE(
  (SELECT MAX(created_at) FROM entry_versions WHERE entry_id = entries.id), created_at
) WHERE archived = 1;

CREATE INDEX entries_archive_time ON entries(archived, archived_at, id);
CREATE INDEX entries_agent_archive_time ON entries(agent_id, archived, archived_at, id);
