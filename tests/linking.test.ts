import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testStore } from './database';
import { player } from './fixtures';
import { LinkingService } from '../src/services/linking';

describe('account ownership', () => {
  let db: ReturnType<typeof testStore>;
  const clash = { player: vi.fn(async () => player), clan: vi.fn(), verify: vi.fn(async () => true) };
  let service: LinkingService;
  beforeEach(() => { db = testStore(); vi.clearAllMocks(); clash.verify.mockResolvedValue(true); service = new LinkingService(db.store, clash); });
  afterEach(() => db.sqlite.close());
  async function ready(id = 10) { await service.begin(id); await service.select(id, player.tag); }

  it('saves only a verified link and clears the conversation', async () => {
    await ready();
    expect(await service.verify(10, 'ABC12345')).toBe('linked');
    expect((await db.store.link(10))?.player_tag).toBe(player.tag);
    expect(await db.store.conversation(10)).toBeNull();
    expect(JSON.stringify(db.sqlite.prepare('SELECT * FROM players').all())).not.toContain('ABC12345');
    const tables = db.sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='table'").all();
    expect(JSON.stringify(tables)).not.toMatch(/api_token/i);
  });
  it('rejects an invalid token without linking the account', async () => {
    clash.verify.mockResolvedValue(false);
    await ready();
    expect(await service.verify(10, 'BAD12345')).toBe('invalid');
    expect(await db.store.link(10)).toBeNull();
  });
  it('does not call the API for malformed or expired tokens', async () => {
    await ready();
    expect(await service.verify(10, '!')).toBe('invalid');
    db.sqlite.exec('UPDATE conversations SET expires_at=0');
    expect(await service.verify(10, 'ABC12345')).toBe('expired');
    expect(clash.verify).not.toHaveBeenCalled();
  });
  it('limits verification attempts even if the conversation is restarted', async () => {
    clash.verify.mockResolvedValue(false);
    for (let i = 0; i < 5; i++) { await ready(); expect(await service.verify(10, 'BAD12345')).toBe('invalid'); }
    await ready();
    expect(await service.verify(10, 'BAD12345')).toBe('limited');
    expect(clash.verify).toHaveBeenCalledTimes(5);
  });
  it('cannot take an account already owned by another user', async () => {
    await ready();
    await service.begin(11);
    await service.select(11, player.tag);
    expect(await service.verify(10, 'ABC12345')).toBe('linked');
    expect(await service.verify(11, 'ABC12345')).toBe('taken');
    expect(await db.store.link(11)).toBeNull();
    expect(await service.select(11, player.tag)).toBeNull();
  });
  it('rolls back player changes if the unique account link fails', async () => {
    await ready(); await service.verify(10, 'ABC12345');
    await db.store.user(11);
    await expect(db.store.bind(11, { ...player, name: 'Overwritten' })).rejects.toThrow();
    expect(db.sqlite.prepare('SELECT name FROM players').get()?.name).toBe('Archer');
    expect(await service.begin(10)).toBe(false);
  });
});
