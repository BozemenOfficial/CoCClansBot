import type { ClashApi, Player } from '../clients/clash';
import type { Store } from '../db/store';
import { rosterTags } from './roster';

export type LinkResult = 'linked' | 'invalid' | 'taken' | 'already_linked' | 'expired' | 'limited';

export class LinkingService {
  constructor(private readonly store: Store, private readonly clash: ClashApi) {}

  async begin(id: number): Promise<boolean> {
    await this.store.user(id);
    if (await this.store.link(id)) return false;
    await this.store.setConversation(id, 'tag');
    return true;
  }
  async registerFromClan(id: number, tag: string): Promise<{ status: 'linked' | 'taken' | 'already_linked' | 'not_in_clan' | 'not_configured'; player?: Player }> {
    if (await this.store.link(id)) return { status: 'already_linked' };
    if (await this.store.tagOwner(tag)) return { status: 'taken' };
    const groups = await this.store.groups();
    if (!groups.length) return { status: 'not_configured' };
    const player = await this.clash.player(tag);
    if (!player.clan || !groups.some((g) => g.clan_tag === player.clan?.tag)) return { status: 'not_in_clan' };
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
  async select(id: number, tag: string): Promise<Player | null> {
    if (await this.store.tagOwner(tag)) return null;
    const player = await this.clash.player(tag);
    await this.store.setConversation(id, 'token', player.tag);
    return player;
  }
  async verify(id: number, token: string): Promise<LinkResult> {
    const conversation = await this.store.conversation(id);
    if (await this.store.link(id)) return 'already_linked';
    if (conversation?.step !== 'token' || !conversation.player_tag) return 'expired';
    if (conversation.attempts >= 5 || await this.store.limited(`verify:${id}`, 5, 600)) return 'limited';
    await this.store.failedToken(id);
    if (!/^[a-z0-9]{6,128}$/i.test(token) || !await this.clash.verify(conversation.player_tag, token)) return 'invalid';
    const player = await this.clash.player(conversation.player_tag);
    try { await this.store.bind(id, player); }
    catch (error) {
      // The UNIQUE constraint is the final guard if two users verify concurrently.
      if (await this.store.link(id)) return 'already_linked';
      if (await this.store.tagOwner(player.tag)) return 'taken';
      throw error;
    }
    return 'linked';
  }
}
