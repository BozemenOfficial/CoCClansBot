import { z } from 'zod';
import { readConfig, type Env } from '../config';
import { Store } from '../db/store';
import { ClashClient } from '../clients/clash';
import { boundedFetch, RequestBudget } from '../clients/http';
import { createBot } from '../bot/create';
import { LinkingService } from '../services/linking';
import { memberTag, playerTagSchema } from '../validation/player';
import { userError } from '../errors';
import { unlinkAccount } from '../services/unlink';
import { authenticate } from './auth';

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const fail = (message: string, status: number) => json({ error: message }, status);
async function body(request: Request): Promise<unknown> {
  if (!request.headers.get('Content-Type')?.startsWith('application/json') || !request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.length;
    if (size > 2048) { await reader.cancel(); return null; }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
}

export async function appApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.headers.has('Origin') && request.headers.get('Origin') !== url.origin) return fail('Недопустимый источник запроса.', 403);
  const user = await authenticate(request.headers.get('X-Telegram-Init-Data') ?? '', env.BOT_TOKEN);
  if (!user) return fail('Открой приложение заново через Telegram.', 401);
  const store = new Store(env.DB);
  if (await store.limited(`app:${user.id}`, 40, 60)) return fail('Слишком много запросов. Подожди минуту.', 429);
  const path = url.pathname;
  if (!['/api/me', '/api/link', '/api/settings', '/api/unlink'].includes(path)) return fail('Не найдено.', 404);
  if (request.method !== (path === '/api/me' ? 'GET' : 'POST')) return fail('Метод не поддерживается.', 405);
  const owner = crypto.randomUUID();
  let userLock = false;
  let syncLock = false;
  let cleanupIncomplete = false;
  try {
    const config = readConfig(env);
    const budget = new RequestBudget();
    const clash = new ClashClient(config, boundedFetch(budget),store,60);
    const { bot, sync } = createBot(config, store, budget);
    const state = async () => {
      const link = await store.link(user.id);
      const cached = link ? await store.cachedPlayer(user.id) : null;
      let player: unknown = cached ? { tag: cached.tag, name: cached.name, ...(cached.clan_tag ? { clan: { tag: cached.clan_tag, name: cached.clan_name } } : {}) } : null;
      let notice: string | null = null;
      let stale = false;
      let updatedAt = cached?.updated_at ?? null;
      if (link) {
        try { player = await clash.player(link.player_tag); await store.refreshed(player as Awaited<ReturnType<typeof clash.player>>); updatedAt = (await store.cached(`/players/${encodeURIComponent(link.player_tag)}`))?.updated_at ?? Math.floor(Date.now()/1000); }
        catch { stale = true; notice = 'Игра сейчас недоступна. Показан последний сохранённый профиль.'; }
      }
      return { user: { firstName: user.first_name }, linked: !!link, syncEnabled: link?.sync_enabled === 1,
        updatedAt, stale, player, tagPreview: player && typeof player === 'object' && 'name' in player ? memberTag(String(player.name)) : null, groups: await store.syncStates(user.id), notice };
    };
    if (path === '/api/me') return json(await state());
    const data = await body(request);
    if (data === null) return fail('Некорректный запрос.', 400);
    userLock = await store.lease(`user:${user.id}`, owner);
    if (!userLock) return fail('Предыдущее действие ещё выполняется. Попробуй чуть позже.', 409);
    syncLock = await store.lease('sync', owner);
    if (!syncLock) return fail('Идёт синхронизация. Повтори действие через минуту.', 409);
    if (path === '/api/link') {
      const parsed = z.object({ tag: playerTagSchema }).strict().safeParse(data);
      if (!parsed.success) return fail('Скопируй тег игрока из игры вместе с #.', 400);
      if (await store.limited(`app-link:${user.id}`, 10, 3600)) return fail('Слишком много попыток привязки. Попробуй позже.', 429);
      const linking = new LinkingService(store, clash, async (chat, id) => {
        const member = await bot.api.getChatMember(chat, id);
        return ['creator', 'administrator', 'member'].includes(member.status) || (member.status === 'restricted' && member.is_member);
      });
      const result = await linking.registerFromClan(user.id, parsed.data.tag);
      const messages = {
        taken: 'Этот игровой аккаунт уже привязан. Обратись к администратору.',
        already_linked: 'Аккаунт уже привязан. Для замены сначала отвяжи его в настройках.',
        not_in_clan: 'Игрока нет в составе подключённого клана. Проверь тег.',
        not_configured: 'Администратору нужно подключить клан в группе командой /setup #ТЕГ_КЛАНА.',
        not_group_member: 'Сначала вступи в Telegram-группу своего клана, затем повтори привязку.',
      };
      if (result.status !== 'linked') return fail(messages[result.status], 409);
    } else if (path === '/api/settings') {
      const parsed = z.object({ syncEnabled: z.boolean() }).strict().safeParse(data);
      if (!parsed.success) return fail('Некорректная настройка.', 400);
      if (!await store.link(user.id)) return fail('Сначала привяжи аккаунт.', 409);
      await store.syncEnabled(user.id, parsed.data.syncEnabled);
    } else {
      const parsed = z.object({ confirm: z.literal(true) }).strict().safeParse(data);
      if (!parsed.success) return fail('Подтверди отвязку аккаунта.', 400);
      cleanupIncomplete = await unlinkAccount(store,bot.api,user.id);
    }
    const immediate = path === '/api/link' && await store.reserveInitial(user.id,(await store.link(user.id))!.player_tag);
    await store.release('sync', owner);
    syncLock = false;
    let result;
    if (immediate) {
      try { result = await sync.run({ user: user.id }); }
      catch { result = { busy: false, failed: 1, partial: true, updated: 0 }; }
    }
    return json({ ...await state(), cleanupIncomplete, ...(result ? { result } : {}) });
  } catch (error) {
    return fail(userError(error), 503);
  } finally {
    if (syncLock) await store.release('sync', owner);
    if (userLock) await store.release(`user:${user.id}`, owner);
  }
}
