-- Archive cleanup runs in the same transaction as the entry update.
-- The partial index avoids scanning every task when a record is archived.
CREATE INDEX tasks_entry_id ON tasks(entry_id) WHERE entry_id IS NOT NULL;

CREATE TRIGGER delete_tasks_on_archive
AFTER UPDATE OF archived ON entries
WHEN NEW.archived = 1
BEGIN
  DELETE FROM tasks WHERE entry_id = NEW.id;
END;

-- Prevent archived tasks from reappearing through older clients or a race.
CREATE TRIGGER reject_archived_task_insert
BEFORE INSERT ON tasks
WHEN NEW.entry_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM entries WHERE id = NEW.entry_id AND archived = 1
)
BEGIN
  SELECT RAISE(ABORT, 'archived_entry_task');
END;

-- One-time cleanup, including both completed and unfinished historical tasks.
DELETE FROM tasks WHERE entry_id IN (SELECT id FROM entries WHERE archived = 1);
