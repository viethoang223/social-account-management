/**
 * Idempotent pilot seed: N1–N5 → B1–B5 (1:1), one browser worker host, profiles pinned to it.
 *   APP_ENV=local      → FakeConnector, fake platform file, capability checks pre-certified
 *   APP_ENV=pilot-test → fb-web, register the bundled connector release
 * Real URLs/IDs are filled in through the API or env (SEED_N1_REF=..., SEED_B1_ID=...).
 */
import { resolve } from 'node:path';
import { loadConfig } from '@seedingsys/config';
import { FakePlatform } from '@seedingsys/connectors-fake';
import { FB_WEB_VERSION } from '@seedingsys/connectors-fb-web';
import { CONTENT_TYPES, legacySourceCode } from '@seedingsys/contracts';
import { createDb } from '@seedingsys/db';

async function main() {
  const cfg = loadConfig();
  const db = createDb(cfg.DATABASE_URL);
  const local = cfg.APP_ENV === 'local';
  const connector = local ? 'fake' : 'fb-web';
  const n = Number(process.env.SEED_COUNT ?? 5);

  const node = await db.workerNode.upsert({
    where: { name: `browser:${cfg.WORKER_NAME}` },
    create: { name: `browser:${cfg.WORKER_NAME}`, kind: 'BROWSER' },
    update: {},
  });
  const version = local ? 'fake-1.0.0' : FB_WEB_VERSION;
  await db.connectorRelease.upsert({
    where: { connector_version: { connector, version } },
    create: { connector, version, active: true },
    update: local ? { active: true } : {},
  });
  const platform = local ? new FakePlatform({ file: resolve(cfg.FAKE_PLATFORM_FILE) }) : null;

  for (let i = 1; i <= n; i++) {
    const code = `N${i}`;
    const ref = process.env[`SEED_${code}_REF`] ?? process.env[`SEED_${legacySourceCode(code)}_REF`] ?? code;
    const ext = process.env[`SEED_B${i}_ID`] ?? `fb-B${i}`;
    const s = await db.source.upsert({
      where: { code },
      create: { code, name: `Nguồn ${code}`, externalRef: ref, connector },
      update: {},
    });
    const t = await db.targetAccount.upsert({
      where: { code: `B${i}` },
      create: { code: `B${i}`, name: `Tài khoản B${i}`, externalId: ext, connector, audience: 'ONLY_ME', styleProfile: { tone: 'thân thiện', emoji: 'ít', prefix: `[B${i}]` } },
      update: {},
    });
    await db.sourceTargetMapping.upsert({
      where: { sourceId_targetId: { sourceId: s.id, targetId: t.id } },
      create: { sourceId: s.id, targetId: t.id },
      update: {},
    });
    await db.browserProfile.upsert({
      where: { targetId: t.id },
      create: { targetId: t.id, workerNodeId: node.id, profileDir: `/profiles/B${i}` },
      update: {},
    });
    if (local) {
      for (const ct of CONTENT_TYPES) {
        if (ct === 'UNSUPPORTED' || ct === 'NAMED_ALBUM' || ct === 'REEL') continue;
        await db.capabilityCheck.upsert({
          where: { targetId_contentType_connector_connectorVersion: { targetId: t.id, contentType: ct, connector: 'fake', connectorVersion: 'fake-1.0.0' } },
          create: { targetId: t.id, contentType: ct, connector: 'fake', connectorVersion: 'fake-1.0.0', passed: true, cases: 20, notes: 'local fake' },
          update: {},
        });
      }
      platform!.ensureSource(s.externalRef);
      platform!.ensureAccount(ext);
    }
  }
  console.log(`seeded ${n} sources/targets (${connector})`);
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
