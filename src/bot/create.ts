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
  const clash = new ClashClient(config, request,store);
  const botId = Number(config.BOT_TOKEN.split(':')[0]);
  const sync = new SyncService(store, clash, bot.api, botId, budget, Math.min(config.SYNC_BATCH_SIZE,3));
  bot.use(async (ctx, next) => {
    if (ctx.from && await store.limited(`messages:${ctx.from.id}`, 30, 60)) return;
    await next();
  });
  const jobs = new SyncJobs(store, sync, bot.api);
  adminCommands(bot, store, clash, jobs, config.BOT_OWNER_ID);
  playerHandlers(bot, config.MINI_APP_URL);
  bot.on('chat_member', async (ctx) => {
    const member = ctx.chatMember.new_chat_member;
    if (!member.user.is_bot && await store.group(ctx.chat.id)) {
      const present = ['creator','administrator','member'].includes(member.status) || (member.status === 'restricted' && member.is_member);
      await store.membership(ctx.chat.id,member.user.id,present);
    }
  });
  return { bot, sync, jobs };
}
