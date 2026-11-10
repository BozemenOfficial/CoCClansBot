import type { Bot, Context } from 'grammy/web';
import type { ClashApi } from '../clients/clash';
import type { Store } from '../db/store';
import type { SyncService } from '../services/sync';
import { LinkingService, type LinkResult } from '../services/linking';
import { playerTagSchema } from '../validation/player';
import { menu, profileText } from './menu';
import { userError } from '../errors';

const privateOnly = async (ctx: Context): Promise<boolean> => {
  if (ctx.chat?.type === 'private') return true;
  await ctx.reply('Открой личный чат с ботом — привязка и профиль доступны там.');
  return false;
};

export function playerHandlers(bot: Bot, store: Store, clash: ClashApi, sync: SyncService): void {
  const linking = new LinkingService(store, clash);

  const startLink = async (ctx: Context) => {
    if (!await privateOnly(ctx) || !ctx.from) return;
    if (clash.available === false) { await ctx.reply('Привязка пока недоступна: подключение к Clash of Clans ещё не настроено.', { reply_markup: menu() }); return; }
    if (await store.limited(`link:${ctx.from.id}`, 10, 3600)) { await ctx.reply('Слишком много попыток. Вернись к привязке позже.'); return; }
    if (!await linking.begin(ctx.from.id)) {
      await ctx.reply('Аккаунт уже привязан. Посмотреть его можно в профиле.', { reply_markup: menu() }); return;
    }
    await ctx.reply('Пришли тег игрока, например #2PP. Он указан под ником в игровом профиле.\nОтменить: /cancel.');
  };

  const showProfile = async (ctx: Context, refresh = false) => {
    if (!await privateOnly(ctx) || !ctx.from) return;
    const link = await store.link(ctx.from.id);
    if (!link) { await ctx.reply('Сначала привяжи игровой аккаунт.', { reply_markup: menu() }); return; }
    try {
      if (refresh) {
        const result = await sync.run({ user: ctx.from.id });
        await ctx.reply(result.busy ? 'Синхронизация уже идёт. Профиль загружу отдельно.' : `Проверка тегов: обновлено ${result.updated}, ошибок ${result.failed}.${result.partial ? ' Продолжение — при следующей проверке.' : ''}`);
      }
      await ctx.reply(profileText(await clash.player(link.player_tag)), { reply_markup: menu() });
    } catch (error) { await ctx.reply(userError(error)); }
  };

  bot.command('start', async (ctx) => {
    if (!await privateOnly(ctx)) return;
    await ctx.reply('Привет! Я связываю игровой аккаунт с Telegram и ставлю игровой ник в тег участника группы.' + (clash.available === false ? '\n\nПодключение к игре пока не настроено. Меню уже доступно, а привязка и игровые данные заработают после подключения.' : '\nНачни с привязки аккаунта.'), { reply_markup: menu() });
  });
  bot.command('help', (ctx) => ctx.reply('В личном чате: /start, /link, /profile, /cancel.\nВ группе для администраторов: /setup #ТЕГ_КЛАНА, /status, /sync.\nБот не удаляет участников из группы.'));
  bot.command('link', startLink);
  bot.command('profile', (ctx) => showProfile(ctx));
  bot.command('cancel', async (ctx) => {
    if (!await privateOnly(ctx)) return;
    await store.clearConversation(ctx.from!.id);
    await ctx.reply('Привязка отменена.', { reply_markup: menu() });
  });
  for (const action of ['link', 'profile', 'refresh', 'settings']) {
    bot.callbackQuery(action, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!await privateOnly(ctx)) return;
      if (action === 'link') await startLink(ctx);
      if (action === 'profile') await showProfile(ctx);
      if (action === 'refresh') await showProfile(ctx, true);
      if (action === 'settings') await ctx.reply('Один Telegram-аккаунт — один игровой аккаунт.\nСамостоятельная перепривязка пока отключена, чтобы чужой аккаунт нельзя было перехватить.\nПрервать текущую привязку: /cancel.');
    });
  }
  bot.on('message:text', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const id = ctx.from.id;
    const state = await store.conversation(id);
    if (!state) { await ctx.reply('Выбери действие в меню. Для новой привязки нажми «Привязать аккаунт».', { reply_markup: menu() }); return; }
    if (state.step === 'tag') {
      const tag = playerTagSchema.safeParse(ctx.message.text);
      if (!tag.success) { await ctx.reply('Не похоже на тег игрока. Скопируй его из профиля в игре, вместе с #.'); return; }
      try {
        const p = await linking.select(id, tag.data);
        if (!p) { await ctx.reply('Этот игровой аккаунт уже привязан. Автоматическая перепривязка недоступна.'); return; }
        await ctx.reply(`Найден игрок: ${p.name}\nКлан: ${p.clan?.name ?? 'нет клана'}\n\nТеперь пришли API Token из настроек игры: «Дополнительные настройки» → «API Token». Это не код входа и не пароль Supercell ID.\nПроверю его и постараюсь удалить сообщение. Токен в базе не сохраняется. На проверку есть 10 минут.`);
      } catch (error) { await ctx.reply(userError(error)); }
      return;
    }
    // Remove the player's token before any API call. A failed deletion must not leak it into logs.
    try { await ctx.deleteMessage(); } catch { /* Telegram may deny deletion; never echo the token. */ }
    const replies: Record<LinkResult, string> = {
      linked: 'Аккаунт привязан. Проверю твой тег в подключённых группах.',
      invalid: 'Токен не подошёл. Скопируй API Token из игры и попробуй ещё раз.',
      taken: 'Этот аккаунт уже привязан другому пользователю.',
      already_linked: 'У тебя уже есть привязанный аккаунт.',
      expired: 'Время проверки истекло. Начни привязку заново.',
      limited: 'Лимит попыток исчерпан. Подожди 10 минут и начни привязку заново.',
    };
    try {
      const result = await linking.verify(id, ctx.message.text.trim());
      await ctx.reply(replies[result], { reply_markup: menu() });
      if (result === 'linked') {
        try {
          const checked = await sync.run({ user: id });
          if (checked.busy || checked.partial || checked.failed) await ctx.reply('Привязка сохранена. Проверка тегов продолжится автоматически.');
        } catch { await ctx.reply('Привязка сохранена. Теги проверю при следующей синхронизации.'); }
      }
    } catch (error) { await ctx.reply(userError(error)); }
  });
}
