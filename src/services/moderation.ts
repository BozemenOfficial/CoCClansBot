import { InlineKeyboard } from 'grammy/web';
import type { ChatPermissions } from 'grammy/types';
import type { Clan, ClashApi, Player } from '../clients/clash';
import type { RequestBudget } from '../clients/http';
import type { Group, Link, ModerationCase, Store } from '../db/store';
import type { Member } from './sync';
import { rosterTags } from './roster';
import { ServiceError } from '../errors';

export interface ModerationApi {
  getChatMember(chat: number, user: number): Promise<Member>;
  getChat(chat: number): Promise<{ id: number; permissions?: ChatPermissions | undefined }>;
  restrictChatMember(chat: number, user: number, permissions: ChatPermissions, options?: { until_date?: number; use_independent_chat_permissions?: boolean }): Promise<unknown>;
  sendMessage(chat: number, text: string, options?: { reply_markup?: InlineKeyboard }): Promise<unknown>;
}
const silence: ChatPermissions = {
  can_send_messages: false, can_send_audios: false, can_send_documents: false, can_send_photos: false,
  can_send_videos: false, can_send_video_notes: false, can_send_voice_notes: false,
  can_send_polls: false, can_send_other_messages: false, can_add_web_page_previews: false,
};
const unrestricted: ChatPermissions = {
  ...Object.fromEntries(Object.keys(silence).map((key) => [key, true])),
  can_react_to_messages: true, can_change_info: true, can_invite_users: true,
  can_edit_tag: true, can_pin_messages: true, can_manage_topics: true,
};
export const reviewButtons = (id: number) => new InlineKeyboard()
  .text('Разрешить писать', `mod:allow:${id}`).text('Ограничить на 24 ч', `mod:keep:${id}`).row()
  .text('Проверить клан', `mod:check:${id}`);

export class ModerationService {
  private readonly muted = new Set<number>();
  private readonly snapshots = new Map<number, { clan: Clan; tags: Set<string>; healthy: boolean }>();
  constructor(private readonly store: Store, private readonly clash: ClashApi,
    private readonly api: ModerationApi, private readonly budget: RequestBudget) {}
  beginPass(): void { this.muted.clear(); this.snapshots.clear(); }

  private ownsRestriction(member: Member, item: ModerationCase): boolean {
    if (member.status !== 'restricted' || member.until_date !== item.muted_until ||
        item.muted_until <= Math.floor(Date.now() / 1000) || !item.permissions) return false;
    try {
      const expected = JSON.parse(item.permissions) as Record<string, boolean>;
      const actual = member as unknown as Record<string, unknown>;
      return Object.entries(expected).every(([key, value]) => actual[key] === value);
    } catch { return false; }
  }
  private async snapshot(group: Group) {
    const cached = this.snapshots.get(group.chat_id);
    if (cached) return cached;
    const clan = await this.clash.clan(group.clan_tag);
    const tags = rosterTags(clan);
    const healthy = tags.size > 0 && (group.roster_count === 0 || tags.size >= group.roster_count * 0.8);
    const value = { clan, tags, healthy };
    this.snapshots.set(group.chat_id, value);
    if (healthy) await this.store.rosterCount(group.chat_id, tags.size);
    return value;
  }
  async check(group: Group, link: Link, player: Player, member: Member, rights: Member): Promise<string | null> {
    if (!group.moderation_enabled || member.user?.is_bot || ['creator', 'administrator'].includes(member.status)) return null;
    let snapshot;
    try { snapshot = await this.snapshot(group); }
    catch (error) {
      if (error instanceof ServiceError && error.code === 'budget_exhausted') throw error;
      return 'clan_api_error';
    }
    if (!snapshot.healthy) {
      if (this.budget.available >= 3 && !await this.store.limited(`roster-health:${group.chat_id}`, 1, 3600)) {
        await this.api.sendMessage(group.chat_id, 'Состав клана пуст или резко уменьшился. Автоматические ограничения приостановлены. Администратор может проверить клан и повторить /setup.');
      }
      return 'roster_review_required';
    }
    let item = await this.store.caseFor(group.chat_id, link.telegram_id);
    if (item?.state === 'held') return 'admin_restricted';
    if (item && (item.state === 'pending' || item.state === 'restricting')) {
      if (this.ownsRestriction(member, item) && !item.applied) {
        await this.store.markCase(item.id, 'pending', item.muted_until, true);
        item = (await this.store.review(item.id))!;
      }
      await this.notify(item);
      return 'awaiting_admin';
    }
    // Both independent sources must say the player is absent. Disagreement never mutes.
    if (snapshot.tags.has(player.tag) || player.clan?.tag === group.clan_tag) {
      await this.store.clearObservation(group.chat_id, link.telegram_id);
      return null;
    }
    if (item && item.clan_tag !== group.clan_tag && (item.state === 'observing' || item.state === 'allowed')) {
      await this.store.resetCase(group.chat_id, link.telegram_id);
      item = null;
    }
    if (item?.state === 'allowed') return 'approved_exception';
    if (member.status !== 'member') return 'existing_restriction';
    item = await this.store.observe(group.chat_id, link.telegram_id, player.tag, group.clan_tag);
    if (Math.floor(Date.now() / 1000) - item.first_absent_at < 900) return 'observing_absence';
    if (!rights.can_restrict_members) return 'missing_moderation_rights';
    if (this.muted.has(group.chat_id) || this.budget.available < 6) return 'moderation_deferred';
    this.muted.add(group.chat_id);
    await this.apply(item);
    await this.notify((await this.store.review(item.id))!);
    return 'awaiting_admin';
  }

  private async apply(item: ModerationCase, by: number | null = null): Promise<void> {
    const chat = await this.api.getChat(item.chat_id);
    if (!chat.permissions) throw new ServiceError('missing_chat_permissions');
    const permissions: ChatPermissions = {
      ...chat.permissions, ...silence,
      can_react_to_messages: chat.permissions.can_react_to_messages ?? chat.permissions.can_send_messages ?? false,
      can_edit_tag: chat.permissions.can_edit_tag ?? chat.permissions.can_pin_messages ?? false,
      can_manage_topics: chat.permissions.can_manage_topics ?? chat.permissions.can_pin_messages ?? false,
    };
    const until = Math.floor(Date.now() / 1000) + 86400;
    await this.store.expectedPermissions(item.id, JSON.stringify(permissions));
    await this.store.markCase(item.id, 'restricting', until, false, by);
    try {
      await this.api.restrictChatMember(item.chat_id, item.telegram_id,
        permissions,
        { until_date: until, use_independent_chat_permissions: true });
      await this.store.markCase(item.id, by === null ? 'pending' : 'held', until, true, by);
    } catch {
      // A timeout can follow a successful Telegram write. Preserve its expected expiry for recovery.
      await this.store.markCase(item.id, 'pending', until, false, by);
    }
  }
  private async notify(item: ModerationCase): Promise<void> {
    if (item.notified || this.budget.available < 3) return;
    await this.api.sendMessage(item.chat_id,
      `Нужна проверка администратора. Игрок ${item.player_tag}, Telegram ID ${item.telegram_id}, отсутствует в клане ${item.clan_tag}.\n` +
      (item.applied ? 'Отправка сообщений ограничена максимум на 24 часа. ' : 'Применение ограничения не подтверждено. Проверьте права и состояние участника. ') +
      'Удаления из группы нет. Решение — за администратором. После истечения срока бот не ограничивает участника повторно автоматически.',
      { reply_markup: reviewButtons(item.id) });
    await this.store.notified(item.id);
  }

  async decide(id: number, chat: number, by: number, botId: number, action: 'allow' | 'keep' | 'check'): Promise<string> {
    const item = await this.store.review(id);
    if (!item || item.chat_id !== chat) return 'Эта проверка не относится к данной группе.';
    if (action === 'check') {
      const group = await this.store.group(chat);
      if (!group) return 'Группа не настроена.';
      try {
        const tags = rosterTags(await this.clash.clan(group.clan_tag));
        return tags.has(item.player_tag) ? 'Игрок сейчас есть в составе клана. Можно разрешить писать.' : 'Игрока сейчас нет в составе клана. Решение остаётся за администратором.';
      } catch { return 'Состав клана сейчас недоступен. Права участника не изменены.'; }
    }
    const rights = await this.api.getChatMember(chat, botId);
    if (rights.status !== 'administrator' || !rights.can_restrict_members) return 'Боту нужно право ограничивать участников.';
    const member = await this.api.getChatMember(chat, item.telegram_id);
    if (action === 'allow') {
      if (member.status === 'restricted' && !this.ownsRestriction(member, item)) return 'Ограничение изменено вне бота или наложено другим администратором. Снимите его вручную; бот его не перезапишет.';
      if (this.ownsRestriction(member, item)) {
        await this.api.restrictChatMember(chat, item.telegram_id, unrestricted, { use_independent_chat_permissions: true });
      }
      await this.store.markCase(id, 'allowed', 0, false, by);
      return 'Разрешено оставаться и писать. Бот не будет снова ограничивать этого участника за отсутствие в клане.';
    }
    if (['administrator','creator','left','kicked'].includes(member.status) || member.user?.is_bot) return 'Для этого участника ограничение не применяется.';
    if (member.status !== 'member' && !this.ownsRestriction(member, item)) return 'Участник уже ограничен вне бота. Его права не изменены.';
    await this.apply(item, by);
    const updated = (await this.store.review(id))!;
    return updated.applied ? 'Отправка сообщений ограничена на 24 часа по решению администратора.' : 'Telegram не подтвердил изменение. Проверьте состояние участника вручную.';
  }
}
