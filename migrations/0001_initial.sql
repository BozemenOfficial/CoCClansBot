PRAGMA foreign_keys = ON;
CREATE TABLE telegram_users (
  telegram_id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE players (
  player_tag TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  clan_tag TEXT,
  clan_name TEXT,
  updated_at INTEGER NOT NULL,
  next_sync_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX players_due ON players(next_sync_at);
CREATE TABLE account_links (
  telegram_id INTEGER PRIMARY KEY REFERENCES telegram_users(telegram_id),
  player_tag TEXT NOT NULL UNIQUE REFERENCES players(player_tag),
  verified_at INTEGER NOT NULL
);
CREATE TABLE telegram_groups (
  chat_id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  configured_by INTEGER NOT NULL REFERENCES telegram_users(telegram_id),
  updated_at INTEGER NOT NULL
);
CREATE TABLE clan_configs (
  chat_id INTEGER PRIMARY KEY REFERENCES telegram_groups(chat_id) ON DELETE CASCADE,
  clan_tag TEXT NOT NULL,
  clan_name TEXT NOT NULL
);
CREATE TABLE sync_state (
  chat_id INTEGER NOT NULL REFERENCES telegram_groups(chat_id) ON DELETE CASCADE,
  telegram_id INTEGER NOT NULL REFERENCES account_links(telegram_id) ON DELETE CASCADE,
  applied_tag TEXT,
  outcome TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY(chat_id, telegram_id)
);
CREATE TABLE conversations (
  telegram_id INTEGER PRIMARY KEY REFERENCES telegram_users(telegram_id),
  step TEXT NOT NULL CHECK(step IN ('tag', 'token')),
  player_tag TEXT,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE leases (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE webhook_updates (
  update_id INTEGER PRIMARY KEY,
  owner TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);
CREATE INDEX webhook_expiry ON webhook_updates(expires_at);
CREATE TABLE rate_limits (
  bucket TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
