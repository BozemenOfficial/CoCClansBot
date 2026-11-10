import type { Clan, Player } from '../clients/clash';

export interface Link { telegram_id: number; player_tag: string; next_group?: number; registration_kind?: 'token' | 'clan_roster' }
export interface Group { chat_id: number; clan_tag: string; clan_name: string; moderation_enabled: number; roster_count: number }
export interface Conversation { step: 'tag' | 'token'; player_tag: string | null; attempts: number }
export interface SyncState { applied_tag: string | null; outcome: string }
export interface ModerationCase { id: number; chat_id: number; telegram_id: number; player_tag: string; clan_tag: string; state: 'observing' | 'restricting' | 'pending' | 'held' | 'allowed'; first_absent_at: number; muted_until: number; applied: number; notified: number; permissions: string | null }
export type Claim = 'claimed' | 'done' | 'busy';

export class Store {
  constructor(readonly db: D1Database) {}
  private query(sql: string, ...values: (string | number | null)[]): D1PreparedStatement {
    return this.db.prepare(sql).bind(...values);
  }
  async user(id: number): Promise<void> {
    await this.query('INSERT OR IGNORE INTO telegram_users(telegram_id) VALUES (?)', id).run();
  }
  async link(id: number): Promise<Link | null> {
    return this.query('SELECT * FROM account_links WHERE telegram_id = ?', id).first<Link>();
  }
  async tagOwner(tag: string): Promise<Link | null> {
    return this.query('SELECT * FROM account_links WHERE player_tag = ?', tag).first<Link>();
  }
  async bind(id: number, p: Player, kind: 'token' | 'clan_roster' = 'token'): Promise<void> {
    await this.db.batch([
      this.query(`INSERT INTO players(player_tag,name,clan_tag,clan_name,updated_at) VALUES (?,?,?,?,unixepoch())
        ON CONFLICT(player_tag) DO UPDATE SET name=excluded.name,clan_tag=excluded.clan_tag,
        clan_name=excluded.clan_name,updated_at=excluded.updated_at`, p.tag, p.name, p.clan?.tag ?? null, p.clan?.name ?? null),
      this.query("INSERT INTO account_links(telegram_id,player_tag,verified_at,registration_kind) VALUES (?,?,CASE WHEN ?='token' THEN unixepoch() ELSE 0 END,?)", id, p.tag, kind, kind),
      this.query('DELETE FROM conversations WHERE telegram_id = ?', id),
    ]);
  }
  async conversation(id: number): Promise<Conversation | null> {
    return this.query('SELECT * FROM conversations WHERE telegram_id=? AND expires_at > unixepoch()', id).first<Conversation>();
  }
  async setConversation(id: number, step: 'tag' | 'token', tag: string | null = null): Promise<void> {
    await this.query(`INSERT INTO conversations(telegram_id,step,player_tag,expires_at,attempts)
      VALUES (?,?,?,unixepoch()+600,0) ON CONFLICT(telegram_id) DO UPDATE SET
      step=excluded.step,player_tag=excluded.player_tag,expires_at=excluded.expires_at,attempts=0`, id, step, tag).run();
  }
  async failedToken(id: number): Promise<void> {
    await this.query('UPDATE conversations SET attempts=attempts+1 WHERE telegram_id=?', id).run();
  }
  async clearConversation(id: number): Promise<void> {
    await this.query('DELETE FROM conversations WHERE telegram_id=?', id).run();
  }
  async limited(bucket: string, max: number, seconds: number): Promise<boolean> {
    const row = await this.query(`INSERT INTO rate_limits(bucket,window_start,count) VALUES (?,unixepoch(),1)
      ON CONFLICT(bucket) DO UPDATE SET
      count=CASE WHEN window_start <= unixepoch()-? THEN 1 ELSE count+1 END,
      window_start=CASE WHEN window_start <= unixepoch()-? THEN unixepoch() ELSE window_start END
      RETURNING count`, bucket, seconds, seconds).first<{ count: number }>();
    return !row || row.count > max;
  }
  async setup(chatId: number, title: string, by: number, clan: Clan, moderation = false): Promise<void> {
    await this.db.batch([
      this.query(`INSERT INTO telegram_groups(chat_id,title,configured_by,updated_at) VALUES (?,?,?,unixepoch())
        ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title,configured_by=excluded.configured_by,updated_at=excluded.updated_at`, chatId, title, by),
      this.query(`INSERT INTO clan_configs(chat_id,clan_tag,clan_name,moderation_enabled,roster_count) VALUES (?,?,?,?,?)
        ON CONFLICT(chat_id) DO UPDATE SET clan_tag=excluded.clan_tag,clan_name=excluded.clan_name,
        moderation_enabled=excluded.moderation_enabled,roster_count=excluded.roster_count`, chatId, clan.tag, clan.name, moderation ? 1 : 0, clan.members ?? 0),
      this.query('DELETE FROM sync_state WHERE chat_id=?', chatId),
      this.query('UPDATE players SET next_sync_at=0,next_group=0'),
      this.query('DELETE FROM manual_sync_cursors WHERE chat_id=?', chatId),
    ]);
  }
  async groups(): Promise<Group[]> {
    return (await this.query('SELECT chat_id,clan_tag,clan_name,moderation_enabled,roster_count FROM clan_configs ORDER BY chat_id').all<Group>()).results;
  }
  async group(chatId: number): Promise<Group | null> {
    return this.query('SELECT chat_id,clan_tag,clan_name,moderation_enabled,roster_count FROM clan_configs WHERE chat_id=?', chatId).first<Group>();
  }
  async state(chat: number, user: number): Promise<SyncState | null> {
    return this.query('SELECT applied_tag,outcome FROM sync_state WHERE chat_id=? AND telegram_id=?', chat, user).first<SyncState>();
  }
  async saveState(chat: number, user: number, tag: string | null, outcome: string): Promise<void> {
    await this.query(`INSERT INTO sync_state(chat_id,telegram_id,applied_tag,outcome,checked_at) VALUES (?,?,?,?,unixepoch())
      ON CONFLICT(chat_id,telegram_id) DO UPDATE SET applied_tag=excluded.applied_tag,
      outcome=excluded.outcome,checked_at=excluded.checked_at`, chat, user, tag, outcome).run();
  }
  async due(limit: number, user?: number): Promise<Link[]> {
    return (await (user === undefined
      ? this.query(`SELECT l.telegram_id,l.player_tag,p.next_group FROM account_links l JOIN players p USING(player_tag)
        WHERE p.next_sync_at <= unixepoch() ORDER BY p.next_sync_at,p.player_tag LIMIT ?`, limit)
      : this.query('SELECT telegram_id,player_tag FROM account_links WHERE telegram_id=?', user)).all<Link>()).results;
  }
  async manualBatch(chat: number, limit: number): Promise<Link[]> {
    const rows = (await this.query(`SELECT telegram_id,player_tag FROM account_links
      WHERE player_tag > coalesce((SELECT player_tag FROM manual_sync_cursors WHERE chat_id=?),'')
      ORDER BY player_tag LIMIT ?`, chat, limit).all<Link>()).results;
    if (rows.length) return rows;
    await this.manualCursor(chat, '');
    return (await this.query('SELECT telegram_id,player_tag FROM account_links ORDER BY player_tag LIMIT ?', limit).all<Link>()).results;
  }
  async manualCursor(chat: number, tag: string): Promise<void> {
    await this.query(`INSERT INTO manual_sync_cursors(chat_id,player_tag) VALUES (?,?)
      ON CONFLICT(chat_id) DO UPDATE SET player_tag=excluded.player_tag`, chat, tag).run();
  }
  async groupCursor(tag: string, index: number): Promise<void> {
    await this.query('UPDATE players SET next_group=? WHERE player_tag=?', index, tag).run();
  }
  async refreshed(p: Player): Promise<void> {
    await this.query(`UPDATE players SET name=?,clan_tag=?,clan_name=?,updated_at=unixepoch() WHERE player_tag=?`,
      p.name, p.clan?.tag ?? null, p.clan?.name ?? null, p.tag).run();
  }
  async postpone(tag: string, seconds: number): Promise<void> {
    await this.query('UPDATE players SET next_sync_at=unixepoch()+? WHERE player_tag=?', seconds, tag).run();
  }
  async lease(name: string, owner: string, seconds = 120): Promise<boolean> {
    const result = await this.query(`INSERT INTO leases(name,owner,expires_at) VALUES (?,?,unixepoch()+?)
      ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
      WHERE leases.expires_at <= unixepoch() RETURNING owner`, name, owner, seconds).first<{ owner: string }>();
    return result?.owner === owner;
  }
  async release(name: string, owner: string): Promise<void> {
    await this.query('DELETE FROM leases WHERE name=? AND owner=?', name, owner).run();
  }
  async claim(update: number, owner: string): Promise<Claim> {
    const result = await this.query(`INSERT INTO webhook_updates(update_id,owner,done,expires_at)
      VALUES (?,?,0,unixepoch()+120) ON CONFLICT(update_id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
      WHERE webhook_updates.done=0 AND webhook_updates.expires_at <= unixepoch() RETURNING owner`, update, owner).first<{ owner: string }>();
    if (result?.owner === owner) return 'claimed';
    const row = await this.query('SELECT done FROM webhook_updates WHERE update_id=?', update).first<{ done: number }>();
    return row?.done ? 'done' : 'busy';
  }
  async finish(update: number, owner: string): Promise<void> {
    await this.query('UPDATE webhook_updates SET done=1,expires_at=unixepoch()+604800 WHERE update_id=? AND owner=?', update, owner).run();
  }
  async abandon(update: number, owner: string): Promise<void> {
    await this.query('DELETE FROM webhook_updates WHERE update_id=? AND owner=? AND done=0', update, owner).run();
  }
  async summary(chat: number): Promise<{ total: number; ok: number; checked_at: number | null }> {
    return (await this.query(`SELECT count(*) AS total,coalesce(sum(outcome='ok'),0) AS ok,max(checked_at) AS checked_at
      FROM sync_state WHERE chat_id=?`, chat).first<{ total: number; ok: number; checked_at: number | null }>())!;
  }
  async caseFor(chat: number, user: number): Promise<ModerationCase | null> {
    return this.query('SELECT * FROM moderation_cases WHERE chat_id=? AND telegram_id=?', chat, user).first<ModerationCase>();
  }
  async review(id: number): Promise<ModerationCase | null> {
    return this.query('SELECT * FROM moderation_cases WHERE id=?', id).first<ModerationCase>();
  }
  async observe(chat: number, user: number, tag: string, clan: string): Promise<ModerationCase> {
    await this.query(`INSERT INTO moderation_cases(chat_id,telegram_id,player_tag,clan_tag,state)
      VALUES (?,?,?,?,'observing') ON CONFLICT(chat_id,telegram_id) DO NOTHING`, chat, user, tag, clan).run();
    return (await this.caseFor(chat, user))!;
  }
  async clearObservation(chat: number, user: number): Promise<void> {
    await this.query("DELETE FROM moderation_cases WHERE chat_id=? AND telegram_id=? AND state='observing'", chat, user).run();
  }
  async markCase(id: number, state: string, until: number, applied: boolean, by: number | null = null): Promise<void> {
    await this.query(`UPDATE moderation_cases SET state=?,muted_until=?,applied=?,decided_by=?,updated_at=unixepoch() WHERE id=?`, state, until, applied ? 1 : 0, by, id).run();
  }
  async expectedPermissions(id: number, permissions: string): Promise<void> {
    await this.query('UPDATE moderation_cases SET permissions=? WHERE id=?', permissions, id).run();
  }
  async resetCase(chat: number, user: number): Promise<void> {
    await this.query("DELETE FROM moderation_cases WHERE chat_id=? AND telegram_id=? AND state IN ('observing','allowed')", chat, user).run();
  }
  async notified(id: number): Promise<void> {
    await this.query('UPDATE moderation_cases SET notified=1 WHERE id=?', id).run();
  }
  async pending(chat: number): Promise<ModerationCase[]> {
    return (await this.query("SELECT * FROM moderation_cases WHERE chat_id=? AND state IN ('pending','restricting') ORDER BY id LIMIT 10", chat).all<ModerationCase>()).results;
  }
  async rosterCount(chat: number, count: number): Promise<void> {
    await this.query('UPDATE clan_configs SET roster_count=? WHERE chat_id=?', count, chat).run();
  }
  async cleanup(): Promise<void> {
    await this.db.batch([
      this.query('DELETE FROM webhook_updates WHERE expires_at < unixepoch()'),
      this.query('DELETE FROM conversations WHERE expires_at < unixepoch()'),
      this.query('DELETE FROM leases WHERE expires_at < unixepoch()'),
      this.query('DELETE FROM rate_limits WHERE window_start < unixepoch()-86400'),
    ]);
  }
}
