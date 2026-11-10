import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Update } from 'grammy/types';
import { createBot } from '../src/bot/create';
import { readConfig } from '../src/config';
import { RequestBudget } from '../src/clients/http';
import { testStore } from './database';
import { player } from './fixtures';

let db: ReturnType<typeof testStore>;
let calls: { method: string; body: Record<string, unknown> }[];
let admin = false;
beforeEach(() => {
  db = testStore(); calls = []; admin = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url.includes('clashofclans.com')) {
      if (url.endsWith('verifytoken')) return Response.json({ status: 'ok' });
      if (url.includes('/clans/')) return Response.json({ ...player.clan, members: 1, memberList: [{ tag: player.tag }] });
      return Response.json(player);
    }
    const method = url.split('/').at(-1)!;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ method, body });
    let result: unknown = true;
    if (method === 'getMe') result = { id: 999, is_bot: true, first_name: 'Bot', username: 'clans_test_bot' };
    if (method === 'getChatMember') result = { status: body.user_id === 999 || admin ? 'administrator' : 'member', can_manage_tags: true, can_restrict_members: true, user: { id: body.user_id, is_bot: false, first_name: 'User' } };
    if (method === 'sendMessage') result = { message_id: 1, date: 1, chat: { id: body.chat_id, type: 'private' }, text: body.text };
    return Response.json({ ok: true, result });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); db.sqlite.close(); });

function message(text: string, group = false, anonymous = false): Update {
  return { update_id: 1, message: {
    message_id: 1, date: 1,
    from: { id: 10, is_bot: false, first_name: 'User' },
    chat: group ? { id: -100, type: 'supergroup', title: 'Group' } : { id: 10, type: 'private', first_name: 'User' },
    text,
    ...(text.startsWith('/') ? { entities: [{ type: 'bot_command' as const, offset: 0, length: text.split(' ')[0]!.length }] } : {}),
    ...(anonymous ? { sender_chat: { id: -100, type: 'supergroup' as const, title: 'Group' } } : {}),
  } };
}
async function bot() {
  const config = readConfig({ DB: db.store.db, BOT_TOKEN: '999:test', WEBHOOK_SECRET: 's'.repeat(32), COC_API_TOKEN: 'key' });
  const { bot } = createBot(config, db.store, new RequestBudget());
  bot.botInfo = await bot.api.getMe();
  return bot;
}

it('completes the private chat binding flow through real grammY handlers', async () => {
  const app = await bot();
  await app.handleUpdate(message('/link'));
  await db.store.user(10);
  await db.store.setup(-100, 'Group', 10, { ...player.clan!, members: 1, memberList: [{ tag: player.tag }] });
  await app.handleUpdate(message('#P0Y'));
  expect((await db.store.link(10))?.player_tag).toBe('#P0Y');
  expect(calls.some((c) => c.method === 'deleteMessage')).toBe(false);
  expect((await db.store.link(10))?.registration_kind).toBe('clan_roster');
  expect(calls.filter((c) => c.method === 'sendMessage').some((c) => String(c.body.text).includes('ABC12345'))).toBe(false);
  await app.handleUpdate(message('/profile'));
  expect(calls.some((c) => c.method === 'sendMessage' && String(c.body.text).includes('Ратуша: 16'))).toBe(true);
});
it('refuses non-admin and anonymous setup commands', async () => {
  const app = await bot();
  await app.handleUpdate(message('/setup #Q0Y', true));
  expect(await db.store.group(-100)).toBeNull();
  admin = true;
  await app.handleUpdate(message('/setup #Q0Y', true, true));
  expect(await db.store.group(-100)).toBeNull();
  await app.handleUpdate(message('/setup #Q0Y', true));
  expect((await db.store.group(-100))?.clan_tag).toBe('#Q0Y');
});
it('does not start a token conversation in a group', async () => {
  await (await bot()).handleUpdate(message('/link', true));
  expect(await db.store.conversation(10)).toBeNull();
});

it('rejects unauthenticated webhooks and deduplicates accepted updates', async () => {
  const { default: worker } = await import('../src/index');
  const env = { DB: db.store.db, BOT_TOKEN: '999:test', WEBHOOK_SECRET: 's'.repeat(32), COC_API_TOKEN: 'key' };
  const request = (secret: string) => new Request('https://example.com/webhook', {
    method: 'POST', headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: JSON.stringify(message('/start')),
  });
  expect((await worker.fetch(request('bad'), env)).status).toBe(403);
  expect(calls).toHaveLength(0);
  expect((await worker.fetch(request(env.WEBHOOK_SECRET), env)).status).toBe(200);
  const replies = calls.filter((c) => c.method === 'sendMessage').length;
  expect((await worker.fetch(request(env.WEBHOOK_SECRET), env)).status).toBe(200);
  expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(replies);
});

it('keeps the menu available and does not request player tokens when the game integration is disabled', async () => {
  const config = readConfig({ DB: db.store.db, BOT_TOKEN: '999:test', WEBHOOK_SECRET: 's'.repeat(32), COC_TRANSPORT: 'disabled' });
  const { bot: app } = createBot(config, db.store, new RequestBudget());
  app.botInfo = await app.api.getMe();
  await app.handleUpdate(message('/start'));
  await app.handleUpdate(message('/link'));
  expect(await db.store.conversation(10)).toBeNull();
  expect(calls.some((c) => c.method === 'sendMessage' && String(c.body.text).includes('подключение к Clash of Clans ещё не настроено'))).toBe(true);
});

it('denies review callbacks from ordinary members and lists reviews only to admins', async () => {
  const app = await bot();
  await app.handleUpdate({ update_id: 20, callback_query: {
    id: 'review', from: { id: 10, is_bot: false, first_name: 'User' }, chat_instance: 'group',
    data: 'mod:allow:1', message: { message_id: 1, date: 1, chat: { id: -100, type: 'supergroup', title: 'Group' } },
  } });
  expect(calls.some((c) => c.method === 'answerCallbackQuery' && c.body.show_alert === true)).toBe(true);
  expect(calls.some((c) => c.method === 'restrictChatMember')).toBe(false);
  admin = true;
  await app.handleUpdate(message('/reviews', true));
  expect(calls.some((c) => c.method === 'sendMessage' && String(c.body.text).includes('Нет участников'))).toBe(true);
});
