import { ConflictException } from '@nestjs/common';
import { EXTENSION_CONNECTOR, RESEARCH_KINDS, type ResearchReport } from '@seedingsys/contracts';
import { accountResource, acquireLease, activeKillSwitch, assertLeaseHeld, json, releaseLease, type Tx } from '@seedingsys/db';
import { facebookPostLink, facebookSourceUrl } from '@seedingsys/domain';

const scanTtlMs = 150_000;
const kind = { in: [...RESEARCH_KINDS] };

export function researchDestination(raw: string) {
  const post = facebookPostLink(raw);
  if (post && /^[\w]{1,200}$/.test(post.id)) {
    post.url.hostname = 'www.facebook.com';
    return { kind: 'RESEARCH_POST' as const, url: post.url.href };
  }
  const url = facebookSourceUrl(raw);
  return url ? { kind: 'RESEARCH_PROFILE' as const, url: url.href } : null;
}

export function researchMedia(value: string) {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.port
    && /(?:^|\.)(?:facebook\.com|fbcdn\.net|fbsbx\.com)$/.test(url.hostname);
}

export async function claimResearch(t: Tx, targetId: string, installationId: string, now: Date) {
  if (await activeKillSwitch(t, { targetId, connector: EXTENSION_CONNECTOR })) return null;
  const scan = await t.extensionRadarScan.findFirst({
    where: { targetId, installationId, kind, state: 'QUEUED', expiresAt: { gt: now } }, orderBy: { createdAt: 'asc' },
  });
  if (!scan?.limit) return null;
  const lease = await acquireLease(t, {
    resource: accountResource(targetId), holder: 'research:' + scan.id, purpose: 'research:scan', ttlMs: scanTtlMs, now,
  });
  if (!lease) return null;
  await t.extensionRadarScan.update({ where: { id: scan.id },
    data: { state: 'RUNNING', leaseToken: lease.token, expiresAt: lease.expiresAt } });
  return { id: scan.id, action: 'research-scan' as const, kind: scan.kind, url: scan.url, limit: scan.limit, lifetimeMs: scanTtlMs };
}

export async function finishResearch(t: Tx, args: {
  id: string; installationId: string; targetId: string; report: ResearchReport | null; now: Date;
}) {
  const { id, installationId, targetId, report, now } = args;
  const scan = await t.extensionRadarScan.findFirst({ where: { id, installationId, targetId, kind } });
  if (!scan) throw new ConflictException('Lượt Post Research không thuộc profile này.');
  if (['COMPLETE', 'FAILED'].includes(scan.state)) return { ok: true };
  if (scan.state !== 'RUNNING' || scan.expiresAt <= now || scan.leaseToken === null) {
    throw new ConflictException('Lượt Post Research chưa được cấp hoặc đã hết hạn.');
  }
  if (report && (report.kind !== scan.kind || report.url !== scan.url)) {
    throw new ConflictException('Kết quả Post Research không khớp việc đã giao.');
  }
  if (report?.kind === 'RESEARCH_PROFILE') {
    if (report.rows.length > scan.limit! || report.rows.some(row => researchDestination(row.url)?.kind !== 'RESEARCH_POST')) {
      throw new ConflictException('Danh sách có liên kết hoặc số bài không hợp lệ.');
    }
  }
  if (report?.kind === 'RESEARCH_POST' && (report.mediaLinks.some(link => !researchMedia(link))
    || (report.authorUrl && researchDestination(report.authorUrl)?.kind !== 'RESEARCH_PROFILE')
    || report.comments.filter(comment => comment.depth === 0).length > scan.limit!)) {
    throw new ConflictException('Kết quả bài có dữ liệu ngoài phạm vi đã giao.');
  }
  const lease = { resource: accountResource(targetId), token: scan.leaseToken, holder: 'research:' + id, expiresAt: scan.expiresAt };
  if (!await assertLeaseHeld(t, lease, now)) throw new ConflictException('Profile không còn giữ lượt Post Research.');
  const value = await activeKillSwitch(t, { targetId, connector: EXTENSION_CONNECTOR }) ? null : report;
  await t.extensionRadarScan.update({ where: { id }, data: { state: value ? 'COMPLETE' : 'FAILED', ...(value && { result: json(value) }) } });
  await releaseLease(t, lease, now);
  return { ok: true };
}
