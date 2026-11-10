import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { testStore } from './database';
import { player } from './fixtures';
import { RequestBudget } from '../src/clients/http';
import { SyncService } from '../src/services/sync';
import { SyncJobs } from '../src/services/sync-jobs';

let db: ReturnType<typeof testStore>;
const telegram = { getChatMember: vi.fn(async (_chat: number, id: number) => id === 999 ? { status: 'administrator', can_manage_tags: true } : { status: 'member' }), setChatMemberTag: vi.fn(async () => true), sendMessage: vi.fn(async () => true) };
const clash = { player: vi.fn(async (tag: string) => ({ ...player, tag })), clan: vi.fn(), verify: vi.fn() };
const jobs = () => new SyncJobs(db.store, new SyncService(db.store, clash, telegram, 999, new RequestBudget(), 3), telegram);
beforeEach(async () => {
  db = testStore(); vi.clearAllMocks();
  await db.store.user(1); await db.store.setup(-100, 'Group', 1, player.clan!);
  const tags = ['#P00', '#P02', '#P08', '#P09', '#P0Y', '#P0L', '#P0Q', '#P0R'];
  for (const [index, tag] of tags.entries()) {
    await db.store.user(10 + index); await db.store.bind(10 + index, { ...player, tag }); await db.store.membership(-100,10+index,true);
  }
});
afterEach(() => db.sqlite.close());
it('covers every enabled account over multiple bounded batches and notifies once', async () => {
  await db.store.syncEnabled(17, false);
  expect(await jobs().enqueue(-100, 1)).toBe('queued');
  expect(await jobs().enqueue(-100, 1)).toBe('busy');
  for (let i = 0; i < 3; i++) await jobs().runNext();
  expect(await db.store.syncJob(-100)).toMatchObject({ state: 'done', checked: 7, updated: 7, notified: 1 });
  expect(new Set(telegram.setChatMemberTag.mock.calls.map((call) => (call as unknown[])[1])).size).toBe(7);
  expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
  expect(await jobs().runNext()).toBe(false);
});
it('leaves a busy batch pending and resumes after the sync lock is released', async () => {
  await jobs().enqueue(-100, 1);
  await db.store.lease('sync', 'cron');
  await jobs().runNext();
  expect(clash.player).not.toHaveBeenCalled();
  expect(await db.store.syncJob(-100)).toMatchObject({ state: 'pending', checked: 0 });
  await db.store.release('sync', 'cron');
  await jobs().runNext();
  expect(await db.store.syncJob(-100)).toMatchObject({ state: 'pending', checked: 3 });
});
it('retries a failed completion notification without rerunning nickname updates', async () => {
  await jobs().enqueue(-100, 1);
  telegram.sendMessage.mockRejectedValueOnce(new Error('unavailable'));
  for (let i = 0; i < 3; i++) await jobs().runNext();
  expect(await db.store.syncJob(-100)).toMatchObject({ state: 'done', notified: 0 });
  const writes = telegram.setChatMemberTag.mock.calls.length;
  db.sqlite.exec('UPDATE sync_jobs SET available_at=0');
  expect(await jobs().runNext()).toBe(false);
  expect(telegram.setChatMemberTag).toHaveBeenCalledTimes(writes);
  expect(await db.store.syncJob(-100)).toMatchObject({ notified: 1 });
});

it('defers a rate limited batch using Telegram retry_after',async()=>{
 await jobs().enqueue(-100,1);
 telegram.setChatMemberTag.mockRejectedValueOnce({parameters:{retry_after:900}});
 await jobs().runNext();
 const row=db.sqlite.prepare('SELECT available_at-unixepoch() AS delay FROM sync_jobs').get();
 expect(row?.delay).toBe(900);
 expect(await db.store.nextSyncJob()).toBeNull();
});
