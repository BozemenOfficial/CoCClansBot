import type { ClashApi, Player } from '../clients/clash';
import type { Store } from '../db/store';
import { rosterTags } from './roster';

export class LinkingService {
  constructor(private readonly store: Store, private readonly clash: ClashApi,
    private readonly isMember?: (chat: number, user: number) => Promise<boolean>) {}

  async registerFromClan(id: number, tag: string): Promise<{ status: 'linked' | 'taken' | 'already_linked' | 'not_in_clan' | 'not_configured' | 'not_group_member'; player?: Player }> {
    if (await this.store.link(id)) return { status: 'already_linked' };
    if (await this.store.tagOwner(tag)) return { status: 'taken' };
    const groups = await this.store.groups();
    if (!groups.length) return { status: 'not_configured' };
    const player = await this.clash.player(tag);
    if (!player.clan || !groups.some((g) => g.clan_tag === player.clan?.tag)) return { status: 'not_in_clan' };
    if (this.isMember) {
      let joined = false;
      for (const group of groups.filter((g) => g.clan_tag === player.clan!.tag)) {
        if (await this.isMember(group.chat_id, id)) { await this.store.membership(group.chat_id,id,true); joined = true; }
      }
      if (!joined) return { status: 'not_group_member' };
    }
    const tags = rosterTags(await this.clash.clan(player.clan.tag));
    if (!tags.has(tag)) return { status: 'not_in_clan' };
    await this.store.user(id);
    try { await this.store.bind(id, player, 'clan_roster'); }
    catch (error) {
      if (await this.store.link(id)) return { status: 'already_linked' };
      if (await this.store.tagOwner(tag)) return { status: 'taken' };
      throw error;
    }
    return { status: 'linked', player };
  }
}
