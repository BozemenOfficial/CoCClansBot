import type { Bot, Context } from 'grammy/web';
import type { Store } from '../db/store';
import { reviewButtons, type ModerationService } from '../services/moderation';

export function reviewHandlers(bot: Bot, store: Store, moderation: ModerationService): void {
  const authorize = async (ctx: Context) => {
    if (ctx.chat?.type !== 'supergroup' || !ctx.from || ctx.from.is_bot || ctx.message?.sender_chat) return false;
    const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
    return member.status === 'administrator' || member.status === 'creator';
  };
  bot.command('reviews', async (ctx) => {
    if (!await authorize(ctx)) { await ctx.reply('Проверки доступны администратору в супергруппе.'); return; }
    const pending = await store.pending(ctx.chat.id);
    if (!pending.length) { await ctx.reply('Нет участников, ожидающих решения администратора.'); return; }
    for (const item of pending) await ctx.reply(`Проверка №${item.id}: ${item.player_tag}, Telegram ID ${item.telegram_id}.\nСрок ограничения: ${new Date(item.muted_until * 1000).toISOString()}.`, { reply_markup: reviewButtons(item.id) });
  });
  bot.callbackQuery(/^mod:(allow|keep|check):(\d+)$/, async (ctx) => {
    if (!await authorize(ctx)) { await ctx.answerCallbackQuery({ text: 'Только администратор группы.', show_alert: true }); return; }
    await ctx.answerCallbackQuery();
    const owner = crypto.randomUUID();
    if (!await store.lease('sync', owner)) { await ctx.reply('Сейчас идёт проверка. Повтори действие через минуту.'); return; }
    try {
      const text = await moderation.decide(Number(ctx.match[2]), ctx.chat!.id, ctx.from.id, ctx.me.id, ctx.match[1] as 'allow' | 'keep' | 'check');
      await ctx.reply(text);
    } finally { await store.release('sync', owner); }
  });
}
