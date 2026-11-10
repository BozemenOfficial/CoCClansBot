import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testStore } from './database';

describe('persistent locks and deduplication', () => {
  let db: ReturnType<typeof testStore>;
  beforeEach(() => { db = testStore(); });
  afterEach(() => db.sqlite.close());
  it('does not process a delivered update twice', async () => {
    expect(await db.store.claim(1, 'a')).toBe('claimed');
    expect(await db.store.claim(1, 'b')).toBe('busy');
    await db.store.finish(1, 'a');
    expect(await db.store.claim(1, 'b')).toBe('done');
  });
  it('retries failed updates and reclaims expired work', async () => {
    await db.store.claim(1, 'a');
    await db.store.abandon(1, 'other');
    expect(await db.store.claim(1, 'b')).toBe('busy');
    db.sqlite.exec('UPDATE webhook_updates SET expires_at=0');
    expect(await db.store.claim(1, 'b')).toBe('claimed');
    await db.store.abandon(1, 'b');
    expect(await db.store.claim(1, 'c')).toBe('claimed');
  });
  it('only releases a lease held by the caller', async () => {
    expect(await db.store.lease('sync', 'a')).toBe(true);
    expect(await db.store.lease('sync', 'b')).toBe(false);
    await db.store.release('sync', 'b');
    expect(await db.store.lease('sync', 'b')).toBe(false);
    db.sqlite.exec('UPDATE leases SET expires_at=0');
    expect(await db.store.lease('sync', 'b')).toBe(true);
    await db.store.release('sync', 'a');
    expect(await db.store.lease('sync', 'c')).toBe(false);
  });
  it('resets a rate limit after its window expires', async () => {
    expect(await db.store.limited('a', 1, 60)).toBe(false);
    expect(await db.store.limited('a', 1, 60)).toBe(true);
    db.sqlite.exec('UPDATE rate_limits SET window_start=0');
    expect(await db.store.limited('a', 1, 60)).toBe(false);
  });
});
