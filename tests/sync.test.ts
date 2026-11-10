import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncService, type Member } from '../src/services/sync';
import { RequestBudget } from '../src/clients/http';
import { ServiceError } from '../src/errors';
import { testStore } from './database';
import { player } from './fixtures';

describe('tag synchronization', () => {
  let db: ReturnType<typeof testStore>;
  const clash = { player: vi.fn(async () => player), clan: vi.fn(), verify: vi.fn() };
  let member: Member;
  let canManage: boolean;
  const telegram = {
    getChatMember: vi.fn(async (_chat: number, user: number): Promise<Member> => user === 999
      ? { status: 'administrator', can_manage_tags: canManage } : member),
    setChatMemberTag: vi.fn(async () => true),
  };
  const make = (budget = new RequestBudget(), size = 8) => new SyncService(db.store, clash, telegram, 999, budget, size);
  beforeEach(async () => {
    db = testStore(); vi.clearAllMocks();
    clash.player.mockResolvedValue(player);
    member = { status: 'member' }; canManage = true;
    await db.store.user(10);
    await db.store.bind(10, player);
    await db.store.setup(-100, 'Group', 10, player.clan!);
  });
  afterEach(() => db.sqlite.close());

  it('sets the game name, then avoids unchanged tag updates', async () => {
    expect((await make().run({ user: 10 })).updated).toBe(1);
    expect(telegram.setChatMemberTag).toHaveBeenCalledWith(-100, 10, 'Archer');
    member.tag = 'Archer';
    expect((await make().run({ user: 10 })).updated).toBe(0);
    expect(telegram.setChatMemberTag).toHaveBeenCalledTimes(1);
  });
  it('repairs a removed tag even when the saved state says it was set', async () => {
    await make().run({ user: 10 });
    expect((await make().run({ user: 10 })).updated).toBe(1);
  });
  it.each(['creator', 'administrator', 'left', 'kicked'])('skips %s accounts', async (status) => {
    member = { status };
    expect((await make().run()).skipped).toBe(1);
    expect(telegram.setChatMemberTag).not.toHaveBeenCalled();
  });
  it('does not edit tags without the bot permission', async () => {
    canManage = false;
    await make().run();
    expect((await db.store.state(-100, 10))?.outcome).toBe('missing_rights');
    expect(telegram.setChatMemberTag).not.toHaveBeenCalled();
  });
  it('skips former clan members without restricting or removing them', async () => {
    const { clan: _clan, ...withoutClan } = player;
    void _clan;
    clash.player.mockResolvedValue(withoutClan);
    expect((await make().run()).updated).toBe(0);
    expect((await db.store.state(-100, 10))?.outcome).toBe('not_in_clan');
  });
  it('keeps each group configuration and state separate', async () => {
    await db.store.setup(-200, 'Other group', 10, { tag: '#Q2Y', name: 'Other' });
    await make().run({ chat: -200 });
    expect(await db.store.state(-100, 10)).toBeNull();
    expect((await db.store.state(-200, 10))?.outcome).toBe('not_in_clan');
    expect((await db.store.group(-100))?.clan_tag).toBe('#Q0Y');
  });
  it('does not overlap a cron and a manual sync', async () => {
    await db.store.lease('sync', 'other');
    expect((await make().run()).busy).toBe(true);
    expect(clash.player).not.toHaveBeenCalled();
  });
  it('releases the lock when the API is down and postpones retries', async () => {
    clash.player.mockRejectedValueOnce(new ServiceError('rate_limited', 120));
    expect((await make().run()).failed).toBe(1);
    expect(await db.store.due(8)).toEqual([]);
    expect(await db.store.lease('sync', 'next')).toBe(true);
  });
  it('leaves work pending when the invocation budget runs out', async () => {
    const budget = new RequestBudget(4);
    expect((await make(budget).run()).partial).toBe(true);
    expect((await db.store.due(8)).length).toBe(1);
    expect(clash.player).not.toHaveBeenCalled();
  });
  it('paginates scheduled players without starving the rest', async () => {
    await db.store.user(11);
    await db.store.bind(11, { ...player, tag: '#P2Y' });
    clash.player.mockImplementation(async (tag?: string) => ({ ...player, tag: tag ?? player.tag }));
    await make(new RequestBudget(), 1).run();
    expect((await db.store.due(8)).map((p) => p.player_tag)).toEqual(['#P2Y']);
    await make(new RequestBudget(), 1).run();
    expect(await db.store.due(8)).toEqual([]);
  });
});

it('continues a partially checked player from the next group', async () => {
  const { store, sqlite } = testStore();
  try {
    await store.user(10);
    await store.bind(10, player);
    for (const chat of [-300, -200, -100]) await store.setup(chat, 'Group', 10, player.clan!);
    const calls: number[] = [];
    async function run() {
      const budget = new RequestBudget(8);
      return new SyncService(store, {
        player: async () => { budget.take(); return player; }, clan: vi.fn(), verify: vi.fn(),
      }, {
        getChatMember: async (_chat, user) => { budget.take(); return user === 999 ? { status: 'administrator', can_manage_tags: true } : { status: 'member' }; },
        setChatMemberTag: async (chat) => { budget.take(); calls.push(chat); return true; },
      }, 999, budget, 8).run();
    }
    expect((await run()).partial).toBe(true);
    expect(calls).toEqual([-300, -200]);
    expect((await store.due(8))[0]?.next_group).toBe(2);
    expect((await run()).partial).toBe(false);
    expect(calls).toEqual([-300, -200, -100]);
    expect(await store.due(8)).toEqual([]);
  } finally { sqlite.close(); }
});

it('does not schedule a successfully synchronized account again before one hour', async () => {
  const { store, sqlite } = testStore();
  try {
    await store.user(10); await store.bind(10, player); await store.setup(-100, 'Group', 10, player.clan!);
    const sync = new SyncService(store, { player: async () => player, clan: vi.fn(), verify: vi.fn() }, {
      getChatMember: async (_chat, id) => id === 999 ? { status: 'administrator', can_manage_tags: true } : { status: 'member', tag: 'Archer' },
      setChatMemberTag: vi.fn(),
    }, 999, new RequestBudget(), 8);
    await sync.run();
    const row = sqlite.prepare('SELECT next_sync_at-unixepoch() AS delay FROM players').get();
    expect(row?.delay).toBe(3600);
    expect(await store.due(8)).toEqual([]);
  } finally { sqlite.close(); }
});
