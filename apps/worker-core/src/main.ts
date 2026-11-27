import { loadConfig } from '@seedingsys/config';
import { Q } from '@seedingsys/contracts';
import { createDb, runInstagramPublishBatch, saveApprovedInstagramBatchPost } from '@seedingsys/db';
import { systemClock } from '@seedingsys/domain';
import { createEditor, LlmGateway } from '@seedingsys/llm';
import { createLogger, initObservability } from '@seedingsys/observability';
import { createBoss, relayOutboxOnce, work } from '@seedingsys/queue';
import { handleContentRewrite, handleContentValidate, schedulerTick, type CoreCtx } from './index';

async function main() {
  const cfg = loadConfig();
  initObservability('worker-core', cfg.SENTRY_DSN, cfg.APP_ENV);
  const log = createLogger('worker-core', cfg.LOG_LEVEL);
  const db = createDb(cfg.DATABASE_URL);
  const clock = systemClock;
  const llm = new LlmGateway(db, createEditor(cfg), clock, { dailyBudgetUsd: cfg.LLM_DAILY_BUDGET_USD, maxConcurrency: cfg.LLM_MAX_CONCURRENCY });
  const ctx: CoreCtx = { db, clock, log, actor: `worker-core:${cfg.WORKER_NAME}`, llm };

  const boss = await createBoss(cfg.DATABASE_URL, log);
  await db.workerNode.upsert({
    where: { name: `core:${cfg.WORKER_NAME}` },
    create: { name: `core:${cfg.WORKER_NAME}`, kind: 'CORE', lastHeartbeatAt: clock.now() },
    update: { lastHeartbeatAt: clock.now() },
  });

  await boss.schedule(Q.SchedulerTick, '* * * * *', {}, { tz: cfg.TZ_OPERATIONS });
  await work(boss, Q.SchedulerTick, 1, log, async () => {
    const r = await schedulerTick(ctx);
    log.info(r, 'scheduler tick');
  });
  await work(boss, Q.ContentRewrite, cfg.LLM_MAX_CONCURRENCY, log, (p) => handleContentRewrite(ctx, p));
  await work(boss, Q.ContentValidate, 3, log, (p) => handleContentValidate(ctx, p));
  await work(boss, Q.InstagramBatchImport, 1, log, async ({ batchId, researchId }) => {
    await saveApprovedInstagramBatchPost(db, batchId, researchId, clock.now());
  });
  await work(boss, Q.InstagramBatchPublish, 2, log, (job) => runInstagramPublishBatch(ctx, job));

  // Outbox relay: tight loop, at-least-once into pg-boss.
  let stopping = false;
  const relay = async () => {
    while (!stopping) {
      try {
        const n = await relayOutboxOnce(db, boss, () => clock.now());
        if (n === 0) await new Promise((r) => setTimeout(r, 500));
      } catch (err) {
        log.error({ err }, 'outbox relay failed');
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  };
  void relay();

  const hb = setInterval(() => {
    void db.workerNode.update({ where: { name: `core:${cfg.WORKER_NAME}` }, data: { lastHeartbeatAt: clock.now() } }).catch(() => undefined);
  }, 30_000);

  log.info({ env: cfg.APP_ENV, llm: cfg.LLM_MODE }, 'worker-core started');
  const shutdown = async () => {
    stopping = true;
    clearInterval(hb);
    await boss.stop({ graceful: true, timeout: 20_000 });
    await db.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
