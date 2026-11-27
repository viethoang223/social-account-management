import { resolve } from 'node:path';
import { loadConfig } from '@seedingsys/config';
import { ConnectorRegistry } from '@seedingsys/connectors-core';
import { FakePlatform, FakeReadConnector } from '@seedingsys/connectors-fake';
import { ManualReadConnector } from '@seedingsys/connectors-manual';
import { FbPublicReadConnector, FbWebReadConnector, fbWebOptionsFromEnv } from '@seedingsys/connectors-fb-web';
import { FbGraphReadConnector, fbGraphOptionsFromEnv } from '@seedingsys/connectors-fb-graph';
import { Q } from '@seedingsys/contracts';
import { createDb } from '@seedingsys/db';
import { systemClock } from '@seedingsys/domain';
import { createLogger, initObservability } from '@seedingsys/observability';
import { createBoss, work } from '@seedingsys/queue';
import { createStore } from '@seedingsys/storage';
import { handleAssetFetch, type MediaCtx } from './index';
import { instagramMediaReader } from './instagram-media';

/**
 * worker-media: asset.fetch now; media.prepare (FFprobe/FFmpeg transcode with its own CPU cap)
 * arrives with the video workflow (phase 4).
 */
async function main() {
  const cfg = loadConfig();
  initObservability('worker-media', cfg.SENTRY_DSN, cfg.APP_ENV);
  const log = createLogger('worker-media', cfg.LOG_LEVEL);
  const db = createDb(cfg.DATABASE_URL);
  const registry = new ConnectorRegistry();
  if (cfg.APP_ENV === 'local') registry.addReader(new FakeReadConnector(new FakePlatform({ file: resolve(cfg.FAKE_PLATFORM_FILE) })));

  const store = createStore(cfg);
  registry.addReader(new ManualReadConnector(store));
  const fbOpts = fbWebOptionsFromEnv();
  registry.addReader(new FbWebReadConnector(fbOpts));
  registry.addReader(new FbPublicReadConnector(fbOpts));
  registry.addReader(new FbPublicReadConnector(fbOpts, 'fb-session'));
  registry.addReader(new FbGraphReadConnector(fbGraphOptionsFromEnv()));
  registry.addReader(instagramMediaReader);
  const ctx: MediaCtx = { db, clock: systemClock, log, actor: `worker-media:${cfg.WORKER_NAME}`, registry, store, maxFetchAttempts: 5 };
  const boss = await createBoss(cfg.DATABASE_URL, log);
  await work(boss, Q.AssetFetch, 4, log, (p) => handleAssetFetch(ctx, p).then(() => undefined));
  log.info('worker-media started');

  const shutdown = async () => {
    await boss.stop({ graceful: true, timeout: 30_000 });
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
