import { Bot } from 'grammy/web';
import type { Config } from '../config';
import { ClashClient } from '../clients/clash';
import { boundedFetch, type RequestBudget } from '../clients/http';
import type { Store } from '../db/store';
import { SyncJobs } from '../services/sync-jobs';
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
  const jobs = new SyncJobs(store, sync, bot.api);
  adminCommands(bot, store, clash, jobs);
  playerHandlers(bot, config.MINI_APP_URL);
  bot.on('chat_member', async (ctx) => {
    const member = ctx.chatMember.new_chat_member;
    if (!member.user.is_bot && ['member', 'restricted'].includes(member.status) && await store.group(ctx.chat.id)) {
      await sync.run({ user: member.user.id, chat: ctx.chat.id });
    }
  });
  return { bot, sync, jobs };
}
