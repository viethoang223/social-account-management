import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { loadConfig } from '@seedingsys/config';
import { initObservability } from '@seedingsys/observability';
import { AppModule } from './app.module';

async function main() {
  const cfg = loadConfig();
  initObservability('api', cfg.SENTRY_DSN, cfg.APP_ENV);
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error', 'warn', 'log'] });
  app.useBodyParser('json', {
    limit: '2mb',
    type: req => Boolean(req.headers['content-type']?.startsWith('application/json')
      && /^\/api\/personas\/(?:radar\/)?import$/.test((req.url ?? '').split('?')[0])),
  });
  app.useBodyParser('json');
  app.setGlobalPrefix('api', { exclude: ['health'] });
  app.enableShutdownHooks();
  // API_HOST=127.0.0.1 keeps the API off the LAN on a single-machine install (scripts/server.mjs sets it).
  const host = process.env.API_HOST;
  if (host) await app.listen(cfg.API_PORT, host);
  else await app.listen(cfg.API_PORT);
  console.log(`api listening on ${host ?? ''}:${cfg.API_PORT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
