ALTER TABLE players ADD COLUMN next_group INTEGER NOT NULL DEFAULT 0;
CREATE TABLE manual_sync_cursors (
  chat_id INTEGER PRIMARY KEY REFERENCES telegram_groups(chat_id) ON DELETE CASCADE,
  player_tag TEXT NOT NULL
);
