import PgBoss from 'pg-boss';
import { COMMENT_PUBLISH_RETRIES, Q, parseJob, type JobPayload, type QueueName } from '@seedingsys/contracts';
import { claimOutbox, markOutboxPublished, tx, type Db } from '@seedingsys/db';
import { captureError, type Logger } from '@seedingsys/observability';

export { PgBoss };

/**
 * Queue settings (pilot). Retry is only safe for steps that cannot have produced a side effect;
 * publish handlers enforce that themselves via the publication state machine.
 */
export const QUEUE_SETTINGS: Record<QueueName, Omit<PgBoss.Queue, 'name'>> = {
  // stately + singletonKey=sourceId → at most one queued and one running poll per source.
  [Q.SourcePoll]: { policy: 'stately', retryLimit: 0, expireInSeconds: 4 * 60 },
  [Q.ProfileSync]: { policy: 'standard', retryLimit: 8, retryDelay: 25, expireInSeconds: 5 * 60 },
  [Q.CommentScan]: { policy: 'standard', retryLimit: 6, retryDelay: 30, expireInSeconds: 4 * 60 },
  // A reply waits for its parent through retries: the handler gives up after COMMENT_PUBLISH_RETRIES.
  [Q.CommentPublish]: { policy: 'standard', retryLimit: COMMENT_PUBLISH_RETRIES, retryDelay: 30, expireInSeconds: 4 * 60 },
  [Q.AssetFetch]: { policy: 'standard', retryLimit: 5, retryDelay: 30, retryBackoff: true, expireInSeconds: 15 * 60 },
  [Q.InstagramBatchImport]: { policy: 'standard', retryLimit: 5, retryDelay: 10, retryBackoff: true, expireInSeconds: 120 },
  [Q.InstagramBatchPublish]: { policy: 'standard', retryLimit: 4, retryDelay: 15, expireInSeconds: 120 },
  [Q.ContentRewrite]: { policy: 'standard', retryLimit: 2, retryDelay: 20, retryBackoff: true, expireInSeconds: 5 * 60 },
  [Q.ContentValidate]: { policy: 'standard', retryLimit: 1, retryDelay: 10, expireInSeconds: 5 * 60 },
  [Q.MediaPrepare]: { policy: 'standard', retryLimit: 2, retryDelay: 60, expireInSeconds: 60 * 60 },
  // Publish retries only re-enter the handler; the handler refuses unless state is still pre-commit.
  [Q.PublishStandard]: { policy: 'standard', retryLimit: 30, retryDelay: 30, expireInSeconds: 15 * 60 },
  [Q.PublishAlbum]: { policy: 'standard', retryLimit: 30, retryDelay: 30, expireInSeconds: 30 * 60 },
  [Q.PublishVideo]: { policy: 'standard', retryLimit: 30, retryDelay: 30, expireInSeconds: 2 * 60 * 60 },
  [Q.PublishVerify]: { policy: 'standard', retryLimit: 5, retryDelay: 60, retryBackoff: true, expireInSeconds: 10 * 60 },
  [Q.PublishReconcile]: { policy: 'standard', retryLimit: 3, retryDelay: 120, expireInSeconds: 10 * 60 },
  [Q.AgentRecover]: { policy: 'standard', retryLimit: 0, expireInSeconds: 5 * 60 },
  [Q.SchedulerTick]: { policy: 'standard', retryLimit: 0, expireInSeconds: 60 },
};

export async function createBoss(connectionString: string, log: Logger): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString, schema: 'pgboss', application_name: 'seedingsys' });
  boss.on('error', (e) => {
    log.error({ err: e }, 'pg-boss error');
    captureError(e);
  });
  // Several processes start at once on a fresh database: pg-boss schema/queue creation can
  // deadlock between them, so retry with jitter and skip queues that already exist.
  await withDeadlockRetry(() => boss.start());
  for (const [name, opts] of Object.entries(QUEUE_SETTINGS)) {
    await withDeadlockRetry(async () => {
      // Existing queues keep the settings they were created with unless they are updated here.
      if (!(await boss.getQueue(name))) await boss.createQueue(name, { name, ...opts });
      else await boss.updateQueue(name, { name, ...opts });
    });
  }
  return boss;
}

async function withDeadlockRetry<T>(fn: () => Promise<T>, tries = 6): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (i >= tries || (code !== '40P01' && code !== '23505' && code !== '42P07')) throw e;
      await new Promise((r) => setTimeout(r, 200 + Math.random() * 800 * i));
    }
  }
}

export type Handler<N extends QueueName> = (payload: JobPayload<N>, meta: { jobId: string; retryCount: number }) => Promise<void>;

/**
 * Register `concurrency` workers on a queue (pg-boss v10 runs one batch at a time per worker).
 * Throwing from the handler fails the job → pg-boss retries per QUEUE_SETTINGS.
 */
export async function work<N extends QueueName>(boss: PgBoss, queue: N, concurrency: number, log: Logger, handler: Handler<N>): Promise<void> {
  for (let i = 0; i < concurrency; i++) {
    await boss.work<object>(queue, { batchSize: 1, pollingIntervalSeconds: 1, includeMetadata: true }, async (jobs) => {
      for (const job of jobs) {
        const jl = log.child({ queue, job_id: job.id });
        const started = Date.now();
        try {
          const payload = parseJob(queue, job.data);
          await handler(payload, { jobId: job.id, retryCount: job.retryCount });
          jl.debug({ ms: Date.now() - started }, 'job done');
        } catch (err) {
          jl.warn({ err, ms: Date.now() - started }, 'job failed');
          captureError(err, { queue, jobId: job.id });
          throw err;
        }
      }
    });
  }
}

/**
 * Move committed outbox rows to pg-boss. A crash between send and mark re-sends the row:
 * consumers are idempotent (at-least-once delivery).
 */
export async function relayOutboxOnce(db: Db, boss: PgBoss, now: () => Date, batch = 100): Promise<number> {
  return tx(db, async (t) => {
    const rows = await claimOutbox(t, batch);
    for (const r of rows) {
      await boss.send(r.queue, r.payload as object, {
        singletonKey: r.singletonKey ?? undefined,
        startAfter: r.startAfter ?? undefined,
      });
    }
    await markOutboxPublished(
      t,
      rows.map((r) => r.id),
      now(),
    );
    return rows.length;
  });
}
