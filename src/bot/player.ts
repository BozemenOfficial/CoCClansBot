import { InlineKeyboard, type Bot, type Context } from 'grammy/web';

export function playerHandlers(bot: Bot, appUrl: string): void {
  const open = async (ctx: Context) => {
    if (ctx.chat?.type !== 'private') {
      await ctx.reply('Профиль и привязка аккаунта — в приложении бота.', {
        reply_markup: new InlineKeyboard().url('Открыть бота', `https://t.me/${ctx.me.username}?start=app`),
      });
      return;
    }
    await ctx.reply('Твой игровой профиль и синхронизация ника — в одном приложении. Привяжи аккаунт один раз, и я обновлю тег в группе на ник из игры.', {
      reply_markup: new InlineKeyboard().webApp('Открыть приложение', appUrl),
    });
  };
  for (const command of ['start', 'link', 'profile', 'settings', 'cancel']) bot.command(command, open);
  bot.command('help', (ctx) => ctx.reply('Профиль, привязка, синхронизация и настройки — в приложении.\nКоманды администратора в группе: /setup #ТЕГ_КЛАНА, /status, /sync.'));
  bot.callbackQuery(['link','profile','refresh','settings', /^mod:/], async (ctx) => {
    await ctx.answerCallbackQuery();
    await open(ctx);
  });
  bot.on('message:text', async (ctx) => { if (ctx.chat.type === 'private') await open(ctx); });
}
