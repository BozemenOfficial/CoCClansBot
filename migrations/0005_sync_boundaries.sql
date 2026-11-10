CREATE TABLE group_memberships (
 chat_id INTEGER NOT NULL REFERENCES telegram_groups(chat_id) ON DELETE CASCADE,
 telegram_id INTEGER NOT NULL REFERENCES telegram_users(telegram_id),
 present INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(chat_id,telegram_id)
);
-- Backfill candidates for the matching clan; Telegram membership is checked before any write.
INSERT OR IGNORE INTO group_memberships(chat_id,telegram_id)
 SELECT c.chat_id,l.telegram_id FROM clan_configs c JOIN players p ON p.clan_tag=c.clan_tag JOIN account_links l USING(player_tag);
CREATE TABLE sync_history (
 telegram_id INTEGER PRIMARY KEY, next_allowed_at INTEGER NOT NULL
);
INSERT INTO sync_history SELECT l.telegram_id,max(p.next_sync_at,unixepoch()+3600) FROM account_links l JOIN players p USING(player_tag);
CREATE TABLE admin_audit (
 id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, actor INTEGER NOT NULL,
 subject INTEGER NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT(unixepoch())
);
ALTER TABLE sync_jobs ADD COLUMN available_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_jobs ADD COLUMN last_run INTEGER NOT NULL DEFAULT 0;
CREATE TABLE game_cache (cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT(unixepoch()));
