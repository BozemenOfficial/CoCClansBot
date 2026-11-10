import type { Store } from '../db/store';
import type { TelegramApi } from './sync';

/** Caller holds the shared sync lease. Never remove a tag changed outside this bot. */
export async function unlinkAccount(store: Store, api: TelegramApi, id: number): Promise<boolean> {
  const rows = (await store.db.prepare('SELECT chat_id,applied_tag FROM sync_state WHERE telegram_id=? AND applied_tag IS NOT NULL').bind(id).all<{chat_id:number;applied_tag:string}>()).results;
  let incomplete = false;
  for (const row of rows) {
    try {
      const member = await api.getChatMember(row.chat_id,id);
      if ((member.status === 'member' || member.status === 'restricted') && member.tag === row.applied_tag) {
        await api.setChatMemberTag(row.chat_id,id,'');
      }
    } catch { incomplete = true; }
  }
  await store.unlink(id);
  return incomplete;
}
