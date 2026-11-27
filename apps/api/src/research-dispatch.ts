import { ConflictException } from '@nestjs/common';
import { EXTENSION_CONNECTOR, EXTENSION_FRESH_MS, INSTAGRAM_PROFILE_PROTOCOL, Q, RESEARCH_KINDS, ResearchIssueSchema, ResearchReportSchema, type InstagramResearchProtocol, type ResearchIssue, type ResearchReport } from '@seedingsys/contracts';
import { accountResource, acquireLease, activeKillSwitch, activeLease, assertLeaseHeld, audit, completeInstagramContent, enqueue,
  instagramBatchPlan, json, lockInstagramBatch, Prisma, releaseLease, storeInstagramComments, type Db, type Tx } from '@seedingsys/db';
import { facebookPostLink, facebookSourceUrl, INSTAGRAM_ORIGIN, instagramMediaUrl, instagramSourceLink } from '@seedingsys/domain';
import { z } from 'zod';

const scanTtlMs = 150_000;
const standardResearchCadenceMs = 30_000;
const instagramCompletionGraceMs = 75_000;
const profileStepMs = 8_000;
const profileLeaseMs = 75_000;
const kind = { in: [...RESEARCH_KINDS] };
export const continuousResearch = { result: { path: ['continuous'], equals: true } } satisfies Prisma.ExtensionRadarScanWhereInput;
export const batchResearch = { result: { path: ['batch'], equals: true } } satisfies Prisma.ExtensionRadarScanWhereInput;
export const outsideResearchBatch = { OR: [{ result: { equals: Prisma.DbNull } },
  { result: { path: ['batch'], equals: Prisma.AnyNull } }, { result: { path: ['batch'], equals: false } },
] } satisfies Prisma.ExtensionRadarScanWhereInput;
const Progress = z.object({ continuous: z.literal(true), automatic: z.boolean().optional(),
  report: ResearchReportSchema.optional(), stopped: z.boolean().optional(), needsProfile: z.boolean().optional(),
  idleSlices: z.number().int().nonnegative().optional() });
export const researchProgress = (value: unknown) => Progress.safeParse(value).data;
const CadenceTrial = z.object({ intervalMs: z.union([z.literal(6_000), z.literal(standardResearchCadenceMs)]),
  previousId: z.string().uuid().optional(), nextId: z.string().uuid().optional(),
  startedAtMs: z.number().int().optional(), finishedAtMs: z.number().int().optional() });
const Batch = z.object({ batch: z.literal(true), batchProfileId: z.string().uuid(), cadenceTrial: CadenceTrial.optional(),
  readerTargetId: z.string().uuid().optional(), includeComments: z.boolean().optional(),
  commentProbe: ResearchReportSchema.optional(), commentsChecked: z.boolean().optional(), postStartedAtMs: z.number().int().optional() });
export const researchBatch = (value: unknown) => Batch.safeParse(value).data;
export const researchBatchIssue = (value: unknown) => z.object({ issue: ResearchIssueSchema }).safeParse(value).data?.issue ?? null;
export const researchBatchJobs = (id: string) => ({ result: { path: ['batchProfileId'], equals: id } } satisfies Prisma.ExtensionRadarScanWhereInput);
const assignedBatch = (targetId: string) => ({ result: { path: ['readerTargetId'], equals: targetId } } satisfies Prisma.ExtensionRadarScanWhereInput);
export const instagramThreadJobs = (id: string) => ({ result: { path: ['instagramThread', 'postId'], equals: id } } satisfies Prisma.ExtensionRadarScanWhereInput);
export const outsideInstagramThread = { OR: [{ result: { equals: Prisma.DbNull } },
  { result: { path: ['instagramThread'], equals: Prisma.AnyNull } }],
} satisfies Prisma.ExtensionRadarScanWhereInput;
const InstagramThread = z.object({ instagramThread: z.object({ postId: z.string().uuid(), requested: z.literal(true) }) });
const instagramThreadWork = { result: { path: ['instagramThread', 'requested'], equals: true } } satisfies Prisma.ExtensionRadarScanWhereInput;

const threadWaiters = new Map<string, Set<() => void>>();

export function notifyInstagramThread(targetId: string) {
  for (const wake of threadWaiters.get(targetId) ?? []) wake();
}

export async function waitForInstagramThread(db: Db, targetId: string, installationId: string, now: () => Date) {
  // Keep the wait below both the extension request and the dashboard proxy timeouts.
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const listeners = threadWaiters.get(targetId) ?? new Set<() => void>();
    threadWaiters.set(targetId, listeners);
    let wake!: () => void;
    let timeout!: ReturnType<typeof setTimeout>;
    const event = new Promise<boolean>(resolve => {
      wake = () => resolve(true);
      timeout = setTimeout(() => resolve(false), deadline - Date.now());
    });
    listeners.add(wake);
    try {
      // Subscribe before checking the durable queue so an enqueue cannot fall between the two steps.
      const at = now();
      const queued = await db.extensionRadarScan.findFirst({ where: { targetId, installationId, kind: 'RESEARCH_POST',
        state: 'QUEUED', expiresAt: { gt: at }, ...instagramThreadWork }, select: { id: true } });
      if (queued && !await activeLease(db, accountResource(targetId), at)
        && !await activeKillSwitch(db, { targetId, connector: EXTENSION_CONNECTOR })) return true;
      if (!await event) return false;
    } finally {
      clearTimeout(timeout);
      listeners.delete(wake);
      if (!listeners.size) threadWaiters.delete(targetId);
    }
  }
  return false;
}

function nextTrialAt(startedAtMs: number, intervalMs: number, report: ResearchReport | undefined) {
  return startedAtMs + (completeInstagramContent(report) ? intervalMs : standardResearchCadenceMs);
}

export function researchDestination(raw: string) {
  const instagram = instagramSourceLink(raw);
  if (instagram) return { kind: instagram.type === 'post' ? 'RESEARCH_POST' as const : 'RESEARCH_PROFILE' as const, url: instagram.url };
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

export async function claimResearch(t: Tx, targetId: string, installationId: string, now: Date,
  instagramProtocol?: InstagramResearchProtocol, instagramLoggedIn?: boolean, instagramCadenceTrial?: number, instagramCommentsProtocol?: number) {
  if (await activeKillSwitch(t, { targetId, connector: EXTENSION_CONNECTOR })) return null;
  const instagramUrl = { url: { startsWith: INSTAGRAM_ORIGIN + '/' } };
  const base = { targetId, installationId, kind };
  const orderBy = { createdAt: 'asc' as const };
  const canContinue = instagramProtocol === INSTAGRAM_PROFILE_PROTOCOL && instagramLoggedIn;
  const trialScan = canContinue && instagramCadenceTrial === 1 ? await t.extensionRadarScan.findFirst({
    where: { ...base, kind: 'RESEARCH_POST', state: 'QUEUED', expiresAt: { gt: now },
      AND: [batchResearch, { OR: [6_000, standardResearchCadenceMs].map(intervalMs => ({
        result: { path: ['cadenceTrial', 'intervalMs'], equals: intervalMs },
      })) }] }, orderBy,
  }) : null;
  const trialBatch = researchBatch(trialScan?.result);
  const trial = trialBatch?.cadenceTrial;
  if (trial?.previousId) {
    const previous = await t.extensionRadarScan.findFirst({
      where: { ...base, id: trial.previousId, state: { in: ['FAILED', 'COMPLETE'] } }, select: { result: true },
    });
    const previousBatch = researchBatch(previous?.result);
    const timing = previousBatch?.cadenceTrial;
    if (!timing?.startedAtMs || !timing.finishedAtMs || timing.nextId !== trialScan?.id
      || previousBatch?.batchProfileId !== trialBatch?.batchProfileId
      || nextTrialAt(timing.startedAtMs, timing.intervalMs, ResearchReportSchema.safeParse(previous?.result).data) > +now) return null;
  }
  const ordinary = trialScan ?? await t.extensionRadarScan.findFirst({ where: { ...base, state: 'QUEUED', expiresAt: { gt: now },
    OR: [{ result: { equals: Prisma.DbNull } }, ...(canContinue && instagramCommentsProtocol === 1
      ? [instagramThreadWork] : [])],
    ...(!instagramProtocol ? { NOT: instagramUrl } : instagramProtocol < 4 ? { NOT: { ...instagramUrl, kind: 'RESEARCH_PROFILE' } } : {}),
  }, orderBy });
  const own = ordinary ?? (canContinue ? await t.extensionRadarScan.findFirst({
    where: { ...base, ...continuousResearch, state: { in: ['QUEUED', 'RUNNING'] } }, orderBy,
  }) : null);
  const transferable = own ?? (canContinue ? await t.extensionRadarScan.findFirst({ where: {
    kind: 'RESEARCH_PROFILE', targetId: { not: targetId }, state: { in: ['QUEUED', 'RUNNING'] }, expiresAt: { lte: now },
    AND: [continuousResearch, { result: { path: ['automatic'], equals: true } }],
    OR: [ { result: { path: ['needsProfile'], equals: true } }, { target: { enabled: false } },
      { target: { profile: { is: null } } }, { target: { profile: { is: { workerNode: { is: null } } } } },
      { target: { profile: { is: { workerNode: { is: { OR: [
        { lastHeartbeatAt: null }, { lastHeartbeatAt: { lt: new Date(+now - EXTENSION_FRESH_MS) } },
        { capabilities: { path: ['instagramLoggedIn'], equals: false } },
      ] } } } } } },
    ],
  }, orderBy }) : null);
  const queuedBatch = { kind: 'RESEARCH_POST', state: 'QUEUED' } as const;
  const pendingComments = { result: { path: ['commentProbe', 'kind'], equals: 'RESEARCH_POST' } } satisfies Prisma.ExtensionRadarScanWhereInput;
  const noPendingComments = { result: { path: ['commentProbe'], equals: Prisma.AnyNull } } satisfies Prisma.ExtensionRadarScanWhereInput;
  const scan = transferable ?? (canContinue ? (
    (instagramCommentsProtocol === 1 ? await t.extensionRadarScan.findFirst({ where: { ...queuedBatch,
      AND: [batchResearch, assignedBatch(targetId), pendingComments] }, orderBy }) : null)
    ?? await t.extensionRadarScan.findFirst({ where: { ...queuedBatch,
      AND: [batchResearch, assignedBatch(targetId), noPendingComments] }, orderBy })
    ?? await t.extensionRadarScan.findFirst({ where: { ...queuedBatch, AND: [batchResearch,
      { result: { path: ['cadenceTrial'], equals: Prisma.AnyNull } },
      { result: { path: ['readerTargetId'], equals: Prisma.AnyNull } },
    ] }, orderBy })
  ) : null);
  if (!scan?.limit) return null;
  const progress = researchProgress(scan.result);
  const selectedBatch = researchBatch(scan.result);
  const commentOnly = !!selectedBatch?.commentProbe || InstagramThread.safeParse(scan.result).success;
  const instagramProfile = scan.kind === 'RESEARCH_PROFILE' && scan.url.startsWith(INSTAGRAM_ORIGIN + '/');
  const lease = await acquireLease(t, {
    resource: accountResource(targetId), holder: 'research:' + scan.id, purpose: 'research:scan',
    ttlMs: progress ? profileLeaseMs : scanTtlMs + (instagramProfile ? instagramCompletionGraceMs : 0), now,
  });
  if (!lease) return null;
  const assigned = await t.extensionRadarScan.updateMany({ where: {
    id: scan.id, targetId: scan.targetId, installationId: scan.installationId, state: scan.state, leaseToken: scan.leaseToken,
  }, data: { targetId, installationId, state: 'RUNNING', leaseToken: lease.token, expiresAt: lease.expiresAt,
    ...(progress?.needsProfile && { result: json({ ...progress, needsProfile: false }) }),
    ...(trial && trialBatch && { result: json({ ...trialBatch, cadenceTrial: { ...trial, startedAtMs: +now } }) }),
    ...(selectedBatch?.includeComments && !selectedBatch.postStartedAtMs && {
      result: json({ ...selectedBatch, postStartedAtMs: +now }),
    }),
  } });
  if (!assigned.count) { await releaseLease(t, lease, now); return null; }
  if (scan.targetId !== targetId) await audit(t, { entityType: 'research', entityId: scan.id, action: 'research_reassigned',
    actor: 'research-dispatch', at: now, data: { fromTargetId: scan.targetId, targetId } });
  return { id: scan.id, action: 'research-scan' as const, kind: scan.kind, url: scan.url, limit: scan.limit,
    lifetimeMs: progress ? profileStepMs : scanTtlMs,
    ...(commentOnly && { instagramCommentsOnly: true }),
    ...(progress && { lease: lease.token.toString(), checkpoint: progress.report ?? null }) };
}

export async function finishResearch(t: Tx, args: {
  id: string; installationId: string; targetId: string; report: ResearchReport | null; issue?: ResearchIssue;
  lease?: string; pending?: boolean; now: Date;
}) {
  const { id, installationId, targetId, report, issue, now } = args;
  const scan = await t.extensionRadarScan.findFirst({ where: { id, installationId, targetId, kind } });
  if (!scan) throw new ConflictException('Lượt Post Research không thuộc profile này.');
  if (['COMPLETE', 'FAILED'].includes(scan.state)) return { ok: true };
  const progress = researchProgress(scan.result);
  if (progress && (!args.lease || args.lease !== scan.leaseToken?.toString() || scan.expiresAt <= now)) return { ok: true };
  if (!progress && (args.lease || args.pending)) throw new ConflictException('Lượt đọc này không hỗ trợ tiếp tục theo từng bước.');
  if (scan.state !== 'RUNNING' || scan.expiresAt <= now || scan.leaseToken === null) {
    throw new ConflictException('Lượt Post Research chưa được cấp hoặc đã hết hạn.');
  }
  if (report && (report.kind !== scan.kind || report.url !== scan.url)) {
    throw new ConflictException('Kết quả Post Research không khớp việc đã giao.');
  }
  const instagram = instagramSourceLink(scan.url);
  const thread = InstagramThread.safeParse(scan.result).data;
  const batch = researchBatch(scan.result);
  if (issue && (report || !instagram)) throw new ConflictException('Chẩn đoán lỗi không khớp lượt đọc Instagram.');
  if (report?.kind === 'RESEARCH_PROFILE') {
    if ((report.stopReason && (!instagram || !report.partial || report.rows.length >= scan.limit!))
      || report.rows.length > scan.limit! || report.rows.some(row => researchDestination(row.url)?.kind !== 'RESEARCH_POST'
      || Boolean(instagramSourceLink(row.url)) !== Boolean(instagram))) {
      throw new ConflictException('Danh sách có liên kết hoặc số bài không hợp lệ.');
    }
  }
  if (report?.kind === 'RESEARCH_POST') {
    const media = report.instagramMedia;
    const badMedia = instagram ? !media || media.length !== report.mediaLinks.length
      || media.some((item, index) => item.url !== report.mediaLinks[index] || !instagramMediaUrl(item.url))
      || (media.length > 0 && !report.hasMedia)
      || (report.expectedMediaCount !== undefined && !report.mediaPartial && report.expectedMediaCount !== media.length)
      : media !== undefined || report.expectedMediaCount !== undefined || report.mediaLinks.length > 10 || report.mediaLinks.some(link => !researchMedia(link));
    if (badMedia || (report.authorUrl && (researchDestination(report.authorUrl)?.kind !== 'RESEARCH_PROFILE'
      || Boolean(instagramSourceLink(report.authorUrl)) !== Boolean(instagram)))
      || report.comments.filter(comment => comment.depth === 0).length > scan.limit!) {
      throw new ConflictException('Kết quả bài có dữ liệu ngoài phạm vi đã giao.');
    }
    if ((!instagram && report.instagramCommentStatus) || ((thread || batch?.commentProbe) && !report.instagramCommentStatus)
      || (instagram && (report.instagramCommentStatus === 'READ') !== (report.comments.length > 0))) {
      throw new ConflictException('Trạng thái đọc bình luận Instagram không khớp kết quả.');
    }
  }
  const lease = { resource: accountResource(targetId), token: scan.leaseToken, holder: 'research:' + id, expiresAt: scan.expiresAt };
  if (!await assertLeaseHeld(t, lease, now)) throw new ConflictException('Profile không còn giữ lượt Post Research.');
  const stopped = await activeKillSwitch(t, { targetId, connector: EXTENSION_CONNECTOR });
  if (progress) {
    const previous = progress.report?.kind === 'RESEARCH_PROFILE' ? progress.report : undefined;
    let checkpoint = previous;
    if (report?.kind === 'RESEARCH_PROFILE') {
      const combined = new Map((checkpoint?.rows ?? []).map(row => [instagramSourceLink(row.url)?.id, row]));
      for (const row of report.rows) combined.set(instagramSourceLink(row.url)?.id, row);
      const rows = [...combined.values()].slice(0, scan.limit!);
      const partial = rows.length < scan.limit!;
      checkpoint = { ...report, rows, partial, stopReason: partial ? report.stopReason : undefined };
    }
    const needsProfile = progress.automatic && !stopped && (issue === 'IG_LOGIN' || checkpoint?.stopReason === 'IG_LOGIN');
    if (needsProfile && checkpoint) checkpoint = { ...checkpoint, stopReason: undefined };
    const pending = needsProfile || (args.pending && !issue && !stopped && (checkpoint?.partial ?? true) && !checkpoint?.stopReason);
    const count = checkpoint?.rows.length ?? 0;
    const advanced = count > (previous?.rows.length ?? 0) || (checkpoint?.scrollSteps ?? 0) > (previous?.scrollSteps ?? 0);
    const idleSlices = advanced ? 0 : Math.min(3, (progress.idleSlices ?? 0) + 1);
    const result = pending ? { ...progress, needsProfile: Boolean(needsProfile), idleSlices, ...(checkpoint && { report: checkpoint }) }
      : count && checkpoint ? { ...checkpoint, stopReason: checkpoint.partial ? (issue ?? checkpoint.stopReason) : undefined }
      : issue ? { issue } : { issue: 'IG_NO_GRID' };
    await t.extensionRadarScan.update({ where: { id }, data: {
      state: pending ? 'RUNNING' : count ? 'COMPLETE' : 'FAILED', leaseToken: null, result: json(result),
      ...(needsProfile && { expiresAt: now }),
    } });
    await releaseLease(t, lease, now);
    // A checkpoint is durable before Chrome asks for the next slice. A stalled page returns to the normal alarm.
    if (pending && !needsProfile && idleSlices < 3) return { ok: true, nextResearchPollMs: advanced ? 300 : 1200 };
    return { ok: true };
  }
  const cadenceTrial = batch?.cadenceTrial;
  const firstRead = batch?.commentProbe?.kind === 'RESEARCH_POST' ? batch.commentProbe : null;
  if (!stopped && batch?.includeComments && !firstRead && report?.kind === 'RESEARCH_POST'
    && (!report.instagramCommentStatus || report.instagramCommentStatus === 'UNAVAILABLE')) {
    await t.extensionRadarScan.update({ where: { id }, data: { state: 'QUEUED', expiresAt: now, leaseToken: null,
      result: json({ ...batch, commentProbe: report }),
    } });
    await releaseLease(t, lease, now);
    return { ok: true, ...(completeInstagramContent(report) && { nextResearchPollMs: Math.max(0, +scan.expiresAt - scanTtlMs + 6000 - +now) }) };
  }
  const value = stopped ? null : firstRead ? {
    ...firstRead, comments: report?.kind === 'RESEARCH_POST' ? report.comments : [],
    instagramCommentStatus: report?.kind === 'RESEARCH_POST' ? report.instagramCommentStatus : 'UNAVAILABLE' as const,
  } : report;
  const result = value ?? (!stopped && issue ? { issue } : null);
  const stored = batch ? { ...batch, ...result,
    ...(firstRead && { commentProbe: undefined, commentsChecked: true, ...(issue && { commentIssue: issue }) }),
    ...(cadenceTrial && { cadenceTrial: { ...cadenceTrial, finishedAtMs: +now } }) }
    : thread ? { ...thread, ...result } : result;
  if (thread && value?.kind === 'RESEARCH_POST') await storeInstagramComments(t, thread.instagramThread.postId, value, now);
  if (batch && !cadenceTrial && completeInstagramContent(value ?? undefined)) {
    await lockInstagramBatch(t, batch.batchProfileId);
    const parent = await t.extensionRadarScan.findUnique({ where: { id: batch.batchProfileId }, select: { result: true } });
    if (instagramBatchPlan(parent?.result)?.batchImport) await enqueue(t, Q.InstagramBatchImport, { batchId: batch.batchProfileId, researchId: id });
  }
  await t.extensionRadarScan.update({ where: { id }, data: { state: value ? 'COMPLETE' : 'FAILED', ...(stored && { result: json(stored) }) } });
  await releaseLease(t, lease, now);
  if (!issue && thread && value?.kind === 'RESEARCH_POST'
    && !['RATE_LIMITED', 'SESSION_REQUIRED'].includes(value.instagramThreadCheck?.check ?? '')
    && await t.extensionRadarScan.findFirst({ where: { targetId, installationId, kind: 'RESEARCH_POST', state: 'QUEUED',
      expiresAt: { gt: now }, ...instagramThreadWork }, select: { id: true } })) {
    return { ok: true, nextResearchPollMs: 1_200 };
  }
  if (cadenceTrial?.nextId && cadenceTrial.startedAtMs) {
    const nextResearchPollMs = nextTrialAt(cadenceTrial.startedAtMs, cadenceTrial.intervalMs, value ?? undefined) - +now;
    return { ok: true, nextResearchPollMs: Math.max(0, nextResearchPollMs) };
  }
  if (!issue && batch?.readerTargetId === targetId && completeInstagramContent(value ?? undefined)
    && await t.extensionRadarScan.findFirst({ where: { kind: 'RESEARCH_POST', state: 'QUEUED',
      AND: [researchBatchJobs(batch.batchProfileId), assignedBatch(targetId)] }, select: { id: true } })) {
    const started = +scan.expiresAt - scanTtlMs;
    return { ok: true, nextResearchPollMs: Math.max(0, started + 6000 - +now) };
  }
  return { ok: true };
}
