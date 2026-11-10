import type { Bot, Context } from 'grammy/web';
import type { ClashApi } from '../clients/clash';
import type { Store } from '../db/store';
import type { SyncService } from '../services/sync';
import { playerTagSchema } from '../validation/player';
import { rosterTags } from '../services/roster';
import { userError } from '../errors';

export function adminCommands(bot: Bot, store: Store, clash: ClashApi, sync: SyncService): void {
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
    if (ctx.chat.type !== 'supergroup') { await ctx.reply('Для временных ограничений нужна супергруппа. Включи историю чата для новых участников или преобразуй группу в супергруппу и повтори настройку.'); return; }
    const parsed = playerTagSchema.safeParse(ctx.match);
    if (!parsed.success) { await ctx.reply('Укажи тег клана: /setup #2PP'); return; }
    const owner = crypto.randomUUID();
    if (!await store.lease('sync', owner)) { await ctx.reply('Сейчас идёт синхронизация. Повтори настройку через минуту.'); return; }
    try {
      const rights = await ctx.api.getChatMember(ctx.chat.id, ctx.me.id);
      if (rights.status !== 'administrator' || !rights.can_manage_tags || !rights.can_restrict_members) {
        await ctx.reply('Дай боту права администратора: управлять тегами и ограничивать участников. Затем повтори /setup.');
        return;
      }
      const clan = await clash.clan(parsed.data);
      rosterTags(clan);
      await store.user(ctx.from!.id);
      await store.setup(ctx.chat.id, ('title' in ctx.chat ? ctx.chat.title : '') ?? '', ctx.from!.id, clan, true);
      await ctx.reply(`Подключён клан «${clan.name}» (${clan.tag}).\nУчастники могут привязать аккаунты в личном чате с ботом. Регистрация — по свободному тегу из состава клана, без игрового токена. Проверка — каждые 30 минут.\nПосле двух подтверждений отсутствия бот ограничивает отправку сообщений максимум на 24 часа и ждёт решения администратора. Никого не удаляет. Очередь: /reviews.`);
    } catch (error) { await ctx.reply(userError(error)); }
    finally { await store.release('sync', owner); }
  });

  bot.command('status', async (ctx) => {
    if (!await authorize(ctx)) return;
    const group = await store.group(ctx.chat.id);
    if (!group) { await ctx.reply('Группа ещё не настроена. Используй /setup #ТЕГ_КЛАНА.'); return; }
    const stats = await store.summary(ctx.chat.id);
    const pending = await store.pending(ctx.chat.id);
    const botMember = await ctx.api.getChatMember(ctx.chat.id, ctx.me.id);
    const rights = botMember.status === 'administrator' && botMember.can_manage_tags;
    await ctx.reply(`Клан: ${group.clan_name} (${group.clan_tag})\nПрава на теги: ${rights ? 'есть' : 'нужно выдать'}\nМодерация: ${group.moderation_enabled ? 'включена' : 'выключена — повтори /setup'}\nПрава на ограничения: ${botMember.status === 'administrator' && botMember.can_restrict_members ? 'есть' : 'нужно выдать'}\nОжидают решения (первые 10): ${pending.length} — /reviews\nПроверено привязок: ${stats.total}\nТеги в порядке: ${stats.ok}\nПоследняя проверка: ${stats.checked_at ? new Date(stats.checked_at * 1000).toISOString() : 'ещё не было'}\nАдминистраторов и отсутствующих участников бот пропускает.`);
  });

  bot.command('sync', async (ctx) => {
    if (!await authorize(ctx)) return;
    if (!await store.group(ctx.chat.id)) { await ctx.reply('Сначала подключи клан: /setup #ТЕГ_КЛАНА.'); return; }
    if (await store.limited(`sync:${ctx.chat.id}`, 1, 60)) { await ctx.reply('Проверять можно раз в минуту.'); return; }
    const result = await sync.run({ chat: ctx.chat.id });
    if (result.busy) { await ctx.reply('Проверка уже идёт. Попробуй через минуту.'); return; }
    await ctx.reply(`Проверено игроков: ${result.checked}. Обновлено тегов: ${result.updated}. Пропущено: ${result.skipped}. Ошибок: ${result.failed}.${result.partial ? '\nЭто часть списка. Повтори /sync через минуту для следующей партии. Cron тоже продолжит проверку.' : ''}`);
  });
}
