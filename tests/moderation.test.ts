import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testStore } from './database';
import { player } from './fixtures';
import type { Clan, Player } from '../src/clients/clash';
import type { Member } from '../src/services/sync';
import { ModerationService } from '../src/services/moderation';
import { RequestBudget } from '../src/clients/http';
import { ServiceError } from '../src/errors';

const clan: Clan = { ...player.clan!, members: 3, memberList: [{ tag: '#Q2Y' }, { tag: '#Q8Y' }, { tag: '#Q9Y' }] };
const defaults = { can_send_messages: true, can_send_audios: true, can_send_photos: true, can_send_videos: true,
  can_send_documents: true, can_send_video_notes: true, can_send_voice_notes: true, can_send_polls: true,
  can_send_other_messages: true, can_add_web_page_previews: true, can_react_to_messages: true,
  can_invite_users: true, can_change_info: false, can_pin_messages: false, can_edit_tag: false, can_manage_topics: false };
const outside: Player = { ...player, clan: { tag: '#Q2Y', name: 'Other' } };
const rights: Member = { status: 'administrator', can_restrict_members: true };

describe('temporary restrictions and administrator review', () => {
  let db: ReturnType<typeof testStore>;
  let service: ModerationService;
  let member: Member;
  const clash = { player: vi.fn(async () => outside), clan: vi.fn<() => Promise<Clan>>(async () => clan), verify: vi.fn() };
  const api = {
    getChatMember: vi.fn(async (_chat: number, user: number): Promise<Member> => user === 999 ? rights : member),
    getChat: vi.fn(async () => ({ id: -100, permissions: defaults })),
    restrictChatMember: vi.fn(async () => true), sendMessage: vi.fn(async () => true),
  };
  beforeEach(async () => {
    db = testStore(); vi.clearAllMocks(); clash.clan.mockResolvedValue(clan);
    api.restrictChatMember.mockResolvedValue(true);
    member = { status: 'member', user: { is_bot: false } };
    await db.store.user(10); await db.store.bind(10, player); await db.store.setup(-100, 'Group', 10, clan, true);
    service = new ModerationService(db.store, clash, api, new RequestBudget());
  });
  afterEach(() => db.sqlite.close());
  async function check(user = 10, p: Player = outside, m = member, bot = rights) {
    return service.check((await db.store.group(-100))!, { telegram_id: user, player_tag: p.tag }, p, m, bot);
  }
  async function observed() {
    await check();
    db.sqlite.exec('UPDATE moderation_cases SET first_absent_at=unixepoch()-901');
    service.beginPass();
  }
  async function muted() {
    await observed(); await check();
    const item = (await db.store.caseFor(-100, 10))!;
    member = Object.assign({ status: 'restricted', until_date: item.muted_until }, JSON.parse(item.permissions!));
    return item;
  }
  it('requires two valid checks separated by at least 15 minutes', async () => {
    expect(await check()).toBe('observing_absence');
    service.beginPass();
    expect(await check()).toBe('observing_absence');
    expect(api.restrictChatMember).not.toHaveBeenCalled();
    db.sqlite.exec('UPDATE moderation_cases SET first_absent_at=unixepoch()-901'); service.beginPass();
    expect(await check()).toBe('awaiting_admin');
    const item = (await db.store.caseFor(-100, 10))!;
    expect(item.muted_until - Math.floor(Date.now() / 1000)).toBeGreaterThan(86390);
    expect(item.muted_until - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(86400);
    expect(api.restrictChatMember).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(item.state).toBe('pending');
    expect(JSON.parse(item.permissions!).can_invite_users).toBe(true);
  });
  it('never mutes when either source says the player belongs to the clan', async () => {
    await observed();
    expect(await check(10, player)).toBeNull();
    expect(await db.store.caseFor(-100, 10)).toBeNull();
    expect(await check(10, { ...outside, tag: '#Q2Y' })).toBeNull();
    expect(api.restrictChatMember).not.toHaveBeenCalled();
  });
  it.each(['api', 'incomplete', 'empty', 'drop'])('does not restrict on unhealthy roster: %s', async (kind) => {
    await observed();
    if (kind === 'api') clash.clan.mockRejectedValue(new ServiceError('upstream_unavailable'));
    if (kind === 'incomplete') clash.clan.mockResolvedValue({ ...clan, members: 4 });
    if (kind === 'empty') clash.clan.mockResolvedValue({ ...clan, members: 0, memberList: [] });
    if (kind === 'drop') clash.clan.mockResolvedValue({ ...clan, members: 1, memberList: [{ tag: '#Q9Y' }] });
    await check(); expect(api.restrictChatMember).not.toHaveBeenCalled();
  });
  it.each(['administrator', 'creator', 'restricted', 'left', 'kicked'])('does not modify existing %s status', async (status) => {
    await observed(); await check(10, outside, { status });
    expect(api.restrictChatMember).not.toHaveBeenCalled();
  });
  it('does not restrict bot accounts or act without the restriction permission', async () => {
    await observed();
    await check(10, outside, { status: 'member', user: { is_bot: true } });
    await check(10, outside, member, { status: 'administrator', can_restrict_members: false });
    expect(api.restrictChatMember).not.toHaveBeenCalled();
  });
  it('restricts at most one new member per group in a pass', async () => {
    await db.store.user(11); await db.store.bind(11, { ...player, tag: '#P2Y' });
    await check(); await check(11, { ...outside, tag: '#P2Y' });
    db.sqlite.exec('UPDATE moderation_cases SET first_absent_at=unixepoch()-901'); service.beginPass();
    await check(); expect(await check(11, { ...outside, tag: '#P2Y' })).toBe('moderation_deferred');
    expect(api.restrictChatMember).toHaveBeenCalledTimes(1);
  });
  it('does not reapply restrictions or repeat notifications for a pending case, including expiry', async () => {
    await muted(); service.beginPass(); await check();
    member = { status: 'member' };
    db.sqlite.exec('UPDATE moderation_cases SET muted_until=unixepoch()-1');
    service.beginPass(); await check();
    expect(api.restrictChatMember).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });
  it('lets an administrator release only this bot restriction and approve an exception', async () => {
    const item = await muted();
    expect(await service.decide(item.id, -100, 20, 999, 'allow')).toContain('Разрешено');
    expect((await db.store.review(item.id))?.state).toBe('allowed');
    member = { status: 'member' }; service.beginPass(); await check();
    expect(api.restrictChatMember).toHaveBeenCalledTimes(2);
    expect((api.restrictChatMember.mock.calls[1] as unknown as [number,number,Record<string,boolean>])[2].can_send_messages).toBe(true);
  });
  it('preserves permissions subsequently changed by another administrator', async () => {
    const item = await muted();
    member = Object.assign({}, member, { can_invite_users: false });
    expect(await service.decide(item.id, -100, 20, 999, 'allow')).toContain('Снимите его вручную');
    expect(api.restrictChatMember).toHaveBeenCalledTimes(1);
  });
  it('does not permit a callback to operate in another group', async () => {
    const item = await muted();
    await service.decide(item.id, -200, 20, 999, 'allow');
    expect(api.restrictChatMember).toHaveBeenCalledTimes(1);
  });
  it('allows an administrator to extend a known restriction without putting it back in the undecided queue', async () => {
    const item = await muted();
    expect(await service.decide(item.id, -100, 20, 999, 'keep')).toContain('по решению администратора');
    expect((await db.store.review(item.id))?.state).toBe('held');
    expect(await db.store.pending(-100)).toEqual([]);
    service.beginPass(); await check();
    expect(api.restrictChatMember).toHaveBeenCalledTimes(2);
  });
  it('records uncertainty after a Telegram timeout instead of applying repeatedly', async () => {
    await observed(); api.restrictChatMember.mockRejectedValueOnce(new Error('network timeout'));
    await check(); service.beginPass(); await check();
    expect((await db.store.caseFor(-100, 10))?.applied).toBe(0);
    expect(api.restrictChatMember).toHaveBeenCalledTimes(1);
  });
  it('does not apply restrictions to an existing group until its administrator enables the policy', async () => {
    db.sqlite.exec('UPDATE clan_configs SET moderation_enabled=0');
    expect(await check()).toBeNull();
    expect(clash.clan).not.toHaveBeenCalled();
  });
});
