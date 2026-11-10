import { Bot } from 'grammy/web';
import type { Config } from '../config';
import { ClashClient } from '../clients/clash';
import { boundedFetch, type RequestBudget } from '../clients/http';
import type { Store } from '../db/store';
import { SyncService } from '../services/sync';
import { adminCommands } from './admin';
import { playerHandlers } from './player';

export function createBot(config: Config, store: Store, budget: RequestBudget) {
  const request = boundedFetch(budget);
  const bot = new Bot(config.BOT_TOKEN, { client: { fetch: request, timeoutSeconds: 6 } });
  const clash = new ClashClient(config, request);
  const botId = Number(config.BOT_TOKEN.split(':')[0]);
  const sync = new SyncService(store, clash, bot.api, botId, budget, config.SYNC_BATCH_SIZE);
  bot.use(async (ctx, next) => {
    if (ctx.from && await store.limited(`messages:${ctx.from.id}`, 30, 60)) return;
    await next();
  });
  adminCommands(bot, store, clash, sync);
  playerHandlers(bot, store, clash, sync);
  return { bot, sync };
}
