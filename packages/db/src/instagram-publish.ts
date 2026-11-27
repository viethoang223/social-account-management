import { randomInt } from 'node:crypto';
import { EXTENSION_CONNECTOR, EXTENSION_FRESH_MS, EXTENSION_VERSION, Q, ResearchReportSchema, extensionMediaProtocol, isExtensionMediaFormat, type JobPayload } from '@seedingsys/contracts';
import { instagramSourceLink } from '@seedingsys/domain';
import { audit, dispatchBacklogItemInTransaction, enqueue, freezeSnapshot, json, lockInstagramBatch, tx, type DispatchContext, type Tx } from './index';

function verifiedManifest(revision: { raw: unknown; mediaStatus: string; incomplete: unknown; _count: { assets: number } }) {
  const raw = revision.raw as { rightsConfirmed?: boolean; instagramMediaCount?: number } | null;
  return raw?.rightsConfirmed === true && revision.mediaStatus === 'READY' && Array.isArray(revision.incomplete) && revision.incomplete.length === 0
    && revision._count.assets > 0 && raw.instagramMediaCount === revision._count.assets;
}

export async function publishInstagramPost(t: Tx, context: DispatchContext, targetId: string, sourceId: string, postId: string) {
  await t.$queryRaw`SELECT id FROM target_accounts WHERE id=${targetId}::uuid FOR UPDATE`;
  const target = await t.targetAccount.findUniqueOrThrow({ where: { id: targetId }, include: {
    extension: true, profile: { include: { workerNode: true } },
  } });
  const post = await t.sourcePost.findFirst({ where: { id: postId, sourceId, archivedAt: null } });
  if (!post?.latestRevisionId || !isExtensionMediaFormat(post.contentType)
    || instagramSourceLink(post.permalink ?? '')?.type !== 'post') throw new Error('Bài phải là ảnh hoặc Reel Instagram thuộc đúng nguồn.');
  const previous = await t.publication.findUnique({ where: { targetId_sourcePostId: { targetId, sourcePostId: post.id } } });
  if (previous) return previous.id;
  const revision = await t.sourcePostRevision.findUniqueOrThrow({ where: { id: post.latestRevisionId }, include: { _count: { select: { assets: true } } } });
  if (!verifiedManifest(revision)) {
    throw new Error('Bài chưa có caption và tệp đã xác nhận.');
  }
  const now = context.clock.now();
  const node = target.profile?.workerNode;
  const caps = node?.capabilities as { publishProtocol?: number; publishMediaProtocol?: number } | undefined;
  if (target.connector !== EXTENSION_CONNECTOR || !target.extension?.installationId || target.extension.uid !== target.externalId
    || !node?.lastHeartbeatAt || +now - +node.lastHeartbeatAt > EXTENSION_FRESH_MS
    || caps?.publishProtocol !== 2 || (caps.publishMediaProtocol ?? 0) < extensionMediaProtocol(post.contentType)) {
    throw new Error(`${target.code} cần đúng Chrome profile online với connector đăng media.`);
  }
  if (!target.enabled || target.audience !== 'PUBLIC') throw new Error(`${target.code} phải được bật và đặt Công khai.`);
  await t.sourceTargetMapping.upsert({ where: { sourceId_targetId: { sourceId, targetId } },
    update: {}, create: { sourceId, targetId, reviewMode: 'MANUAL' } });
  const proofKey = { targetId, contentType: post.contentType, connector: EXTENSION_CONNECTOR, connectorVersion: EXTENSION_VERSION };
  await t.capabilityCheck.upsert({ where: { targetId_contentType_connector_connectorVersion: proofKey }, update: {},
    create: { ...proofKey, passed: true, cases: 0, notes: 'Media protocol active. The browser must verify caption, attachment and audience before submission.' } });
  const variant = await t.contentVariant.create({ data: { sourcePostId: post.id, revisionId: revision.id, targetId,
    contentType: post.contentType, status: 'NEEDS_REVIEW', caption: revision.text } });
  if (!await freezeSnapshot(t, { variantId: variant.id, from: 'NEEDS_REVIEW', now,
    actor: context.actor, reviewedBy: context.actor, caption: revision.text, preserveCaption: true })) throw new Error('Không khóa được bản đăng.');
  return dispatchBacklogItemInTransaction(t, context, variant.id);
}

type BatchStep = JobPayload<typeof Q.InstagramBatchPublish>;

type BatchPlan = {
  targetId: string;
  sourceId: string;
  posts: Array<{ id: string; revisionId: string; gapSeconds: number }>;
  next: number;
  state: string;
  reason?: string;
  refreshMedia?: boolean;
};

export async function resumeInstagramPublishBatch(context: DispatchContext, batchId: string) {
  return tx(context.db, async t => {
    await lockInstagramBatch(t, batchId);
    const parent = await t.extensionRadarScan.findUniqueOrThrow({ where: { id: batchId }, select: { result: true } });
    const result = parent.result as { batchPublication?: BatchPlan } | null;
    const plan = result?.batchPublication;
    if (!plan || plan.state !== 'PAUSED' || !plan.posts[plan.next]
      || !['SOURCE_MEDIA_INCOMPLETE', 'SOURCE_REVISION_CHANGED', 'PREVIOUS_UNVERIFIED'].includes(plan.reason ?? '')) return false;
    if (plan.reason === 'PREVIOUS_UNVERIFIED') {
      const previous = plan.posts[plan.next - 1];
      if (!previous || !await t.publication.findFirst({ where: { targetId: plan.targetId, sourcePostId: previous.id,
        status: { in: ['PUBLISHED_VERIFIED', 'OPERATOR_CONFIRMED'] }, permalink: { not: null },
        committedAt: { not: null }, verifiedAt: { not: null },
      }, select: { id: true } })) return false;
    }
    const current = await t.publication.findUnique({ where: { targetId_sourcePostId: {
      targetId: plan.targetId, sourcePostId: plan.posts[plan.next].id,
    } }, select: { status: true } });
    if (current && ['FAILED_CONFIRMED', 'CANCELLED', 'UNKNOWN', 'NEEDS_OPERATOR'].includes(current.status)) return false;
    const now = context.clock.now();
    await t.extensionRadarScan.update({ where: { id: batchId }, data: { result: json({ ...result,
      batchPublication: { ...plan, refreshMedia: true, state: 'RUNNING', reason: null },
    }) } });
    await enqueue(t, Q.InstagramBatchPublish, { batchId, index: plan.next });
    await audit(t, { entityType: 'research', entityId: batchId, action: 'instagram_batch_publication_resumed',
      actor: context.actor, at: now, data: { position: plan.next + 1 } });
    return true;
  });
}

export async function startInstagramPublishBatch(context: DispatchContext, batchId: string, targetCode: string, sourceCode: string, pilotId: string) {
  return tx(context.db, async t => {
    await lockInstagramBatch(t, batchId);
    const batch = await t.extensionRadarScan.findFirstOrThrow({ where: { id: batchId, kind: 'RESEARCH_PROFILE', state: 'COMPLETE' } });
    const report = ResearchReportSchema.parse(batch.result);
    const original = batch.result as { batchDestinationUid?: string; batchImport?: { sourceId?: string }; batchPublication?: unknown };
    if (original.batchPublication) return original.batchPublication;
    if (report.kind !== 'RESEARCH_PROFILE' || instagramSourceLink(report.url)?.type !== 'profile' || !report.rows.length) throw new Error('Không có danh sách bài Instagram.');
    const target = await t.targetAccount.findUniqueOrThrow({ where: { code: targetCode } });
    const source = await t.source.findUniqueOrThrow({ where: { code: sourceCode } });
    if (!target.enabled || target.audience !== 'PUBLIC' || original.batchDestinationUid !== target.externalId
      || original.batchImport?.sourceId !== source.id) throw new Error('Nguồn, đích hoặc đối tượng xem chưa khớp lô đã duyệt.');
    const links = report.rows.map(row => row.url);
    const saved = await t.sourcePost.findMany({ where: { sourceId: source.id, permalink: { in: links }, archivedAt: null },
      select: { id: true, permalink: true, latestRevisionId: true, contentType: true } });
    const revisions = new Set((await t.sourcePostRevision.findMany({ where: { id: { in: saved.flatMap(post => post.latestRevisionId ?? []) },
      mediaStatus: 'READY' }, select: { id: true, raw: true, mediaStatus: true, incomplete: true, _count: { select: { assets: true } } } }))
      .filter(verifiedManifest).map(row => row.id));
    if (saved.length !== links.length || saved.some(post => !post.latestRevisionId || !revisions.has(post.latestRevisionId)
      || !isExtensionMediaFormat(post.contentType))) throw new Error('Chưa có đủ caption và media cho tất cả bài trong lô.');
    const pilot = await t.publication.findUniqueOrThrow({ where: { id: pilotId } });
    if (pilot.targetId !== target.id || !saved.some(post => post.id === pilot.sourcePostId) || !pilot.permalink
      || !pilot.verifiedAt || !pilot.committedAt) throw new Error('Cần nghiệm thu bài đầu trên đúng đích trước khi chạy lô.');
    const ordered = links.map(link => saved.find(row => row.permalink === link)!.id);
    const ids = [pilot.sourcePostId, ...ordered.filter(id => id !== pilot.sourcePostId)];
    const posts = ids.map((id, index) => ({ id, revisionId: saved.find(post => post.id === id)!.latestRevisionId!,
      gapSeconds: index ? randomInt(570, 631) : 0 }));
    const plan = { targetId: target.id, sourceId: source.id, posts, next: 1, state: posts.length > 1 ? 'RUNNING' : 'DISPATCHED' };
    const due = posts.length > 1 ? new Date(+pilot.committedAt + posts[1].gapSeconds * 1000) : null;
    await t.extensionRadarScan.update({ where: { id: batchId }, data: { result: json({ ...original, batchPublication: plan }) } });
    if (due) await enqueue(t, Q.InstagramBatchPublish, { batchId, index: 1 }, { startAfter: due });
    await audit(t, { entityType: 'research', entityId: batchId, action: 'instagram_batch_publication_scheduled', actor: context.actor,
      at: context.clock.now(), data: { targetCode, count: posts.length, startsFrom: pilot.committedAt.toISOString(), due: due?.toISOString() } });
    return plan;
  });
}

export async function runInstagramPublishBatch(context: DispatchContext, job: BatchStep) {
  return tx(context.db, async t => {
    await lockInstagramBatch(t, job.batchId);
    const parent = await t.extensionRadarScan.findUniqueOrThrow({ where: { id: job.batchId }, select: { result: true } });
    const result = parent.result as { batchPublication?: BatchPlan } | null;
    const plan = result?.batchPublication;
    if (!plan || plan.state !== 'RUNNING' || plan.next !== job.index) return;
    const current = plan.posts[job.index];
    if (!current) return;
    const stamp = context.clock.now();
    const setPlan = async (state: string, next: number, reason?: string) => {
      await t.extensionRadarScan.update({ where: { id: job.batchId }, data: { result: json({ ...result,
        batchPublication: { ...plan, state, next, reason } }) } });
    };
    if (job.index) {
      const previous = await t.publication.findUnique({ where: { targetId_sourcePostId: {
        targetId: plan.targetId, sourcePostId: plan.posts[job.index - 1].id,
      } }, select: { status: true, committedAt: true, verifiedAt: true, permalink: true } });
      if (!previous || ['CANCELLED', 'FAILED_CONFIRMED', 'UNKNOWN', 'NEEDS_OPERATOR'].includes(previous.status)) {
        await setPlan('PAUSED', job.index, 'PREVIOUS_UNVERIFIED');
        return;
      }
      if (!previous.verifiedAt || !previous.permalink || !previous.committedAt) {
        await enqueue(t, Q.InstagramBatchPublish, job, { startAfter: new Date(+stamp + 15_000) });
        return;
      }
      const due = new Date(+previous.committedAt + current.gapSeconds * 1000);
      if (due > stamp) {
        await enqueue(t, Q.InstagramBatchPublish, job, { startAfter: due });
        return;
      }
    }
    const post = await t.sourcePost.findFirst({ where: { id: current.id, sourceId: plan.sourceId, archivedAt: null },
      select: { latestRevisionId: true, permalink: true } });
    if (!post?.latestRevisionId || (!plan.refreshMedia && post.latestRevisionId !== current.revisionId)) {
      await setPlan('PAUSED', job.index, 'SOURCE_REVISION_CHANGED');
      return;
    }
    const revision = await t.sourcePostRevision.findUniqueOrThrow({ where: { id: post.latestRevisionId },
      include: { _count: { select: { assets: true } } } });
    if (!verifiedManifest(revision)) {
      const reading = plan.refreshMedia && await t.extensionRadarScan.findFirst({ where: {
        url: post.permalink ?? '',
        state: { in: ['QUEUED', 'RUNNING'] },
        result: { path: ['batchProfileId'], equals: job.batchId },
      }, select: { id: true } });
      if (reading || (plan.refreshMedia && revision.mediaStatus === 'PENDING')) {
        await enqueue(t, Q.InstagramBatchPublish, job, { startAfter: new Date(+stamp + 45_000) });
        return;
      }
      await setPlan('PAUSED', job.index, 'SOURCE_MEDIA_INCOMPLETE');
      return;
    }
    current.revisionId = revision.id;
    const target = await t.targetAccount.findUniqueOrThrow({ where: { id: plan.targetId }, select: {
      enabled: true, extension: { select: { installationId: true } },
      profile: { select: { workerNode: { select: { lastHeartbeatAt: true } } } },
    } });
    if (!target.enabled || !target.extension?.installationId) {
      await setPlan('PAUSED', job.index, 'TARGET_DISABLED_OR_UNBOUND');
      return;
    }
    const lastSeen = target.profile?.workerNode?.lastHeartbeatAt;
    if (!lastSeen || +stamp - +lastSeen > EXTENSION_FRESH_MS) {
      await enqueue(t, Q.InstagramBatchPublish, job, { startAfter: new Date(+stamp + 30_000) });
      return;
    }
    const publicationId = await publishInstagramPost(t, context, plan.targetId, plan.sourceId, current.id);
    await audit(t, { entityType: 'research', entityId: job.batchId, action: 'instagram_batch_publication_dispatched',
      actor: context.actor, at: stamp, data: { position: job.index + 1, publicationId } });
    const next = job.index + 1;
    await setPlan(next < plan.posts.length ? 'RUNNING' : 'DISPATCHED', next);
    if (next < plan.posts.length) await enqueue(t, Q.InstagramBatchPublish, { batchId: job.batchId, index: next }, { startAfter: new Date(+stamp + 15_000) });
  });
}
