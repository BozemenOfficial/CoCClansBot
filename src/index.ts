import type { Update } from 'grammy/types';
import { readConfig, type Env } from './config';
import { Store } from './db/store';
import { RequestBudget } from './clients/http';
import { createBot } from './bot/create';
import { actor, readUpdate, validSecret } from './webhook';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return Response.json({ ok: true });
    if (url.pathname !== '/webhook') return new Response('Not found', { status: 404 });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (!await validSecret(request.headers.get('X-Telegram-Bot-Api-Secret-Token'), env.WEBHOOK_SECRET ?? '')) return new Response('Forbidden', { status: 403 });
    const update = await readUpdate(request);
    if (!update) return new Response('Invalid update', { status: 400 });
    const store = new Store(env.DB);
    const owner = crypto.randomUUID();
    let stage = 'configuration';
    let claimed = false;
    let userLease: string | null = null;
    try {
      const config = readConfig(env);
      stage = 'claim_update';
      const claim = await store.claim(update.update_id, owner);
      if (claim === 'done') return new Response('OK');
      if (claim === 'busy') return new Response('Retry later', { status: 503 });
      claimed = true;
      stage = 'user_lock';
      const id = actor(update);
      if (id !== null) {
        const name = `user:${id}`;
        if (!await store.lease(name, owner)) {
          await store.abandon(update.update_id, owner);
          claimed = false;
          return new Response('Retry later', { status: 503 });
        }
        userLease = name;
      }
      stage = 'create_bot';
      const { bot } = createBot(config, store, new RequestBudget());
      stage = 'telegram_get_me';
      bot.botInfo = await bot.api.getMe();
      stage = 'handle_update';
      await bot.handleUpdate(update as Update);
      stage = 'finish_update';
      await store.finish(update.update_id, owner);
      return new Response('OK');
    } catch {
      // Telegram errors can contain the whole update or token-bearing request payload.
      console.error('webhook_failed', stage);
      if (claimed) await store.abandon(update.update_id, owner);
      return new Response('Retry later', { status: 503, headers: { 'X-Bot-Error-Stage': stage } });
    } finally {
      if (userLease) await store.release(userLease, owner);
    }
  },
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const config = readConfig(env);
    const store = new Store(env.DB);
    if (config.COC_TRANSPORT === 'disabled') {
      await store.cleanup();
      console.info('scheduled_sync_skipped: clash_api_not_configured');
      return;
    }
    const { sync } = createBot(config, store, new RequestBudget());
    try {
      const result = await sync.run();
      console.info('scheduled_sync', JSON.stringify(result));
      await store.cleanup();
    } catch { console.error('scheduled_sync_failed'); throw new Error('scheduled_sync_failed'); }
  },
} satisfies ExportedHandler<Env>;
