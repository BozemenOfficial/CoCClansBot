import type { ClashApi, Player } from '../clients/clash';
import type { Store } from '../db/store';

export type LinkResult = 'linked' | 'invalid' | 'taken' | 'already_linked' | 'expired' | 'limited';

export class LinkingService {
  constructor(private readonly store: Store, private readonly clash: ClashApi) {}

  async begin(id: number): Promise<boolean> {
    await this.store.user(id);
    if (await this.store.link(id)) return false;
    await this.store.setConversation(id, 'tag');
    return true;
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
