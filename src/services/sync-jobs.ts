import type { Store } from '../db/store';
import type { SyncService } from './sync';

/** Durable cursor: one bounded batch per invocation, full group completion across invocations. */
export class SyncJobs {
  constructor(private readonly store: Store, private readonly sync: SyncService,
    private readonly telegram: { sendMessage(chat: number, text: string): Promise<unknown> }) {}
  async enqueue(chat: number, by: number): Promise<'queued' | 'busy'> {
    const owner = crypto.randomUUID();
    if (!await this.store.lease('sync-jobs', owner)) return 'busy';
    let locked = false;
    try {
      const old = await this.store.syncJob(chat);
      if (old?.state === 'pending' || (old && !old.notified)) return 'busy';
      locked = await this.store.lease('sync', owner);
      if (!locked) return 'busy';
      await this.store.queueSync(chat, by);
      return 'queued';
    } finally {
      if (locked) await this.store.release('sync', owner);
      await this.store.release('sync-jobs', owner);
    }
  }
  async runNext(): Promise<boolean> {
    const owner = crypto.randomUUID();
    if (!await this.store.lease('sync-jobs', owner)) return true;
    try {
      let job = await this.store.nextSyncJob();
      if (!job) return false;
      const processed = job.state === 'pending';
      if (processed) {
        const result = await this.sync.run({ chat: job.chat_id });
        if (result.busy) return true;
        await this.store.progressSyncJob(job.chat_id, result);
        job = (await this.store.syncJob(job.chat_id))!;
      }
      if (job.state === 'done' && !job.notified) {
        try {
          await this.telegram.sendMessage(job.chat_id, `Синхронизация группы завершена. Проверено аккаунтов: ${job.checked}. Изменено тегов: ${job.updated}. Пропущено: ${job.skipped}. Ошибок: ${job.failed}.\nАккаунты с выключенной синхронизацией не затрагиваются.`);
          await this.store.notifiedSyncJob(job.chat_id);
        } catch { /* Persist completion and retry only the notification on the next tick. */ }
      }
      return processed;
    } finally { await this.store.release('sync-jobs', owner); }
  }
}
