import type { ClashApi } from '../clients/clash';
import type { RequestBudget } from '../clients/http';
import { Store, type Group, type Link } from '../db/store';
import { ServiceError } from '../errors';
import { memberTag } from '../validation/player';

export interface Member {
  status: string;
  is_member?: boolean;
  can_manage_tags?: boolean;
  can_restrict_members?: boolean;
  until_date?: number;
  can_send_messages?: boolean;
  user?: { is_bot?: boolean };
  tag?: string;
}
export interface TelegramApi {
  getChatMember(chat: number, user: number): Promise<Member>;
  setChatMemberTag(chat: number, user: number, tag: string): Promise<unknown>;
}
export interface SyncResult { checked: number; updated: number; skipped: number; failed: number; busy: boolean; partial: boolean; retryAfter?: number }

export class SyncService {
  constructor(
    private readonly store: Store,
    private readonly clash: ClashApi,
    private readonly telegram: TelegramApi,
    private readonly botId: number,
    private readonly budget: RequestBudget,
    private readonly batchSize: number,
  ) {}

  async run(options: { user?: number; chat?: number } = {}): Promise<SyncResult> {
    const result: SyncResult = { checked: 0, updated: 0, skipped: 0, failed: 0, busy: false, partial: false };
    const owner = crypto.randomUUID();
    if (!await this.store.lease('sync', owner)) return { ...result, busy: true };
    try {
      const groups = options.chat === undefined ? await this.store.groups() : [await this.store.group(options.chat)].filter((g): g is Group => g !== null);
      if (!groups.length) return result;
      const links = options.user !== undefined
        ? await this.store.due(this.batchSize + 1, options.user)
        : options.chat !== undefined
        ? await this.store.manualBatch(options.chat, this.batchSize + 1)
        : await this.store.due(this.batchSize + 1, options.user);
      const permissions = new Map<number, Member>();
      for (const link of links.slice(0, this.batchSize)) {
        if (this.budget.available < 5) { result.partial = true; break; }
        const complete = await this.syncPlayer(link, groups, permissions, options, result);
        if (options.chat !== undefined && options.user === undefined && complete) await this.store.manualCursor(options.chat, link.player_tag);
        if (!complete) { result.partial = true; break; }
      }
      if (links.length > this.batchSize) result.partial = true;
      return result;
    } finally {
      await this.store.release('sync', owner);
    }
  }

  private async syncPlayer(link: Link, groups: Group[], permissions: Map<number, Member>,
    options: { user?: number; chat?: number }, result: SyncResult): Promise<boolean> {
    try {
      const player = await this.clash.player(link.player_tag);
      await this.store.refreshed(player);
      result.checked++;
      const start = options.chat !== undefined || options.user !== undefined ? 0 : link.next_group ?? 0;
      for (let i = start; i < groups.length; i++) {
        if (this.budget.available < 4) {
          if (options.chat === undefined) await this.store.groupCursor(player.tag, i);
          return false;
        }
        const group = groups[i]!;
        try {
          if (player.clan?.tag !== group.clan_tag) {
            await this.store.saveState(group.chat_id, link.telegram_id, null, 'not_in_clan');
            result.skipped++;
            continue;
          }
          if (!permissions.has(group.chat_id)) {
            const bot = await this.telegram.getChatMember(group.chat_id, this.botId);
            permissions.set(group.chat_id, bot);
          }
          const rights = permissions.get(group.chat_id)!;
          if (rights.status !== 'administrator') {
            await this.store.saveState(group.chat_id, link.telegram_id, null, 'missing_rights');
            result.skipped++;
            continue;
          }
          const member = await this.telegram.getChatMember(group.chat_id, link.telegram_id);
          await this.store.membership(group.chat_id,link.telegram_id, ['member','administrator','creator'].includes(member.status) || (member.status === 'restricted' && !!member.is_member));
          if (member.status === 'administrator' || member.status === 'creator') {
            await this.store.saveState(group.chat_id, link.telegram_id, null, 'administrator');
            result.skipped++;
            continue;
          }
          if (member.status !== 'member' && !(member.status === 'restricted' && member.is_member)) {
            await this.store.saveState(group.chat_id, link.telegram_id, null, 'not_member');
            result.skipped++;
            continue;
          }
          if (!rights.can_manage_tags) {
            await this.store.saveState(group.chat_id, link.telegram_id, null, 'missing_rights');
            result.skipped++;
            continue;
          }
          const tag = memberTag(player.name);
          // The live tag lets us repair manual edits and re-joins as well as nickname changes.
          if (member.tag !== tag) {
            await this.telegram.setChatMemberTag(group.chat_id, link.telegram_id, tag);
            result.updated++;
          }
          await this.store.saveState(group.chat_id, link.telegram_id, tag, 'ok');
        } catch (error) {
          if (error instanceof ServiceError && error.code === 'budget_exhausted') {
            if (options.chat === undefined) await this.store.groupCursor(player.tag, i);
            return false;
          }
          const retry = telegramRetryAfter(error);
          await this.store.saveState(group.chat_id, link.telegram_id, null, retry ? 'rate_limited' : 'telegram_error');
          result.failed++;
          if (retry) {
            result.retryAfter = Math.max(result.retryAfter ?? 0,retry);
            if (options.chat === undefined) {
              await this.store.groupCursor(player.tag, i);
              await this.store.postpone(player.tag, retry);
            }
            return false;
          }
        }
      }
      await this.store.recordSync(link.telegram_id);
      if (options.chat === undefined) {
        await this.store.groupCursor(player.tag, 0);
        await this.store.postpone(player.tag, 3600);
      }
      return true;
    } catch (error) {
      if (error instanceof ServiceError && error.code === 'budget_exhausted') return false;
      result.failed++;
      if (options.chat === undefined) await this.store.postpone(link.player_tag,
        error instanceof ServiceError && error.retryAfter ? error.retryAfter : 1800);
      return true;
    }
  }
}

function telegramRetryAfter(error: unknown): number {
  if (typeof error !== 'object' || error === null || !('parameters' in error)) return 0;
  const p = error.parameters;
  if (typeof p !== 'object' || p === null || !('retry_after' in p)) return 0;
  return typeof p.retry_after === 'number' ? Math.max(60, Math.min(p.retry_after, 3600)) : 0;
}
