import { ConflictException } from '@nestjs/common';
import { EXTENSION_CONNECTOR } from '@seedingsys/contracts';
import { accountResource, acquireLease, activeKillSwitch, assertLeaseHeld, releaseLease, type Tx } from '@seedingsys/db';
import type { z } from 'zod';
import { RadarImport, saveRadar } from './persona-radar';

const scanTtlMs = 150_000;

export async function claimRadarScan(t: Tx, targetId: string, installationId: string, now: Date) {
  if (await activeKillSwitch(t, { targetId, connector: EXTENSION_CONNECTOR })) return null;
  const scan = await t.extensionRadarScan.findFirst({
    where: { targetId, installationId, state: 'QUEUED', kind: 'RADAR', expiresAt: { gt: now } }, orderBy: { createdAt: 'asc' },
  });
  if (!scan) return null;
  const lease = await acquireLease(t, {
    resource: accountResource(targetId), holder: 'radar:' + scan.id, purpose: 'radar:scan', ttlMs: scanTtlMs, now,
  });
  if (!lease) return null;
  await t.extensionRadarScan.update({
    where: { id: scan.id }, data: { state: 'RUNNING', leaseToken: lease.token, expiresAt: lease.expiresAt },
  });
  return { id: scan.id, action: 'radar-scan' as const, url: scan.url, lifetimeMs: scanTtlMs };
}

export async function finishRadarScan(t: Tx, args: {
  id: string; installationId: string; targetId: string; report: z.infer<typeof RadarImport> | null; now: Date;
}) {
  const { id, installationId, targetId, report, now } = args;
  const scan = await t.extensionRadarScan.findFirst({ where: { id, installationId, targetId, kind: 'RADAR' } });
  if (!scan) throw new ConflictException('Lượt Radar không thuộc profile này.');
  if (scan.state === 'COMPLETE' || scan.state === 'FAILED') return { ok: true };
  if (scan.state !== 'RUNNING' || scan.expiresAt <= now || scan.leaseToken === null) {
    throw new ConflictException('Lượt Radar chưa được cấp hoặc đã hết hạn.');
  }
  if (report && report.url !== scan.url) throw new ConflictException('Kết quả Radar không khớp trang đã giao.');
  const lease = { resource: accountResource(targetId), token: scan.leaseToken, holder: 'radar:' + id, expiresAt: scan.expiresAt };
  if (!await assertLeaseHeld(t, lease, now)) throw new ConflictException('Profile không còn giữ lượt Radar.');
  const paused = await activeKillSwitch(t, { targetId, connector: EXTENSION_CONNECTOR });
  const radarId = report && !paused ? (await saveRadar(t, { ...report, analyzedAt: now }, true)).id : null;
  await t.extensionRadarScan.update({ where: { id }, data: { state: radarId ? 'COMPLETE' : 'FAILED', radarId } });
  await releaseLease(t, lease, now);
  return { ok: true };
}
