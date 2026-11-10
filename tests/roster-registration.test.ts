import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testStore } from './database';
import { player } from './fixtures';
import { LinkingService } from '../src/services/linking';
import { ServiceError } from '../src/errors';

describe('registration from configured clan roster', () => {
  let db: ReturnType<typeof testStore>;
  const clan = { ...player.clan!, members: 1, memberList: [{ tag: player.tag }] };
  const api = { player: vi.fn(async () => player), clan: vi.fn(async () => clan), verify: vi.fn() };
  beforeEach(async () => {
    db = testStore(); vi.clearAllMocks(); api.player.mockResolvedValue(player); api.clan.mockResolvedValue(clan);
    await db.store.user(10); await db.store.setup(-100, 'Group', 10, clan, true);
  });
  afterEach(() => db.sqlite.close());
  it('registers a free roster tag without verifying or requesting a player token', async () => {
    const result = await new LinkingService(db.store, api).registerFromClan(10, player.tag);
    expect(result.status).toBe('linked');
    expect(await db.store.link(10)).toMatchObject({ player_tag: player.tag, registration_kind: 'clan_roster', verified_at: 0 });
    expect(api.verify).not.toHaveBeenCalled();
  });
  it('requires a clan connected by a group administrator', async () => {
    db.sqlite.exec('DELETE FROM clan_configs');
    expect((await new LinkingService(db.store, api).registerFromClan(10, player.tag)).status).toBe('not_configured');
    expect(api.player).not.toHaveBeenCalled();
  });
  it('rejects a player whose current clan is not configured', async () => {
    api.player.mockResolvedValue({ ...player, clan: { tag: '#Q2Y', name: 'Other' } });
    expect((await new LinkingService(db.store, api).registerFromClan(10, player.tag)).status).toBe('not_in_clan');
    expect(await db.store.link(10)).toBeNull();
  });
  it('checks the roster even when the player profile names the correct clan', async () => {
    api.clan.mockResolvedValue({ ...clan, memberList: [{ tag: '#Q2Y' }] });
    expect((await new LinkingService(db.store, api).registerFromClan(10, player.tag)).status).toBe('not_in_clan');
  });
  it('does not register from an incomplete roster or API error', async () => {
    api.clan.mockResolvedValue({ ...clan, members: 2 });
    await expect(new LinkingService(db.store, api).registerFromClan(10, player.tag)).rejects.toMatchObject({ code: 'invalid_roster' });
    api.clan.mockRejectedValueOnce(new ServiceError('upstream_unavailable'));
    await expect(new LinkingService(db.store, api).registerFromClan(10, player.tag)).rejects.toThrow();
    expect(await db.store.link(10)).toBeNull();
  });
  it('does not steal a claimed tag or replace an existing registration', async () => {
    const service = new LinkingService(db.store, api);
    await service.registerFromClan(10, player.tag);
    expect((await service.registerFromClan(11, player.tag)).status).toBe('taken');
    expect((await service.registerFromClan(10, '#Q2Y')).status).toBe('already_linked');
    expect((await db.store.link(10))?.player_tag).toBe(player.tag);
  });
});
