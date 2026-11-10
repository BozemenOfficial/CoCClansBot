import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { authenticate } from '../src/miniapp/auth';
import { testStore } from './database';
import { player } from './fixtures';

const botToken = '999:test';
function signed(id = 10, authDate = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams({ auth_date: String(authDate), user: JSON.stringify({ id, first_name: 'User' }), query_id: 'query' });
  const check = [...params].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}

describe('Telegram Mini App authentication', () => {
  it('validates Telegram HMAC and extracts the signed user only', async () => {
    expect(await authenticate(signed(), botToken)).toMatchObject({ id: 10 });
    expect(await authenticate(signed().replace('User', 'Attacker'), botToken)).toBeNull();
    expect(await authenticate(signed(), '999:other')).toBeNull();
  });
  it('rejects expired, future, duplicate and missing launch credentials', async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const value of ['', signed(10, now - 3601), signed(10, now + 60), signed() + '&user=%7B%7D', signed() + '&hash=aaa']) {
      expect(await authenticate(value, botToken)).toBeNull();
    }
  });
});

describe('Mini App API through Worker routes and actual SQLite', () => {
  let db: ReturnType<typeof testStore>;
  let member = true;
  let canManageTags = true;
  let tagWrites: unknown[];
  const clan = { ...player.clan!, members: 1, memberList: [{ tag: player.tag }] };
  beforeEach(async () => {
    db = testStore(); member = true; canManageTags = true; tagWrites = [];
    await db.store.user(1); await db.store.setup(-100, 'Group', 1, clan);
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => {
      if (input.includes('clashofclans.com')) return Response.json(input.includes('/clans/') ? clan : player);
      const method = input.split('/').at(-1);
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (method === 'setChatMemberTag') tagWrites.push(body);
      const result = method === 'getChatMember' ? { status: body.user_id === 999 ? 'administrator' : member ? 'member' : 'left', can_manage_tags: canManageTags } : true;
      return Response.json({ ok: true, result });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); db.sqlite.close(); });
  async function call(path: string, data?: unknown, initData = signed(), headers: Record<string, string> = {}) {
    return worker.fetch(new Request('https://example.com/api/' + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { 'X-Telegram-Init-Data': initData, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    }), { DB: db.store.db, BOT_TOKEN: botToken, WEBHOOK_SECRET: 's'.repeat(32), COC_API_TOKEN: 'key' });
  }
  it('refuses unauthenticated and cross-origin access before reading account data', async () => {
    expect((await call('me', undefined, '')).status).toBe(401);
    expect((await call('me', undefined, signed(), { Origin: 'https://attacker.example' })).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('registers once, immediately syncs nickname, and returns only the current user profile', async () => {
    const response = await call('link', { tag: player.tag });
    expect(response.status).toBe(200);
    const result = await response.json() as { linked: boolean; syncEnabled: boolean; tagPreview: string; result: { updated: number } };
    expect(result).toMatchObject({ linked: true, syncEnabled: true, tagPreview: 'Archer', result: { updated: 1 } });
    expect(tagWrites).toHaveLength(1);
    expect((await db.store.link(10))?.player_tag).toBe(player.tag);
    expect((await call('me', undefined, signed(11)).then((r) => r.json()))).toMatchObject({ linked: false, player: null, groups: [] });
  });
  it('does not register someone outside the Telegram clan group', async () => {
    member = false;
    expect((await call('link', { tag: player.tag })).status).toBe(409);
    expect(await db.store.link(10)).toBeNull();
    expect(tagWrites).toHaveLength(0);
  });
  it('saves the link even if the bot lacks permission to change the tag', async () => {
    canManageTags = false;
    expect((await call('link', { tag: player.tag })).status).toBe(200);
    expect((await db.store.state(-100, 10))?.outcome).toBe('missing_rights');
    expect(tagWrites).toHaveLength(0);
  });
  it('disables all automatic and manual selection and enables it without forcing a tag change', async () => {
    await call('link', { tag: player.tag });
    tagWrites = [];
    expect((await call('settings', { syncEnabled: false })).status).toBe(200);
    expect(await db.store.due(8, 10)).toEqual([]);
    expect(await db.store.manualBatch(-100, 8)).toEqual([]);
    expect((await call('settings', { syncEnabled: true })).status).toBe(200);
    expect(tagWrites).toHaveLength(0);
    expect(await db.store.due(8)).toEqual([]);
  });
  it('has no member API for forced tag synchronization', async () => {
    expect((await call('sync', {})).status).toBe(404);
    expect(tagWrites).toHaveLength(0);
  });
  it('requires confirmation to unlink and frees the tag for a new registration', async () => {
    await call('link', { tag: player.tag });
    expect((await call('unlink', {})).status).toBe(400);
    expect(await db.store.link(10)).not.toBeNull();
    const response = await call('unlink', { confirm: true });
    expect(await response.json()).toMatchObject({ linked: false, player: null, groups: [] });
    expect(await db.store.tagOwner(player.tag)).toBeNull();
    expect((await call('link', { tag: player.tag }, signed(11))).status).toBe(200);
  });
  it('ignores user IDs in request bodies and does not steal a claimed tag', async () => {
    expect((await call('link', { tag: player.tag, telegram_id: 20 })).status).toBe(400);
    await call('link', { tag: player.tag });
    expect((await call('link', { tag: player.tag }, signed(11))).status).toBe(409);
    expect((await call('settings', { syncEnabled: false }, signed(11))).status).toBe(409);
    expect((await db.store.link(10))?.sync_enabled).toBe(1);
  });
  it('serializes account changes with synchronization to avoid unlink races', async () => {
    await call('link', { tag: player.tag });
    await db.store.lease('sync', 'cron');
    expect((await call('unlink', { confirm: true })).status).toBe(409);
    expect(await db.store.link(10)).not.toBeNull();
  });
});
