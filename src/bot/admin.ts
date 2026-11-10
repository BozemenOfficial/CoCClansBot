import type { Bot, Context } from 'grammy/web';
import type { ClashApi } from '../clients/clash';
import type { Store } from '../db/store';
import type { SyncJobs } from '../services/sync-jobs';
import { playerTagSchema } from '../validation/player';
import { rosterTags } from '../services/roster';
import { unlinkAccount } from '../services/unlink';
import { userError } from '../errors';

export function adminCommands(bot: Bot, store: Store, clash: ClashApi, jobs: SyncJobs, ownerId?: number): void {
  async function authorize(ctx: Context): Promise<boolean> {
    if (!ctx.chat || !['group', 'supergroup'].includes(ctx.chat.type) || !ctx.from || ctx.from.is_bot || ctx.message?.sender_chat) {
      await ctx.reply('Эта команда доступна администратору в группе. Отправь её от своего имени.');
      return false;
    }
    const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
    if (member.status !== 'administrator' && member.status !== 'creator') {
      await ctx.reply('Эта команда доступна только администраторам группы.');
      return false;
    }
    return true;
  }

  bot.command('setup', async (ctx) => {
    if (!await authorize(ctx)) return;
    if (ctx.chat.type !== 'supergroup') { await ctx.reply('Для тегов участников нужна супергруппа. Преобразуй группу в супергруппу и повтори настройку.'); return; }
    if (!await store.group(ctx.chat.id) && ctx.from!.id !== ownerId) { await ctx.reply('Активация новой группы доступна только владельцу бота.'); return; }
    const parsed = playerTagSchema.safeParse(ctx.match);
    if (!parsed.success) { await ctx.reply('Укажи тег клана: /setup #2PP'); return; }
    const owner = crypto.randomUUID();
    if (!await store.lease('sync', owner)) { await ctx.reply('Сейчас идёт синхронизация. Повтори настройку через минуту.'); return; }
    try {
      const rights = await ctx.api.getChatMember(ctx.chat.id, ctx.me.id);
      if (rights.status !== 'administrator' || !rights.can_manage_tags) {
        await ctx.reply('Дай боту права администратора: управлять тегами участников. Затем повтори /setup.');
        return;
      }
      const clan = await clash.clan(parsed.data);
      rosterTags(clan);
      await store.user(ctx.from!.id);
      await store.setup(ctx.chat.id, ('title' in ctx.chat ? ctx.chat.title : '') ?? '', ctx.from!.id, clan);
      await ctx.reply(`Подключён клан «${clan.name}» (${clan.tag}).\nУчастникам нужно один раз открыть приложение бота и привязать игровой аккаунт. После привязки игровой ник появится в теге группы. Автообновление — раз в час, ручная проверка — /sync.`);
    } catch (error) { await ctx.reply(userError(error)); }
    finally { await store.release('sync', owner); }
  });

  bot.command('resetlink', async (ctx) => {
    if (!await authorize(ctx)) return;
    const parsed = /^(\d+)\s+(.{5,300})$/u.exec(ctx.match);
    if (!parsed || !Number.isSafeInteger(Number(parsed[1]))) { await ctx.reply('Формат: /resetlink TELEGRAM_ID причина (от 5 символов)'); return; }
    const subject = Number(parsed[1]);
    const owner = crypto.randomUUID();
    if (!await store.lease('sync',owner)) { await ctx.reply('Идёт синхронизация. Повтори позже.'); return; }
    try {
      const rows = (await store.db.prepare('SELECT chat_id FROM group_memberships WHERE telegram_id=? AND present=1').bind(subject).all<{chat_id:number}>()).results;
      if (rows.length !== 1 || rows[0]?.chat_id !== ctx.chat.id) { await ctx.reply('Сброс допускается только для привязки, относящейся исключительно к этой группе. Для общей привязки нужен владелец бота.'); return; }
      const member = await ctx.api.getChatMember(ctx.chat.id,subject);
      if (!['member','administrator','creator'].includes(member.status) && !(member.status === 'restricted' && member.is_member)) { await ctx.reply('Участник отсутствует в этой группе.'); return; }
      await store.audit(ctx.chat.id,ctx.from!.id,subject,parsed[2]!);
      const incomplete = await unlinkAccount(store,ctx.api,subject);
      await ctx.reply('Привязка сброшена; причина записана.' + (incomplete ? ' Очистка тега не завершена.' : ''));
    } finally { await store.release('sync',owner); }
  });

  bot.command('status', async (ctx) => {
    if (!await authorize(ctx)) return;
    const group = await store.group(ctx.chat.id);
    if (!group) { await ctx.reply('Группа ещё не настроена. Используй /setup #ТЕГ_КЛАНА.'); return; }
    const stats = await store.summary(ctx.chat.id);
    const botMember = await ctx.api.getChatMember(ctx.chat.id, ctx.me.id);
    const rights = botMember.status === 'administrator' && botMember.can_manage_tags;
    await ctx.reply(`Клан: ${group.clan_name} (${group.clan_tag})\nПрава на теги: ${rights ? 'есть' : 'нужно выдать'}\nПроверено привязок: ${stats.total}\nТеги в порядке: ${stats.ok}\nПоследняя проверка: ${stats.checked_at ? new Date(stats.checked_at * 1000).toISOString() : 'ещё не было'}\nАдминистраторов и отсутствующих участников бот пропускает.`);
  });

  bot.command('sync', async (ctx) => {
    if (!await authorize(ctx)) return;
    if (!await store.group(ctx.chat.id)) { await ctx.reply('Сначала подключи клан: /setup #ТЕГ_КЛАНА.'); return; }
    if (await store.limited(`sync:${ctx.chat.id}`, 1, 60)) { await ctx.reply('Проверять можно раз в минуту.'); return; }
    const queued = await jobs.enqueue(ctx.chat.id, ctx.from!.id);
    if (queued === 'busy') { await ctx.reply('Проверка уже идёт. Результат появится в группе после завершения.'); return; }
    await ctx.reply('Запущено обновление всех привязанных участников этой группы с включённой синхронизацией. Если список большой, проверю его частями и сообщу результат.');
    await jobs.runNext();
  });
}
