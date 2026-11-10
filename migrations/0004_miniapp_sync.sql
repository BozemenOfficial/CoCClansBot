ALTER TABLE account_links ADD COLUMN sync_enabled INTEGER NOT NULL DEFAULT 1 CHECK(sync_enabled IN (0,1));
-- Version 1 is profile + nickname sync only. Preserve historical review data.
UPDATE clan_configs SET moderation_enabled=0;
DELETE FROM conversations;
CREATE TABLE sync_jobs (
  chat_id INTEGER PRIMARY KEY REFERENCES telegram_groups(chat_id) ON DELETE CASCADE,
  requested_by INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','done')),
  checked INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  notified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT(unixepoch())
);
