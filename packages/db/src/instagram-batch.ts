import { InstagramBatchPlanSchema, ResearchReportSchema, type ContentType, type ResearchReport } from '@seedingsys/contracts';
import { INSTAGRAM_RESEARCH_MEDIA_CONNECTOR, instagramMediaUrl, instagramSourceLink } from '@seedingsys/domain';
import { audit } from './audit';
import { ingestPost } from './content-ops';
import { storeInstagramComments } from './instagram-comments';
import { tx, type Db, type Tx } from './index';

export const instagramBatchPlan = (value: unknown) => InstagramBatchPlanSchema.safeParse(value).data;

export async function lockInstagramBatch(t: Tx, id: string) {
  await t.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 340173120))`;
}

type PostReport = Extract<ResearchReport, { kind: 'RESEARCH_POST' }>;
type PostLink = Extract<NonNullable<ReturnType<typeof instagramSourceLink>>, { type: 'post' }>;

export function completeInstagramContent(report: ResearchReport | undefined): report is PostReport {
  return report?.kind === 'RESEARCH_POST' && !report.captionPartial && !report.mediaPartial
    && report.expectedMediaCount !== undefined && report.expectedMediaCount === report.instagramMedia?.length;
}

export function instagramContentType(count: number, hasVideo: boolean, isReel: boolean): ContentType {
  if (count > 1) return hasVideo ? 'MEDIA_ALBUM' : 'MULTI_PHOTO';
  if (hasVideo) return isReel ? 'REEL' : 'VIDEO';
  return count === 1 ? 'SINGLE_PHOTO' : 'TEXT';
}

export function instagramPostMedia(data: PostReport, link: PostLink) {
  return (data.instagramMedia ?? []).flatMap((item, position) => {
    const url = instagramMediaUrl(item.url);
    return url ? [{ kind: item.kind, ref: link.id + ':' + item.kind + ':' + position, sourceUrl: url.href }] : [];
  });
}

export async function storeInstagramBatchPost(t: Tx, data: PostReport, context: {
  batchId: string; researchId: string; sourceId: string; destinationUid: string; actor: string; now: Date;
}) {
  if (!completeInstagramContent(data)) return false;
  const link = instagramSourceLink(data.url);
  if (link?.type !== 'post') return false;
  const media = instagramPostMedia(data, link);
  const hasVideo = media.some(item => item.kind === 'video');
  if (media.length !== data.expectedMediaCount) return false;
  const externalId = 'instagram:' + link.id;
  const contentType = instagramContentType(media.length, hasVideo, link.kind === 'reel');
  const prior = await t.sourcePost.findUnique({ where: { sourceId_externalId: { sourceId: context.sourceId, externalId } },
    select: { archivedAt: true } });
  if (prior?.archivedAt) return false;

  const outcome = await ingestPost(t, { sourceId: context.sourceId, connector: INSTAGRAM_RESEARCH_MEDIA_CONNECTOR, baseline: false,
    now: context.now, actor: context.actor, archiveOnly: true,
    post: { externalId, identityConfidence: 'HIGH', permalink: link.url, text: data.body, contentType, media,
      incomplete: [], isPinned: false, isShared: false,
      raw: { platform: 'instagram', researchId: context.researchId, rightsConfirmed: true, instagramMediaCount: data.expectedMediaCount,
        researchBatchId: context.batchId, destinationUid: context.destinationUid,
        instagramCommentStatus: data.instagramCommentStatus } } });
  if (data.instagramCommentStatus === 'READ') {
    const post = await t.sourcePost.findUniqueOrThrow({ where: { sourceId_externalId: { sourceId: context.sourceId, externalId } }, select: { id: true } });
    await storeInstagramComments(t, post.id, data, context.now);
  }
  if (outcome !== 'UNCHANGED') await audit(t, { entityType: 'research', entityId: context.researchId, action: 'instagram_imported',
    actor: context.actor, at: context.now, data: { contentType, mediaCount: media.length, sourceId: context.sourceId } });
  return true;
}

export async function saveApprovedInstagramBatchPost(db: Db, batchId: string, researchId: string, now: Date) {
  return tx(db, async t => {
    await lockInstagramBatch(t, batchId);
    const parent = await t.extensionRadarScan.findFirst({ where: { id: batchId, kind: 'RESEARCH_PROFILE', state: 'COMPLETE' }, select: { result: true } });
    const plan = instagramBatchPlan(parent?.result);
    if (!plan?.batchImport || !plan.batchDestinationUid) return false;
    const { sourceId, actor } = plan.batchImport;
    await t.$queryRaw`SELECT id FROM sources WHERE id=${sourceId}::uuid FOR UPDATE`;
    const source = await t.source.findFirst({ where: { id: sourceId, connector: 'manual', enabled: true }, select: { id: true } });
    if (!source) return false;
    const job = await t.extensionRadarScan.findFirst({ where: { id: researchId, kind: 'RESEARCH_POST', state: 'COMPLETE',
      AND: [{ result: { path: ['batch'], equals: true } }, { result: { path: ['batchProfileId'], equals: batchId } }] },
    select: { result: true } });
    const report = ResearchReportSchema.safeParse(job?.result).data;
    return completeInstagramContent(report) && storeInstagramBatchPost(t, report, {
      batchId, researchId, sourceId, destinationUid: plan.batchDestinationUid, actor, now,
    });
  });
}
