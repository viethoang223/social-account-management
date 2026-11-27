import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '@seedingsys/config';
import { ConnectorRegistry } from '@seedingsys/connectors-core';
import { FakePlatform, FakePublishConnector, FakeReadConnector } from '@seedingsys/connectors-fake';
import { FbPublicReadConnector, FbWebPublishConnector, FbWebReadConnector, fbWebOptionsFromEnv } from '@seedingsys/connectors-fb-web';
import { ExtensionPublishConnector } from './runtime/extension';
import { ManualReadConnector } from '@seedingsys/connectors-manual';
import { FbGraphReadConnector, fbGraphOptionsFromEnv } from '@seedingsys/connectors-fb-graph';
import { Q } from '@seedingsys/contracts';
import { createDb } from '@seedingsys/db';
import { RetryLaterError, systemClock } from '@seedingsys/domain';
import { createLogger, initObservability } from '@seedingsys/observability';
import { createBoss, QUEUE_SETTINGS, work } from '@seedingsys/queue';
import { createStore } from '@seedingsys/storage';
import { DEFAULT_BROWSER_SETTINGS, handleAgentRecover, handlePublish, handleReconcile, handleSourcePoll, Semaphore, type BrowserCtx } from './index';
import { handleCommentScan } from './handlers/comment-scan';
import { handleCommentPublish } from './handlers/comment-publish';
import { handleProfileSync } from './handlers/profile-sync';
import { startChromeLauncher } from './chrome-launcher';

async function main() {
  const cfg = loadConfig();
  initObservability('worker-browser', cfg.SENTRY_DSN, cfg.APP_ENV);
  const log = createLogger('worker-browser', cfg.LOG_LEVEL);
  const db = createDb(cfg.DATABASE_URL);
  const clock = systemClock;

  const registry = new ConnectorRegistry();
  if (cfg.APP_ENV === 'local') {
    const platform = new FakePlatform({ file: resolve(cfg.FAKE_PLATFORM_FILE) });
    registry.addReader(new FakeReadConnector(platform)).addPublisher(new FakePublishConnector(platform));
  }
  const store = createStore(cfg);
  registry.addReader(new ManualReadConnector(store));
  registry.addReader(new FbGraphReadConnector(fbGraphOptionsFromEnv()));
  const fbOpts = fbWebOptionsFromEnv();
  registry.addReader(new FbPublicReadConnector(fbOpts));
  registry.addReader(new FbPublicReadConnector(fbOpts, 'fb-session'));
  registry.addReader(new FbWebReadConnector(fbOpts)).addPublisher(new FbWebPublishConnector(fbOpts));
  registry.addPublisher(new ExtensionPublishConnector(db, clock));

  const nodeName = `browser:${cfg.WORKER_NAME}`;
  const node = await db.workerNode.upsert({
    where: { name: nodeName },
    create: { name: nodeName, kind: 'BROWSER', lastHeartbeatAt: clock.now(), capabilities: { maxSessions: cfg.BROWSER_MAX_SESSIONS } },
    update: { lastHeartbeatAt: clock.now() },
  });

  const ctx: BrowserCtx = {
    db,
    clock,
    log,
    workerId: `${nodeName}:${process.pid}`,
    actor: nodeName,
    registry,
    store,
    tmpDir: join(tmpdir(), 'seedingsys'),
    ...DEFAULT_BROWSER_SETTINGS,
  };

  const boss = await createBoss(cfg.DATABASE_URL, log);
  // Host limits (spec §16): crawler ≤2, publisher ≤2 of which video ≤1, total sessions ≤4.
  const publishers = new Semaphore(cfg.PUBLISHER_CONCURRENCY);
  const collectors = new Semaphore(cfg.COLLECTOR_CONCURRENCY);
  const video = new Semaphore(cfg.VIDEO_CONCURRENCY);
  const retryable = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      if (e instanceof RetryLaterError) log.debug({ msg: e.message }, 'retry later');
      throw e;
    }
  };

  await work(boss, Q.SourcePoll, cfg.COLLECTOR_CONCURRENCY, log, (p) => retryable(() => collectors.run(() => handleSourcePoll(ctx, p))));
  await work(boss, Q.CommentScan, 1, log, (p, job) => retryable(() => collectors.run(() => handleCommentScan(ctx, p, job.retryCount))));
  await work(boss, Q.CommentPublish, 1, log, (p, job) => retryable(() => publishers.run(() => handleCommentPublish(ctx, p, job.retryCount))));
  await work(boss, Q.ProfileSync, 1, log, (p, job) => retryable(() => collectors.run(() => handleProfileSync(ctx, p, job.retryCount))));
  await work(boss, Q.PublishStandard, cfg.PUBLISHER_CONCURRENCY, log, (p) => retryable(() => publishers.run(() => handlePublish(ctx, p))));
  await work(boss, Q.PublishAlbum, 1, log, (p) => retryable(() => publishers.run(() => handlePublish(ctx, p))));
  await work(boss, Q.PublishVideo, cfg.VIDEO_CONCURRENCY, log, (p) => retryable(() => video.run(() => publishers.run(() => handlePublish(ctx, p)))));
  for (const queue of [Q.PublishVerify, Q.PublishReconcile] as const) {
    const retryLimit = QUEUE_SETTINGS[queue].retryLimit ?? 0;
    await work(boss, queue, 1, log, (p, job) => retryable(() => publishers.run(() => handleReconcile(ctx, p, job.retryCount >= retryLimit))));
  }
  await work(boss, Q.AgentRecover, 1, log, (p) => handleAgentRecover(ctx, p));
  const stopChromeLauncher = startChromeLauncher(ctx);

  const hb = setInterval(() => {
    void db.workerNode.update({ where: { id: node.id }, data: { lastHeartbeatAt: clock.now() } }).catch((err) => log.error({ err }, 'heartbeat failed'));
  }, 20_000);

  log.info({ env: cfg.APP_ENV, node: nodeName }, 'worker-browser started');
  const shutdown = async () => {
    stopChromeLauncher();
    clearInterval(hb);
    await boss.stop({ graceful: true, timeout: 60_000 });
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
