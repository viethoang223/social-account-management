import { Prisma, type ContentType } from '@prisma/client';
import { Q as QN, REVIEW_REASONS, SUCCESS, UNRESOLVED, ACTIVE, workflowFor, type IncompleteFlag, type PublishSnapshot } from '@seedingsys/contracts';
import { HOUR, INSTAGRAM_RESEARCH_MEDIA_CONNECTOR, contentKey, hashObject, isFacebookTimelineReader, removeAdvertisingLinks, revisionContentHash } from '@seedingsys/domain';
import { audit } from './audit';
import { contentHolder, duplicateVariant, findSamePost, findSourcePost, hasUnstablePostIds, markDuplicate, onStoredId, recordAlias, revisionContentKey } from './dedup';
import { enqueue } from './outbox';
import { closeVariantReviewTasks, openOperatorTask } from './operator-tasks';
import { moveVariant } from './transitions';

type Q = Prisma.TransactionClient;

export interface IngestPost {
  externalId: string;
  identityConfidence: 'HIGH' | 'LOW';
  permalink?: string;
  postedAt?: Date;
  text: string;
  albumTitle?: string;
  contentType: ContentType;
  isPinned: boolean;
  isShared: boolean;
  media: Array<{ kind: 'image' | 'video'; ref: string; sourceUrl?: string; expectedChecksum?: string; mime?: string;
    stored?: { objectKey: string; checksum: string; bytes: number } }>;
  incomplete: IncompleteFlag[];
  raw?: Record<string, unknown>;
}

export type IngestOutcome = 'NEW_POST' | 'NEW_REVISION' | 'UNCHANGED' | 'BASELINE';

const OPEN_VARIANT: Array<'FETCHING_MEDIA' | 'REWRITING' | 'VALIDATING' | 'READY' | 'NEEDS_REVIEW'> = [
  'FETCHING_MEDIA',
  'REWRITING',
  'VALIDATING',
  'READY',
  'NEEDS_REVIEW',
];

/** Prepare comment drafts for review. Preserve existing edits, omissions and receipts. */
export async function prepareCommentDrafts(t: Q, sourcePostId: string, targetIds: string[], now: Date) {
  if (!targetIds.length) return 0;
  return t.$executeRaw`
    INSERT INTO publication_comments (id, destination_id, source_comment_id, text, status, updated_at)
    SELECT gen_random_uuid(), d.target_id, c.id, c.text, 'DRAFT', ${now}
    FROM source_comments c CROSS JOIN unnest(${targetIds}::uuid[]) AS d(target_id)
    WHERE c.source_post_id=${sourcePostId}::uuid AND length(trim(c.text))>0
    ON CONFLICT (destination_id, source_comment_id) DO NOTHING`;
}

/** Remove the link previews a reader appended to the caption ("caption\n\nhttps://…"). */
function withoutAppendedPreviews(text: string, previews: string[]): string {
  let out = text;
  for (const url of [...previews].reverse()) if (out.endsWith('\n\n' + url)) out = out.slice(0, -(url.length + 2));
  return out;
}

/**
 * Store one read post (inside the poll transaction). Idempotent: re-reading the overlap window
 * finds the same (source, externalId) and the same content hash and changes nothing.
 * A post read again under another platform id (Facebook rotates pfbid) is recognised and stored as
 * an alias of the same record — never as a new post.
 * An edited post becomes a new revision; it never creates a second publication for a target that
 * already has one in flight or published, and content another source post already holds for a
 * target is recorded there as DUPLICATE.
 */
export async function ingestPost(
  t: Q,
  args: { sourceId: string; connector: string; post: IngestPost; baseline: boolean; now: Date; actor: string;
    archiveOnly?: boolean;
    draftCaption?: { targetId: string; value: string } },
): Promise<IngestOutcome> {
  const { now } = args;
  let post = args.connector.startsWith('fb-') ? { ...args.post, text: removeAdvertisingLinks(args.post.text) } : args.post;
  const isPublic = isFacebookTimelineReader(args.connector);
  const trackIncompleteMedia = isPublic || args.connector === 'fb-graph';
  const missingMedia = post.incomplete.some(flag => flag === 'MEDIA_COUNT_UNKNOWN' || flag === 'MEDIA_UNAVAILABLE');

  let sp = await findSourcePost(t, args.sourceId, post.externalId);
  if (!sp && hasUnstablePostIds(args.connector)) {
    sp = await findSamePost(t, args.sourceId, post);
    if (sp) await recordAlias(t, { sourceId: args.sourceId, externalId: post.externalId, post: sp, actor: args.actor, now });
  }
  if (sp) {
    post = onStoredId(post, sp);
    const [current] = await t.$queryRaw<Array<{ archived_at: Date | null }>>`
      SELECT archived_at FROM source_posts WHERE id=${sp.id}::uuid FOR UPDATE`;
    if (current?.archived_at) return 'UNCHANGED';
  }
  const isNewPost = !sp;
  if (!sp) {
    sp = await t.sourcePost.create({
      data: {
        sourceId: args.sourceId,
        externalId: post.externalId,
        identityConfidence: post.identityConfidence,
        permalink: post.permalink,
        contentType: post.contentType,
        isPinned: post.isPinned,
        isShared: post.isShared,
        isBaseline: args.baseline,
        postedAt: post.postedAt,
        firstSeenAt: now,
      },
    });
  }

  const promoteBaseline = isPublic && sp.isBaseline;
  const latest = trackIncompleteMedia && sp.latestRevisionId
    ? await t.sourcePostRevision.findUnique({ where: { id: sp.latestRevisionId } })
    : null;
  if (latest && post.incomplete.includes('CAPTION_TRUNCATED')
    && Array.isArray(latest.incomplete) && !latest.incomplete.includes('CAPTION_TRUNCATED')) {
    post = { ...post, text: latest.text, incomplete: post.incomplete.filter(flag => flag !== 'CAPTION_TRUNCATED') };
  }
  const latestInfo = latest?.raw as { postedAtExact?: boolean; sharedPermalink?: string; linkPreviews?: string[]; updated_time?: string } | null;
  const graphUpdatedAt = args.connector === 'fb-graph' && typeof post.raw?.updated_time === 'string' ? post.raw.updated_time : undefined;
  const graphUpdate = Date.parse(graphUpdatedAt ?? '');
  if (graphUpdate < Date.parse(latestInfo?.updated_time ?? '')) return 'UNCHANGED';
  // A later read can miss the link preview the reader appended to the caption: same post, keep the known text.
  const knownPreviews = Array.isArray(latestInfo?.linkPreviews) ? latestInfo.linkPreviews : [];
  if (latest && knownPreviews.length && !post.raw?.linkPreviews && latest.text !== post.text
    && withoutAppendedPreviews(latest.text, knownPreviews) === post.text) {
    post = { ...post, text: latest.text, raw: { ...post.raw, linkPreviews: knownPreviews } };
  }
  const manifest = { text: post.text, albumTitle: post.albumTitle, media: post.media.map(({ ref }) => ({ ref })) };
  const exactInstagramCaption = args.archiveOnly && args.connector === INSTAGRAM_RESEARCH_MEDIA_CONNECTOR;
  const baseHash = exactInstagramCaption ? hashObject({ ...manifest,
    ...(typeof post.raw?.instagramMediaCount === 'number' && { instagramMediaCount: post.raw.instagramMediaCount }),
  }) : revisionContentHash(manifest);
  const sharedPermalink = post.raw?.sharedPermalink ?? latestInfo?.sharedPermalink;
  const contentHash = trackIncompleteMedia
    ? hashObject({ baseHash, type: post.contentType, incomplete: [...post.incomplete].sort(), ...(sharedPermalink && { sharedPermalink }) })
    : baseHash;
  const improveDate = isPublic && post.postedAt && (!sp.postedAt || (post.raw?.postedAtExact === true && latestInfo?.postedAtExact !== true));
  const improveLink = post.identityConfidence === 'HIGH' && post.permalink && (isPublic || !sp.permalink) && post.permalink !== sp.permalink;
  if (!isNewPost && (improveDate || improveLink || (post.isShared && !sp.isShared))) {
    await t.sourcePost.update({ where: { id: sp.id }, data: {
      ...(improveDate && { postedAt: post.postedAt }),
      ...(improveLink && { permalink: post.permalink, identityConfidence: 'HIGH' }),
      ...(post.isShared && { isShared: true }),
    } });
  }
  // A guest preview can regress on a later read. Preserve a known complete manifest.
  const missing = (flags: unknown) => Array.isArray(flags) && flags.some(f => ['CAPTION_TRUNCATED', 'MEDIA_COUNT_UNKNOWN', 'MEDIA_UNAVAILABLE'].includes(f));
  if (latest && !missing(latest.incomplete) && missing(post.incomplete)) {
    if (sharedPermalink && !latestInfo?.sharedPermalink) {
      await t.sourcePostRevision.update({ where: { id: latest.id }, data: { raw: { ...latestInfo, sharedPermalink } as Prisma.InputJsonValue } });
    }
    return 'UNCHANGED';
  }
  const existingRev = await t.sourcePostRevision.findUnique({ where: { sourcePostId_contentHash: { sourcePostId: sp.id, contentHash } } });
  const equivalent = !sharedPermalink && latest?.contentHash === baseHash && sp.contentType === post.contentType
    && JSON.stringify(latest.incomplete) === JSON.stringify(post.incomplete) ? latest : null;
  const stored = existingRev ?? equivalent;
  if (exactInstagramCaption && stored && post.media.length) await refreshAssetUrls(t, stored.id, post.media);
  if (trackIncompleteMedia && stored) {
    if (post.media.length) await refreshAssetUrls(t, stored.id, post.media);
    const raw = stored.raw as Record<string, unknown> | null;
    const expected = post.raw?.expectedPhotoCount;
    const details: Record<string, unknown> = {};
    if (Number.isFinite(graphUpdate) && graphUpdatedAt !== raw?.updated_time) details.updated_time = graphUpdatedAt;
    if (typeof expected === 'number' && raw?.expectedPhotoCount !== expected) details.expectedPhotoCount = expected;
    if (improveDate && post.raw?.postedAtExact === true) Object.assign(details, { postedAtExact: true, stamp: post.raw.stamp ?? null });
    if (Object.keys(details).length) {
      await t.sourcePostRevision.update({ where: { id: stored.id }, data: { raw: { ...raw, ...details } as Prisma.InputJsonValue } });
    }
  }
  if (stored?.id === sp.latestRevisionId && !promoteBaseline) return 'UNCHANGED';

  // Known now when there is no media or every file's bytes are known (stored or imported with a checksum).
  const checksums = post.media.map(m => m.stored?.checksum ?? m.expectedChecksum);
  const knownKey = !missingMedia && checksums.every(Boolean)
    ? contentKey({ text: post.text, albumTitle: post.albumTitle, checksums: checksums as string[] }) : null;
  const rev = stored ?? await t.sourcePostRevision.create({
    data: {
      sourcePostId: sp.id,
      contentHash,
      text: post.text,
      albumTitle: post.albumTitle,
      incomplete: post.incomplete,
      raw: (sharedPermalink ? { ...post.raw, sharedPermalink } : post.raw) as Prisma.InputJsonValue | undefined,
      mediaStatus: post.media.some(m => !m.stored) ? 'PENDING' : missingMedia ? 'FAILED' : post.media.length ? 'READY' : 'NOT_REQUIRED',
      contentKey: knownKey,
    },
  });
  if (!stored) {
    for (const [i, m] of post.media.entries()) {
      const asset = await t.asset.create({
        data: { kind: m.kind, sourceRef: m.ref, sourceUrl: m.sourceUrl, connector: args.connector, expectedChecksum: m.expectedChecksum, mime: m.mime,
          ...(m.stored && { status: 'STORED', objectKey: m.stored.objectKey, checksum: m.stored.checksum, bytes: BigInt(m.stored.bytes) }) },
      });
      await t.postAsset.create({ data: { revisionId: rev.id, position: i, assetId: asset.id } });
      if (!m.stored) await enqueue(t, QN.AssetFetch, { assetId: asset.id });
    }
  }
  await t.sourcePost.update({ where: { id: sp.id }, data: { latestRevisionId: rev.id, contentType: post.contentType, ...(promoteBaseline && { isBaseline: false }) } });
  await audit(t, { entityType: 'source_post', entityId: sp.id, action: isNewPost ? 'discovered' : 'revised', actor: args.actor, data: { revisionId: rev.id }, at: now });

  // First sync of a source: keep for inspection only, never auto-eligible.
  if (args.archiveOnly || (sp.isBaseline && !promoteBaseline)) return isNewPost ? (args.archiveOnly ? 'NEW_POST' : 'BASELINE') : 'NEW_REVISION';

  const mappings = await t.sourceTargetMapping.findMany({ where: { sourceId: args.sourceId, enabled: true } });
  const key = mappings.length ? await revisionContentKey(t, rev.id) : null;
  for (const m of mappings) {
    const pub = await t.publication.findUnique({ where: { targetId_sourcePostId: { targetId: m.targetId, sourcePostId: sp.id } } });
    const locked = pub && [...SUCCESS, ...UNRESOLVED, ...ACTIVE, 'QUEUED'].includes(pub.status);
    if (locked) continue; // already published or in flight: a new revision does not trigger a new post

    if (latest?.text === post.text && (missing(latest.incomplete) || latest.mediaStatus === 'FAILED')) {
      const rejected = await t.contentVariant.findFirst({
        where: { revisionId: latest.id, targetId: m.targetId, status: 'REJECTED' },
        select: { id: true },
      });
      if (rejected) continue;
    }

    const open = await t.contentVariant.findMany({
      where: { sourcePostId: sp.id, targetId: m.targetId, revisionId: { not: rev.id }, status: { in: OPEN_VARIANT } },
    });
    const recoveredCaption = latest && missing(latest.incomplete)
      ? open.find(v => v.revisionId === latest.id && v.caption && v.caption !== latest.text)?.caption
      : undefined;
    const caption = args.draftCaption?.targetId === m.targetId ? args.draftCaption.value : recoveredCaption;
    for (const v of open) {
      const superseded = await moveVariant(t, { id: v.id, from: v.status, to: 'SUPERSEDED', actor: args.actor, now, reason: `revision ${rev.id}` });
      if (superseded && v.status === 'NEEDS_REVIEW') await closeVariantReviewTasks(t, v.id, args.actor, now, 'revision_superseded');
    }

    const base = isPublic ? now : post.postedAt ?? now;
    const expiresAt = new Date(base.getTime() + m.contentTtlHours * HOUR);
    const holder = await contentHolder(t, { targetId: m.targetId, sourcePostId: sp.id, contentKey: key, now });
    const prior = stored && await t.contentVariant.findUnique({
      where: { revisionId_targetId: { revisionId: rev.id, targetId: m.targetId } },
    });
    if (prior) {
      if (!holder && prior.status === 'SUPERSEDED') {
        const reason = 'SOURCE_REVISION_RESTORED';
        const changed = await moveVariant(t, { id: prior.id, from: prior.status, to: 'NEEDS_REVIEW', actor: args.actor, now, reason,
          data: { expiresAt, reviewReasons: [reason], snapshot: Prisma.DbNull, snapshotHash: null, readyAt: null, reviewedBy: null } });
        if (changed) await openOperatorTask(t, { kind: 'REVIEW_CONTENT', reason, targetId: m.targetId, variantId: prior.id, now });
      }
      continue;
    }
    if (holder) {
      // The target already has this content from another source post: keep a trace, never a second copy.
      const v = await t.contentVariant.create({
        data: { revisionId: rev.id, targetId: m.targetId, sourcePostId: sp.id, contentType: post.contentType, caption, expiresAt, ...duplicateVariant },
      });
      await audit(t, { entityType: 'variant', entityId: v.id, action: 'duplicate', to: 'DUPLICATE', actor: args.actor, data: { holder }, at: now });
      continue;
    }
    if (post.contentType === 'UNSUPPORTED' || rev.mediaStatus === 'FAILED' || missingMedia) {
      const reason = post.contentType === 'UNSUPPORTED' ? REVIEW_REASONS.UNSUPPORTED
        : rev.mediaStatus === 'FAILED' ? REVIEW_REASONS.MEDIA_FAILED : REVIEW_REASONS.INCOMPLETE;
      const v = await t.contentVariant.create({
        data: {
          revisionId: rev.id,
          targetId: m.targetId,
          sourcePostId: sp.id,
          contentType: post.contentType,
          status: 'NEEDS_REVIEW',
          caption,
          reviewReasons: [reason],
          expiresAt,
        },
      });
      await openOperatorTask(t, { kind: 'REVIEW_CONTENT', reason, targetId: m.targetId, variantId: v.id, now });
      continue;
    }
    const v = await t.contentVariant.create({
      data: {
        revisionId: rev.id,
        targetId: m.targetId,
        sourcePostId: sp.id,
        contentType: post.contentType,
        caption,
        status: rev.mediaStatus === 'PENDING' ? 'FETCHING_MEDIA' : 'REWRITING',
        expiresAt,
      },
    });
    if (rev.mediaStatus !== 'PENDING') await enqueue(t, QN.ContentRewrite, { variantId: v.id });
  }
  return isNewPost ? 'NEW_POST' : 'NEW_REVISION';
}

async function refreshAssetUrls(t: Q, revisionId: string, media: IngestPost['media']) {
  await t.$queryRaw`SELECT id FROM source_post_revisions WHERE id = ${revisionId}::uuid FOR UPDATE`;
  const assets = await t.postAsset.findMany({ where: { revisionId, asset: { status: { in: ['PENDING', 'FAILED'] } } }, include: { asset: true } });
  const urls = new Map(media.map(m => [m.ref, m.sourceUrl]));
  for (const { asset } of assets) {
    const url = asset.sourceRef && urls.get(asset.sourceRef);
    if (!url || url === asset.sourceUrl) continue;
    const restart = asset.status === 'FAILED';
    const changed = await t.asset.updateMany({
      where: { id: asset.id, status: asset.status, sourceUrl: asset.sourceUrl },
      data: { sourceUrl: url, fetchAttempts: 0, lastError: null, ...(restart && { status: 'PENDING' }) },
    });
    if (changed.count) {
      if (restart) await t.sourcePostRevision.update({ where: { id: revisionId }, data: { mediaStatus: 'PENDING' } });
      await enqueue(t, QN.AssetFetch, { assetId: asset.id });
    }
  }
}

/** After an asset is stored or failed: move the revision's variants forward when the whole set is settled. */
export async function advanceRevisionMedia(t: Q, revisionId: string, now: Date, actor: string): Promise<void> {
  await t.$queryRaw`SELECT id FROM source_post_revisions WHERE id = ${revisionId}::uuid FOR UPDATE`;
  const rev = await t.sourcePostRevision.findUnique({ where: { id: revisionId }, include: { assets: { include: { asset: true } } } });
  if (!rev || rev.mediaStatus !== 'PENDING') return;
  const statuses = rev.assets.map((a) => a.asset.status);
  if (statuses.some((s) => s === 'PENDING')) return;
  const failed = statuses.some((s) => s === 'FAILED') || (Array.isArray(rev.incomplete)
    && rev.incomplete.some(flag => flag === 'MEDIA_COUNT_UNKNOWN' || flag === 'MEDIA_UNAVAILABLE'));
  await t.sourcePostRevision.update({ where: { id: rev.id }, data: { mediaStatus: failed ? 'FAILED' : 'READY' } });
  const key = failed ? null : await revisionContentKey(t, rev.id);
  const variants = await t.contentVariant.findMany({ where: { revisionId, status: { in: ['FETCHING_MEDIA', 'NEEDS_REVIEW'] } } });
  for (const v of variants) {
    const reasons = v.reviewReasons as string[];
    const retrying = v.status === 'NEEDS_REVIEW' && reasons.length === 1 && reasons[0] === REVIEW_REASONS.MEDIA_FAILED;
    if (v.status !== 'FETCHING_MEDIA' && !retrying) continue;
    if (retrying && failed) continue;
    // Bytes are known now: a copy of content the target already holds stops here (no rewrite, no review).
    const holder = await contentHolder(t, { targetId: v.targetId, sourcePostId: v.sourcePostId, contentKey: key, now });
    if (holder) {
      await markDuplicate(t, { id: v.id, from: v.status, holder, actor, now });
      continue;
    }
    if (failed) {
      // Never publish a partial album / missing video.
      await moveVariant(t, { id: v.id, from: 'FETCHING_MEDIA', to: 'NEEDS_REVIEW', actor, now, reason: REVIEW_REASONS.MEDIA_FAILED, data: { reviewReasons: [REVIEW_REASONS.MEDIA_FAILED] } });
      await openOperatorTask(t, { kind: 'REVIEW_CONTENT', reason: REVIEW_REASONS.MEDIA_FAILED, targetId: v.targetId, variantId: v.id, now });
    } else if (await moveVariant(t, { id: v.id, from: v.status, to: 'REWRITING', actor, now, data: { reviewReasons: [] } })) {
      if (retrying) await closeVariantReviewTasks(t, v.id, actor, now, 'media_recovered');
      await enqueue(t, QN.ContentRewrite, { variantId: v.id });
    }
  }
}

export class SnapshotBlockedError extends Error {}

/** Build and freeze the publication snapshot (caption + ordered media manifest + audience). */
export async function freezeSnapshot(
  t: Q,
  args: { variantId: string; from: 'VALIDATING' | 'NEEDS_REVIEW'; now: Date; actor: string; caption?: string; reviewedBy?: string; preserveCaption?: boolean },
): Promise<boolean> {
  const variant = await t.contentVariant.findUnique({ where: { id: args.variantId }, select: { sourcePostId: true } });
  if (!variant) return false;
  const [sourcePost] = await t.$queryRaw<Array<{ archived_at: Date | null; latest_revision_id: string | null }>>`
    SELECT archived_at, latest_revision_id FROM source_posts WHERE id=${variant.sourcePostId}::uuid FOR SHARE`;
  if (!sourcePost || sourcePost.archived_at) return false;
  await t.$queryRaw`SELECT id FROM content_variants WHERE id=${args.variantId}::uuid FOR NO KEY UPDATE`;
  const v = await t.contentVariant.findUnique({
    where: { id: args.variantId },
    include: { target: true, revision: { include: { assets: { include: { asset: true }, orderBy: { position: 'asc' } } } } },
  });
  if (!v || v.status !== args.from || v.revisionId !== sourcePost.latest_revision_id || (v.expiresAt && v.expiresAt <= args.now)) return false;
  if (!workflowFor(v.contentType)) throw new SnapshotBlockedError('Định dạng bài hiện chưa có luồng đăng.');
  const flags = v.revision.incomplete;
  const raw = v.revision.raw as { sharedPermalink?: string; expectedPhotoCount?: number } | null;
  if (raw?.sharedPermalink) throw new SnapshotBlockedError('Mở bài gốc để chia sẻ trực tiếp trên Facebook.');
  if (v.revision.mediaStatus === 'FAILED' || v.revision.mediaStatus === 'PENDING' ||
    (Array.isArray(flags) && flags.some(flag => flag === 'MEDIA_COUNT_UNKNOWN' || flag === 'MEDIA_UNAVAILABLE'))) {
    throw new SnapshotBlockedError('Bài nguồn chưa tải đủ ảnh hoặc video. Quét lại nguồn để hoàn tất media trước khi duyệt.');
  }
  const inputCaption = args.caption ?? v.caption ?? (args.from === 'NEEDS_REVIEW' ? v.revision.text : '');
  const caption = args.preserveCaption ? inputCaption : removeAdvertisingLinks(inputCaption).trim();
  if (!caption.trim() && (args.preserveCaption ? !['REEL', 'VIDEO', 'SINGLE_PHOTO', 'MULTI_PHOTO', 'MEDIA_ALBUM'].includes(v.contentType)
    : v.contentType !== 'REEL' || inputCaption.trim())) {
    throw new SnapshotBlockedError('Nhập caption hợp lệ trước khi duyệt.');
  }
  const media = v.revision.assets.map((pa) => {
    if (pa.asset.status !== 'STORED' || !pa.asset.checksum || !pa.asset.objectKey) throw new SnapshotBlockedError('Bài chưa lưu đủ ảnh hoặc video.');
    return { position: pa.position, assetId: pa.assetId, checksum: pa.asset.checksum, objectKey: pa.asset.objectKey, mime: pa.asset.mime ?? 'application/octet-stream', kind: pa.asset.kind };
  });
  if (typeof raw?.expectedPhotoCount === 'number' && media.filter(asset => asset.kind === 'image').length !== raw.expectedPhotoCount) {
    throw new SnapshotBlockedError('Số ảnh đã lưu chưa khớp số ảnh xác nhận trong bài gốc.');
  }
  if (['VIDEO', 'REEL'].includes(v.contentType) && (media.length !== 1 || media[0].kind !== 'video')) {
    throw new SnapshotBlockedError('Cần đủ một video đã lưu trước khi duyệt.');
  }
  const snapshot: PublishSnapshot = {
    variantId: v.id,
    targetId: v.targetId,
    contentType: v.contentType,
    caption,
    albumTitle: v.revision.albumTitle,
    audience: v.target.audience,
    media,
  };
  return moveVariant(t, {
    id: v.id,
    from: args.from,
    to: 'READY',
    actor: args.actor,
    now: args.now,
    data: {
      caption,
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
      snapshotHash: hashObject(snapshot),
      readyAt: args.now,
      reviewedBy: args.reviewedBy,
    },
  });
}

/** Edit the frozen caption while a variant is still waiting for a publication. */
export async function editBacklogCaption(
  t: Q,
  args: { variantId: string; snapshotHash: string; caption: string; audience?: string; actor: string; now: Date },
): Promise<boolean> {
  const item = await t.contentVariant.findUnique({ where: { id: args.variantId }, select: { targetId: true } });
  if (!item) return false;
  // Share the dispatch lock so an edit either precedes queueing or is rejected.
  await t.$queryRaw`SELECT id FROM target_accounts WHERE id = ${item.targetId}::uuid FOR UPDATE`;
  const v = await t.contentVariant.findUnique({ where: { id: args.variantId }, include: { target: { select: { audience: true } } } });
  if (!v || v.status !== 'READY' || v.snapshotHash !== args.snapshotHash || (v.expiresAt && v.expiresAt <= args.now)) return false;
  const [source] = await t.$queryRaw<Array<{ archived_at: Date | null }>>`
    SELECT archived_at FROM source_posts WHERE id=${v.sourcePostId}::uuid FOR SHARE`;
  if (source?.archived_at) return false;
  const p = await t.publication.findUnique({
    where: { targetId_sourcePostId: { targetId: v.targetId, sourcePostId: v.sourcePostId } },
    select: { status: true },
  });
  if (p && p.status !== 'FAILED_CONFIRMED' && p.status !== 'CANCELLED') return false;
  const snapshot = v.snapshot as unknown as PublishSnapshot | null;
  if (!snapshot || hashObject(snapshot) !== v.snapshotHash) return false;
  if (args.audience !== undefined && args.audience !== v.target.audience) return false;
  const caption = removeAdvertisingLinks(args.caption).trim();
  if (!caption && (v.contentType !== 'REEL' || args.caption.trim())) return false;
  const next = { ...snapshot, caption, audience: args.audience ?? snapshot.audience };
  const changed = await t.contentVariant.updateMany({
    where: { id: v.id, status: 'READY', snapshotHash: args.snapshotHash },
    data: { caption, snapshot: next as unknown as Prisma.InputJsonValue, snapshotHash: hashObject(next) },
  });
  if (!changed.count) return false;
  await audit(t, { entityType: 'variant', entityId: v.id, action: args.audience === undefined ? 'caption_edited' : 'audience_updated',
    actor: args.actor, at: args.now, ...(args.audience !== undefined && { data: { from: snapshot.audience, to: next.audience } }) });
  return true;
}

/** Launch window of a target = the strictest enabled mapping (default 15'). */
export async function targetLateWindowMin(q: Q, targetId: string): Promise<number> {
  const r = await q.sourceTargetMapping.aggregate({ where: { targetId, enabled: true }, _min: { lateWindowMin: true } });
  return r._min.lateWindowMin ?? 15;
}
