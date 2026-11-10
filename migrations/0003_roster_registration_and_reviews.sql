ALTER TABLE account_links ADD COLUMN registration_kind TEXT NOT NULL DEFAULT 'token' CHECK(registration_kind IN ('token','clan_roster'));
ALTER TABLE clan_configs ADD COLUMN moderation_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clan_configs ADD COLUMN roster_count INTEGER NOT NULL DEFAULT 0;
CREATE TABLE moderation_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL REFERENCES telegram_groups(chat_id) ON DELETE CASCADE,
  telegram_id INTEGER NOT NULL REFERENCES telegram_users(telegram_id),
  player_tag TEXT NOT NULL,
  clan_tag TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('observing','restricting','pending','held','allowed')),
  first_absent_at INTEGER NOT NULL DEFAULT (unixepoch()),
  muted_until INTEGER NOT NULL DEFAULT 0,
  applied INTEGER NOT NULL DEFAULT 0,
  notified INTEGER NOT NULL DEFAULT 0,
  decided_by INTEGER,
  permissions TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(chat_id,telegram_id)
);
CREATE INDEX moderation_pending ON moderation_cases(chat_id,state);
