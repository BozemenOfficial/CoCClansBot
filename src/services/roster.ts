import type { Clan } from '../clients/clash';
import { ServiceError } from '../errors';

export function rosterTags(clan: Clan): Set<string> {
  if (!clan.memberList || clan.members === undefined || clan.members !== clan.memberList.length) throw new ServiceError('invalid_roster');
  const tags = new Set(clan.memberList.map((p) => p.tag));
  if (tags.size !== clan.members || [...tags].some((tag) => !/^#[0289PYLQGRJCUV]{3,14}$/.test(tag))) throw new ServiceError('invalid_roster');
  return tags;
}
