import { BadRequestException, Body, ConflictException, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { COMMENT_QUEUE_MS, COMMENT_READERS, COMMENT_STALL_MS, EXTENSION_CONNECTOR, Q, SUCCESS, UNRESOLVED, workflowFor, type PublishSnapshot } from '@seedingsys/contracts';
import { activeKillSwitch, approvedPersona, audit, closeVariantReviewTasks, commentListener, enqueue, freezeSnapshot, movePublication, moveSlot, openOperatorTask, personaCommentAuthor, Prisma, SnapshotBlockedError, tx, type Db, type Tx } from '@seedingsys/db';
import { commentBody, commentReplayBody, facebookCommentId, facebookPostId as postId, facebookPostLink, facebookUrl, hashObject, removeAdvertisingLinks, type Clock } from '@seedingsys/domain';
import { Roles, type Principal } from './auth';
import { CLOCK, DB } from './tokens';
import { Actor, parse } from './util';

const SYNC_TIMEOUT_MS = 8 * 60_000;
const PAGE_SIZE = 25;
const profileFields = { id: true, code: true, name: true, enabled: true } as const;
const assetFields = { id: true, kind: true, status: true, mime: true } as const;
const revisionFields = { id: true, text: true, albumTitle: true, incomplete: true, mediaStatus: true, raw: true,
  assets: { orderBy: { position: 'asc' as const }, select: { position: true, asset: { select: assetFields } } } } as const;
const variantFields = { id: true, targetId: true, caption: true, contentType: true, status: true, expiresAt: true, reviewReasons: true,
  snapshot: true, snapshotHash: true, revision: { select: revisionFields } } as const;
const publicationFields = { id: true, variantId: true, targetId: true, status: true, permalink: true, verifiedAt: true,
  lastReason: true, commentAccessConfirmedAt: true, variant: { select: variantFields } } as const;
const replayFields = { id: true, destinationId: true, authorTargetId: true, personaApprovalId: true, text: true,
  status: true, permalink: true, externalId: true, sendDetail: true, updatedAt: true, author: { select: { code: true } } } as const;

function revisionView(value: Prisma.SourcePostRevisionGetPayload<{ select: typeof revisionFields }>) {
  const { raw, ...revision } = value;
  const link = facebookUrl((raw as { sharedPermalink?: string } | null)?.sharedPermalink);
  return { ...revision, sharedPermalink: link?.href ?? null };
}

function variantView(value: Prisma.ContentVariantGetPayload<{ select: typeof variantFields }>, audience: string) {
  const { snapshot, revision, ...variant } = value;
  const frozen = snapshot as unknown as PublishSnapshot | null;
  return { ...variant, caption: frozen?.caption ?? variant.caption, audience: frozen?.audience ?? audience, revision: revisionView(revision) };
}

@Controller('library')
export class LibraryController {
  constructor(@Inject(DB) private readonly db: Db, @Inject(CLOCK) private readonly clock: Clock) {}

  @Get('profiles')
  async profiles() {
    const [sources, targets] = await Promise.all([
      this.db.source.findMany({ select: { ...profileFields, connector: true, lastSuccessAt: true, lastError: true, lastIncomplete: true,
        _count: { select: { posts: { where: { archivedAt: null } } } } } }),
      this.db.targetAccount.findMany({ select: { ...profileFields, _count: { select: { publications: { where: { status: { in: [...SUCCESS] } } } } } } }),
    ]);
    const order = (a: { code: string }, b: { code: string }) => a.code.localeCompare(b.code, 'en', { numeric: true });
    return { sources: sources.sort(order).map(source => ({ ...source,
      lastIncomplete: Array.isArray(source.lastIncomplete) ? source.lastIncomplete.filter(flag => typeof flag === 'string') : [],
    })), targets: targets.sort(order) };
  }

  @Get('profiles/:code')
  async posts(@Param('code') rawCode: string, @Query('page') pageInput: unknown, @Query('q') queryInput: unknown, @Query('trash') trashInput?: unknown) {
    const code = parse(z.string().regex(/^[a-z0-9_-]{1,40}$/i), rawCode).toUpperCase();
    const page = parse(z.coerce.number().int().min(1).max(2000).default(1), pageInput);
    const query = parse(z.string().trim().max(120).default(''), queryInput);
    const trash = trashInput === '1';
    const [source, target] = await Promise.all([
      this.db.source.findUnique({ where: { code }, select: profileFields }),
      this.db.targetAccount.findUnique({ where: { code }, select: profileFields }),
    ]);
    if (!source && !target) throw new NotFoundException('Không tìm thấy profile.');
    const rows = await this.db.$queryRaw<Array<{ id: string; sourceCode: string; date: Date; snippet: string; contentType: string;
      mediaStatus: string; status: string; commentCount: number; scanStatus: string | null; archivedAt: Date | null }>>`
      SELECT p.id, s.code AS "sourceCode", coalesce(p.posted_at,p.first_seen_at) AS date,
        p.archived_at AS "archivedAt",
        left(coalesce(v.caption, r.text),240) AS snippet,
        coalesce(v.content_type,p.content_type)::text AS "contentType", r.media_status::text AS "mediaStatus",
        coalesce(CASE WHEN pub.status IN ('FAILED_CONFIRMED','CANCELLED') AND pub.variant_id<>v.id THEN NULL ELSE pub.status::text END,
          v.status::text,'COLLECTED') AS status, sc.status::text AS "scanStatus",
        (SELECT count(*)::int FROM source_comments c WHERE c.source_post_id=p.id) AS "commentCount"
      FROM source_posts p JOIN sources s ON s.id=p.source_id
      LEFT JOIN publications pub ON pub.source_post_id=p.id AND pub.target_id=${target?.id ?? null}::uuid
      LEFT JOIN LATERAL (
        SELECT x.* FROM content_variants x WHERE x.source_post_id=p.id AND x.target_id=${target?.id ?? null}::uuid
        AND (x.status!='SUPERSEDED' OR x.id=pub.variant_id)
        ORDER BY (x.id IS NOT DISTINCT FROM pub.variant_id AND coalesce(pub.status NOT IN ('FAILED_CONFIRMED','CANCELLED'), false)) DESC,
          x.created_at DESC, x.id DESC LIMIT 1
      ) v ON true
      JOIN source_post_revisions r ON r.id=coalesce(v.revision_id,p.latest_revision_id)
      LEFT JOIN LATERAL (SELECT status FROM comment_scans x WHERE x.source_post_id=p.id ORDER BY created_at DESC,id DESC LIMIT 1) sc ON true
      WHERE ${source?.id ? Prisma.sql`p.source_id=${source.id}::uuid` : Prisma.sql`v.id IS NOT NULL`}
        AND ${source ? (trash ? Prisma.sql`p.archived_at IS NOT NULL` : Prisma.sql`p.archived_at IS NULL`)
          : Prisma.sql`(p.archived_at IS NULL OR pub.status IN ('PUBLISHED_VERIFIED','OPERATOR_CONFIRMED'))`}
        AND (${query}='' OR strpos(lower(coalesce(v.caption,r.text)), lower(${query}))>0)
      ORDER BY ${target ? Prisma.sql`coalesce(pub.verified_at,v.created_at)` : Prisma.sql`coalesce(p.posted_at,p.first_seen_at)`} DESC, p.id DESC
      LIMIT ${PAGE_SIZE + 1} OFFSET ${(page - 1) * PAGE_SIZE}`;
    return { profile: source ?? target, kind: source ? 'source' : 'target', page, hasMore: rows.length > PAGE_SIZE, posts: rows.slice(0, PAGE_SIZE) };
  }

  @Get('posts/:id')
  async detail(@Param('id', ParseUUIDPipe) id: string, @Actor() actor?: Principal) {
    const post = await this.db.sourcePost.findUnique({
      where: { id }, include: { source: { select: { ...profileFields, connector: true, mappings: {
        where: { enabled: true }, select: { target: { select: { ...profileFields, audience: true } } }, orderBy: { target: { code: 'asc' } },
      } } } },
    });
    if (!post?.latestRevisionId) throw new NotFoundException('Không tìm thấy bài.');
    const [revision, variants, publications, scan, comments, composedComments, authors, roleApprovals] = await Promise.all([
      this.db.sourcePostRevision.findUniqueOrThrow({ where: { id: post.latestRevisionId }, select: revisionFields }),
      this.db.contentVariant.findMany({ where: { sourcePostId: id, status: { not: 'SUPERSEDED' } },
        orderBy: [{ targetId: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }], distinct: ['targetId'], select: variantFields }),
      this.db.publication.findMany({ where: { sourcePostId: id }, select: publicationFields }),
      this.db.commentScan.findFirst({ where: { sourcePostId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
      this.db.sourceComment.findMany({ where: { sourcePostId: id }, orderBy: [{ position: 'asc' }, { id: 'asc' }],
        select: { id: true, externalId: true, parentExternalId: true, authorName: true, text: true, permalink: true, postedAt: true,
          replays: { select: replayFields } } }),
      this.db.publicationComment.findMany({ where: { sourcePostId: id },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], select: replayFields }),
      this.db.targetAccount.findMany({ where: { enabled: true, connector: { in: ['fb-web', EXTENSION_CONNECTOR] } },
        select: { ...profileFields, connector: true, externalId: true }, orderBy: { code: 'asc' } }),
      actor?.role === 'admin' || actor?.role === 'reviewer'
        ? this.db.personaApproval.findMany({ orderBy: { approvedAt: 'desc' }, select: { id: true, context: true } })
        : [],
    ]);
    const ids = [...new Set([...post.source.mappings.map(m => m.target.id), ...variants.map(v => v.targetId), ...publications.map(p => p.targetId)])];
    const targets = await this.db.targetAccount.findMany({ where: { id: { in: ids } }, select: { ...profileFields, audience: true }, orderBy: { code: 'asc' } });
    const { source, ...record } = post;
    const now = +this.clock.now();
    const timedOut = scan?.status === 'RUNNING' && now - +scan.updatedAt >= COMMENT_STALL_MS;
    const replayView = (r: Prisma.PublicationCommentGetPayload<{ select: typeof replayFields }>, sourceText?: string) => {
      const stale = now - +r.updatedAt >= (r.status === 'QUEUED' ? COMMENT_QUEUE_MS : COMMENT_STALL_MS);
      const text = sourceText !== undefined && ['DRAFT', 'APPROVED', 'QUEUED', 'FAILED'].includes(r.status) ? commentReplayBody(r.text, sourceText) : r.text;
      if (stale && r.status === 'QUEUED') return { ...r, text, status: 'FAILED', sendDetail: 'Hết thời gian chờ worker. Có thể gửi lại.' };
      if (stale && r.status === 'SENDING') return { ...r, status: 'UNKNOWN', sendDetail: 'Chưa rõ kết quả. Đối chiếu trên Facebook.' };
      return { ...r, text };
    };
    return {
      approvedRoles: roleApprovals.flatMap(approval => {
        const role = approvedPersona(approval.context);
        if (!role) return [];
        const speaker = authors.find(a => a.connector === EXTENSION_CONNECTOR && a.code === role.speaker.code && a.externalId === role.speaker.uid);
        const listener = authors.find(a => a.code === role.listener.code && a.externalId === role.listener.uid);
        return speaker && listener ? [{ id: approval.id, speakerId: speaker.id, listenerId: listener.id,
          label: `${role.speaker.alias} (${speaker.code}) → ${role.listener.alias} (${listener.code}) · ${role.relationship.self} / ${role.relationship.other}` }] : [];
      }),
      post: { ...record, permalink: facebookUrl(record.permalink)?.href ?? null },
      source: { id: source.id, code: source.code, name: source.name, enabled: source.enabled, connector: source.connector },
      revision: revisionView(revision),
      scan: timedOut ? { ...scan, status: 'FAILED', detail: 'Lượt quét đã hết thời gian. Có thể quét lại.' } : scan,
      canScan: !post.archivedAt && COMMENT_READERS.includes(source.connector) && (source.connector === 'fb-graph' || !!post.permalink),
      comments: comments.map(c => ({ ...c, text: commentBody(c.text), permalink: facebookUrl(c.permalink)?.href ?? null,
        replays: c.replays.map(r => replayView(r, c.text)) })),
      composedComments: composedComments.map(r => replayView(r)),
      authors: authors.map(({ externalId, ...author }) => author),
      destinations: targets.map(target => {
        const publication = publications.find(p => p.targetId === target.id);
        const permalink = facebookUrl(publication?.permalink);
        const variant = publication && !['CANCELLED', 'FAILED_CONFIRMED'].includes(publication.status)
          ? publication.variant : variants.find(v => v.targetId === target.id) ?? publication?.variant;
        return {
          target,
          publication: publication ? { id: publication.id, status: publication.status, verifiedAt: publication.verifiedAt,
            commentAccessConfirmed: !!publication.commentAccessConfirmedAt, extensionTarget: authors.some(a => a.id === target.id && a.connector === EXTENSION_CONNECTOR),
            permalink: permalink?.href ?? null, directLink: !!facebookPostLink(publication.permalink), lastReason: publication.lastReason } : null,
          variant: variant ? variantView(variant, target.audience) : null,
        };
      }),
    };
  }

  @Patch('posts/:id/archive')
  @Roles('reviewer')
  async archive(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Actor() actor: Principal) {
    const { archived } = parse(z.object({ archived: z.boolean() }), body);
    const now = this.clock.now();
    return tx(this.db, async t => {
      const [post] = await t.$queryRaw<Array<{ archived_at: Date | null }>>`SELECT archived_at FROM source_posts WHERE id=${id}::uuid FOR UPDATE`;
      if (!post) throw new NotFoundException('Không tìm thấy bài nguồn.');
      if (!!post.archived_at === archived) return { ok: true };
      if (archived && await t.publication.findFirst({ where: { sourcePostId: id, status: { in: [...UNRESOLVED] } }, select: { id: true } })) {
        throw new ConflictException('Bài đang đăng hoặc chờ đối soát. Hoàn tất lượt đăng trước khi xóa khỏi kho.');
      }
      const comments = { OR: [{ sourcePostId: id }, { source: { sourcePostId: id } }] } satisfies Prisma.PublicationCommentWhereInput;
      if (archived && await t.publicationComment.findFirst({ where: { ...comments, status: { in: ['SENDING', 'UNKNOWN'] } }, select: { id: true } })) {
        throw new ConflictException('Có bình luận đang gửi hoặc chờ đối chiếu. Hoàn tất lượt gửi trước khi xóa bài khỏi kho.');
      }
      await t.sourcePost.update({ where: { id }, data: { archivedAt: archived ? now : null, archivedBy: archived ? actor.actor : null } });
      if (archived) {
        const queued = await t.publication.findMany({ where: { sourcePostId: id, status: 'QUEUED' }, select: { id: true, slotId: true } });
        for (const p of queued) {
          if (await movePublication(t, { id: p.id, from: 'QUEUED', to: 'CANCELLED', actor: actor.actor, now, reason: 'SOURCE_POST_ARCHIVED' }) && p.slotId) {
            await moveSlot(t, { id: p.slotId, from: 'DISPATCHED', to: 'MISSED', actor: actor.actor, now, reason: 'SOURCE_POST_ARCHIVED' });
          }
        }
        await t.commentScan.updateMany({ where: { sourcePostId: id, status: { in: ['QUEUED', 'RUNNING'] } },
          data: { status: 'FAILED', detail: 'Bài nguồn đã chuyển vào thùng rác.', updatedAt: now } });
        await t.publicationComment.updateMany({ where: { ...comments, status: 'QUEUED' },
          data: { status: 'FAILED', sendDetail: 'Lượt gửi đã dừng vì bài nguồn được chuyển vào thùng rác.', updatedAt: now } });
      }
      const reviews = await t.contentVariant.findMany({ where: { sourcePostId: id, status: 'NEEDS_REVIEW',
        publications: { none: { status: { in: [...SUCCESS] } } } }, select: { id: true, targetId: true, reviewReasons: true } });
      for (const review of reviews) {
        if (archived) await closeVariantReviewTasks(t, review.id, actor.actor, now, 'source_post_archived');
        else await openOperatorTask(t, { variantId: review.id, targetId: review.targetId, kind: 'REVIEW_CONTENT', now,
          reason: (review.reviewReasons as string[])[0] ?? 'SOURCE_POST_RESTORED' });
      }
      await audit(t, { entityType: 'source_post', entityId: id, action: archived ? 'archived' : 'restored', actor: actor.actor, at: now });
      return { ok: true };
    });
  }

  @Get('profiles/:code/syncs')
  async profileSyncs(@Param('code') code: string) {
    const mappings = await this.db.sourceTargetMapping.findMany({
      where: { source: { code }, enabled: true },
      orderBy: { target: { code: 'asc' } },
      select: { target: { select: profileFields }, profileSyncs: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1,
        select: { id: true, phase: true, history: true, historyDone: true, detail: true, createdAt: true, updatedAt: true },
      } },
    });
    const ids = mappings.flatMap(m => m.profileSyncs.map(s => s.id));
    const stats = ids.length ? await this.db.$queryRaw<Array<{
      id: string; posts: number; toReview: number; approved: number; posted: number; changed: number; missingMedia: number;
      comments: number; commentsDrafted: number; commentsPosted: number; scansPending: number; scansPartial: number; scansComplete: number; scansUnrequested: number;
    }>>`
      SELECT i.sync_id AS id, count(*)::int AS posts,
        count(*) FILTER (WHERE v.status='NEEDS_REVIEW' AND coalesce(p.status::text,'') NOT IN ('PUBLISHED_VERIFIED','OPERATOR_CONFIRMED'))::int AS "toReview",
        count(*) FILTER (WHERE v.status='READY' AND coalesce(p.status::text,'') NOT IN ('PUBLISHED_VERIFIED','OPERATOR_CONFIRMED'))::int AS approved,
        count(*) FILTER (WHERE p.status IN ('PUBLISHED_VERIFIED','OPERATOR_CONFIRMED'))::int AS posted,
        count(*) FILTER (WHERE p.status IN ('PUBLISHED_VERIFIED','OPERATOR_CONFIRMED') AND (pv.revision_id<>sp.latest_revision_id
          OR (p.last_reason IS DISTINCT FROM 'operator_native_share' AND pv.caption IS DISTINCT FROM r.text)))::int AS changed,
        count(*) FILTER (WHERE r.media_status IN ('PENDING','FAILED') OR r.incomplete ?| ARRAY['MEDIA_COUNT_UNKNOWN','MEDIA_UNAVAILABLE'])::int AS "missingMedia",
        coalesce(sum(c.stored),0)::int AS comments, coalesce(sum(c.prepared),0)::int AS "commentsDrafted", coalesce(sum(c.posted),0)::int AS "commentsPosted",
        count(*) FILTER (WHERE sc.status IN ('QUEUED','RUNNING'))::int AS "scansPending",
        count(*) FILTER (WHERE sc.status IN ('FAILED','PARTIAL'))::int AS "scansPartial",
        count(*) FILTER (WHERE sc.status='COMPLETE')::int AS "scansComplete",
        count(*) FILTER (WHERE sc.id IS NULL)::int AS "scansUnrequested"
      FROM profile_sync_items i JOIN profile_syncs ps ON ps.id=i.sync_id JOIN source_target_mappings m ON m.id=ps.mapping_id
      JOIN source_posts sp ON sp.id=i.source_post_id AND sp.archived_at IS NULL JOIN source_post_revisions r ON r.id=sp.latest_revision_id
      LEFT JOIN content_variants v ON v.revision_id=sp.latest_revision_id AND v.target_id=m.target_id
      LEFT JOIN publications p ON p.source_post_id=sp.id AND p.target_id=m.target_id
      LEFT JOIN content_variants pv ON pv.id=p.variant_id
      LEFT JOIN LATERAL (SELECT id,status FROM comment_scans WHERE source_post_id=sp.id ORDER BY created_at DESC,id DESC LIMIT 1) sc ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS stored, count(pc.id)::int AS prepared, count(*) FILTER (WHERE pc.status='POSTED')::int AS posted
        FROM source_comments c LEFT JOIN publication_comments pc ON pc.source_comment_id=c.id AND pc.destination_id=m.target_id
        WHERE c.source_post_id=sp.id
      ) c ON true
      WHERE i.sync_id IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))}) GROUP BY i.sync_id` : [];
    const now = this.clock.now();
    return mappings.map(({ target, profileSyncs: [latest] }) => {
      const stale = latest && ['DISCOVERING','PREPARING'].includes(latest.phase) && +now - +latest.updatedAt >= SYNC_TIMEOUT_MS;
      return { target, latest: latest ? { ...latest, stats: stats.find(s => s.id === latest.id) ?? null,
        ...(stale && { phase: 'FAILED', detail: 'Lượt đồng bộ đã hết thời gian. Có thể chuẩn bị lại.' }),
      } : null };
    });
  }

  @Post('profiles/:code/syncs')
  @Roles('operator')
  async queueProfileSync(@Param('code') code: string, @Body() body: unknown, @Actor() actor: Principal) {
    const { targetId, history } = parse(z.object({ targetId: z.string().uuid(), history: z.boolean() }), body);
    const now = this.clock.now();
    return tx(this.db, async t => {
      const [row] = await t.$queryRaw<Array<{ id: string }>>`SELECT m.id FROM source_target_mappings m JOIN sources s ON s.id=m.source_id
        WHERE s.code=${code} AND m.target_id=${targetId}::uuid AND m.enabled FOR UPDATE OF m`;
      if (!row) throw new NotFoundException('Profile đích chưa có luồng từ nguồn này.');
      const mapping = await t.sourceTargetMapping.findUniqueOrThrow({ where: { id: row.id }, include: { source: true, target: true } });
      const active = await t.profileSync.findFirst({ where: { mappingId: row.id, phase: { in: ['DISCOVERING','PREPARING'] } } });
      if (active && +now - +active.updatedAt < SYNC_TIMEOUT_MS) return { syncId: active.id, queued: false };
      if (active) await t.profileSync.update({ where: { id: active.id }, data: { phase: 'FAILED', detail: 'Lượt trước đã hết thời gian.' } });
      if (history && (!mapping.source.enabled || (mapping.source.connector === 'fb-session' && !mapping.target.enabled))) {
        throw new ConflictException('Cần bật nguồn và phiên Facebook dùng để đọc. Bạn có thể chọn dữ liệu đã lưu ngay bây giờ.');
      }
      if (history && !['fb-public','fb-session','fb-graph'].includes(mapping.source.connector)) {
        throw new ConflictException('Kết nối nguồn này hỗ trợ đồng bộ từ dữ liệu đã lưu.');
      }
      const run = await t.profileSync.create({ data: { mappingId: row.id, phase: history ? 'DISCOVERING' : 'PREPARING',
        history, capturedUntil: now, requestedBy: actor.actor } });
      await enqueue(t, Q.ProfileSync, { syncId: run.id, step: 0 });
      await audit(t, { entityType: 'profile_sync', entityId: run.id, action: 'requested', actor: actor.actor, at: now, data: { mappingId: row.id, history } });
      return { syncId: run.id, queued: true };
    });
  }

  @Post('syncs/:id/approve')
  @Roles('reviewer')
  async approveProfileSync(@Param('id', ParseUUIDPipe) id: string, @Actor() actor: Principal) {
    const run = await this.db.profileSync.findUnique({ where: { id }, select: { phase: true, mapping: { select: { enabled: true } } } });
    if (!run || !run.mapping.enabled || run.phase !== 'PREPARED') throw new ConflictException('Lượt đồng bộ chưa chuẩn bị xong hoặc luồng đã tắt.');
    const now = this.clock.now();
    const eligible = (variantId?: string) => Prisma.sql`
      SELECT v.id, r.text AS caption FROM profile_sync_items i
      JOIN profile_syncs ps ON ps.id=i.sync_id AND ps.phase='PREPARED'
      JOIN source_target_mappings m ON m.id=ps.mapping_id AND m.enabled
      JOIN source_posts sp ON sp.id=i.source_post_id AND sp.archived_at IS NULL
      JOIN content_variants v ON v.id=i.prepared_variant_id AND v.revision_id=sp.latest_revision_id
      JOIN source_post_revisions r ON r.id=v.revision_id
      WHERE i.sync_id=${id}::uuid AND v.status='NEEDS_REVIEW' AND v.target_id=m.target_id AND (v.expires_at IS NULL OR v.expires_at>${now})
        AND v.content_type NOT IN ('UNSUPPORTED','NAMED_ALBUM') AND coalesce(v.caption,r.text)=r.text AND (length(trim(r.text))>0 OR v.content_type='REEL')
        AND r.media_status IN ('READY','NOT_REQUIRED') AND r.incomplete='[]'::jsonb AND r.raw->>'sharedPermalink' IS NULL
        AND NOT EXISTS (SELECT 1 FROM publications p WHERE p.source_post_id=sp.id AND p.target_id=v.target_id AND p.status NOT IN ('CANCELLED','FAILED_CONFIRMED'))
      ${variantId ? Prisma.sql`AND v.id=${variantId}::uuid FOR SHARE OF sp,m FOR NO KEY UPDATE OF v`
        : Prisma.sql`ORDER BY sp.posted_at NULLS LAST, v.id LIMIT 50`}`;
    const items = await this.db.$queryRaw<Array<{ id: string }>>(eligible());
    let approved = 0;
    for (const { id: variantId } of items) {
      try {
        const ok = await tx(this.db, async t => {
          const [v] = await t.$queryRaw<Array<{ caption: string }>>(eligible(variantId));
          if (!v) return false;
          const frozen = await freezeSnapshot(t, { variantId, now, from: 'NEEDS_REVIEW', actor: actor.actor, reviewedBy: actor.actor, caption: v.caption });
          if (frozen) await closeVariantReviewTasks(t, variantId, actor.actor, now, 'profile_sync_approved');
          return frozen;
        });
        if (ok) approved++;
      } catch (error) {
        if (!(error instanceof SnapshotBlockedError)) throw error;
      }
    }
    return { approved };
  }

  @Post('posts/:id/comments/scan')
  @Roles('operator', 'reviewer')
  async queueComments(@Param('id', ParseUUIDPipe) id: string, @Actor() actor: Principal) {
    const now = this.clock.now();
    return tx(this.db, async t => {
      await t.$queryRaw`SELECT id FROM source_posts WHERE id=${id}::uuid FOR UPDATE`;
      const record = await t.sourcePost.findUnique({ where: { id }, include: { source: true } });
      if (!record || record.archivedAt) throw new NotFoundException('Không tìm thấy bài hoặc bài đã chuyển vào thùng rác.');
      if (!COMMENT_READERS.includes(record.source.connector) || (record.source.connector !== 'fb-graph' && !record.permalink)) {
        throw new ConflictException('Kết nối hiện tại chưa đọc được bình luận cho bài này.');
      }
      if (await activeKillSwitch(t, { sourceId: record.sourceId, connector: record.source.connector })) {
        throw new ConflictException('Nguồn đang bị tạm dừng bằng công tắc dừng.');
      }
      const active = await t.commentScan.findFirst({ where: { sourcePostId: id, OR: [
        { status: 'QUEUED' }, { status: 'RUNNING', updatedAt: { gt: new Date(+now - COMMENT_STALL_MS) } },
      ] } });
      if (active) return { scanId: active.id, queued: false };
      await t.commentScan.updateMany({ where: { sourcePostId: id, status: 'RUNNING', updatedAt: { lte: new Date(+now - COMMENT_STALL_MS) } },
        data: { status: 'FAILED', detail: 'Lượt quét trước đã hết thời gian.', updatedAt: now } });
      const scan = await t.commentScan.create({ data: { sourcePostId: id, requestedBy: actor.actor, updatedAt: now } });
      await enqueue(t, Q.CommentScan, { scanId: scan.id, manual: true });
      await audit(t, { entityType: 'source_post', entityId: id, action: 'comments_scan_requested', actor: actor.actor, at: now, data: { scanId: scan.id } });
      return { scanId: scan.id, queued: true };
    });
  }

  @Patch('posts/:id/destinations/:targetId/comments/:commentId')
  @Roles('reviewer', 'operator')
  async updateComment(@Param('id', ParseUUIDPipe) id: string, @Param('targetId', ParseUUIDPipe) targetId: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @Body() body: unknown, @Actor() actor: Principal) {
    return this.updateCommentDraft(id, targetId, commentId, body, actor, false);
  }

  @Patch('posts/:id/destinations/:targetId/new-comments/:commentId')
  @Roles('reviewer', 'operator')
  async updateNewComment(@Param('id', ParseUUIDPipe) id: string, @Param('targetId', ParseUUIDPipe) targetId: string,
    @Param('commentId', ParseUUIDPipe) commentId: string, @Body() body: unknown, @Actor() actor: Principal) {
    return this.updateCommentDraft(id, targetId, commentId, body, actor, true);
  }

  private async updateCommentDraft(id: string, targetId: string, commentId: string, body: unknown, actor: Principal, composed: boolean) {
    const input = parse(z.discriminatedUnion('action', [
      z.object({ action: z.literal('draft'), text: z.string().trim().min(1).max(4000), authorTargetId: z.string().uuid().optional(), personaApprovalId: z.string().uuid().optional() }),
      z.object({ action: z.literal('approve'), text: z.string().trim().min(1).max(4000), authorTargetId: z.string().uuid().optional(), personaApprovalId: z.string().uuid().optional() }),
      z.object({ action: z.literal('omit') }),
      z.object({ action: z.literal('send') }),
      z.object({ action: z.literal('posted'), permalink: z.string().max(2000).url() }),
      z.object({ action: z.literal('confirmed_absent') }),
    ]), body);
    const operation = input.action === 'send' || input.action === 'confirmed_absent';
    if (actor.role === 'operator' && !operation && input.action !== 'posted') throw new ConflictException('Cần quyền duyệt để sửa hoặc duyệt bình luận.');
    if (actor.role === 'reviewer' && operation) throw new ConflictException('Cần quyền vận hành để gửi hoặc đối chiếu lượt gửi bình luận.');
    return tx(this.db, async t => {
      await t.$queryRaw`SELECT id FROM source_posts WHERE id=${id}::uuid FOR UPDATE`;
      const post = await t.sourcePost.findUnique({ where: { id }, select: { sourceId: true, archivedAt: true } });
      if (!post || post.archivedAt) throw new NotFoundException('Không tìm thấy bài hoặc bài đã chuyển vào thùng rác.');
      const pub = await t.publication.findUnique({ where: { targetId_sourcePostId: { targetId, sourcePostId: id } } });
      const mapping = await t.sourceTargetMapping.findUnique({ where: { sourceId_targetId: { sourceId: post.sourceId, targetId } }, select: { enabled: true } });
      if (!pub && !mapping?.enabled) throw new ConflictException('Profile đích chưa thuộc luồng của bài nguồn.');
      if (composed && (!pub || !SUCCESS.includes(pub.status) || !facebookPostLink(pub.permalink))) {
        throw new ConflictException('Cần bài đích đã đăng và có liên kết trực tiếp để soạn bình luận mới.');
      }
      const sourceComment = composed ? null : await t.sourceComment.findFirst({ where: { id: commentId, sourcePostId: id } });
      if (!composed && !sourceComment) throw new NotFoundException('Bình luận không thuộc bài nguồn này.');
      const comment = sourceComment ?? { sourcePostId: id, parentExternalId: null, text: '' };
      const current = composed
        ? await t.publicationComment.findUnique({ where: { id: commentId } })
        : await t.publicationComment.findUnique({ where: { destinationId_sourceCommentId: { destinationId: targetId, sourceCommentId: commentId } } });
      if (composed && current && (current.sourcePostId !== id || current.destinationId !== targetId)) {
        throw new NotFoundException('Bình luận không thuộc bài đích này.');
      }
      if (composed && !current && input.action !== 'draft' && input.action !== 'approve') {
        throw new NotFoundException('Chưa có bản nháp bình luận.');
      }
      if (current?.status === 'POSTED') throw new ConflictException('Bình luận này đã ghi nhận đăng.');
      const now = this.clock.now();
      const stale = !!current && +now - +current.updatedAt >= (current.status === 'QUEUED' ? COMMENT_QUEUE_MS : COMMENT_STALL_MS);
      const inFlight = current?.status === 'QUEUED' || current?.status === 'SENDING';
      if (inFlight && !stale) throw new ConflictException('Worker đang xử lý bình luận này.');
      const uncertain = current?.status === 'UNKNOWN' || current?.status === 'SENDING';
      if (uncertain && input.action !== 'posted' && input.action !== 'confirmed_absent') {
        throw new ConflictException('Cần đối chiếu bình luận trên Facebook trước.');
      }
      const dest = facebookPostLink(pub?.permalink);
      if (input.action === 'send') {
        await this.queueCommentSend(t, { postId: id, sourceId: post.sourceId, targetId, pub, comment, current, now });
      } else if (input.action === 'confirmed_absent') {
        if (!current || !uncertain || !pub || !SUCCESS.includes(pub.status) || !dest) {
          throw new ConflictException('Chỉ xác nhận vắng sau khi đối chiếu lượt gửi chưa rõ kết quả trên bài đích.');
        }
        const updated = await t.publicationComment.updateMany({ where: { id: current.id, status: current.status, sendVersion: current.sendVersion },
          data: { status: 'FAILED', sendDetail: 'Đã đối chiếu và xác nhận bình luận chưa xuất hiện. Có thể gửi lại.', updatedAt: now } });
        if (!updated.count) throw new ConflictException('Lượt gửi đã thay đổi. Tải lại bài.');
      } else if (input.action === 'posted') {
        if (!current || (!uncertain && !['APPROVED', 'FAILED', 'QUEUED'].includes(current.status)) || !pub || !SUCCESS.includes(pub.status)) throw new ConflictException('Cần duyệt bình luận và xác nhận bài đích đã đăng.');
        const actual = facebookUrl(input.permalink);
        // Store digits: links copied from notifications carry base64 ids, the worker's receipts carry digits.
        for (const key of ['comment_id', 'reply_comment_id']) {
          const value = facebookCommentId(actual?.searchParams.get(key));
          if (value) actual!.searchParams.set(key, value);
        }
        const commentId = actual?.searchParams.get('reply_comment_id') ?? actual?.searchParams.get('comment_id');
        if (!dest || !actual || postId(actual) !== dest.id || !commentId || !/^[A-Za-z0-9_:-]{1,150}$/.test(commentId)) {
          throw new BadRequestException('Dán liên kết trực tiếp tới bình luận trên đúng bài đích.');
        }
        if (comment.parentExternalId) {
          const parent = await t.publicationComment.findFirst({ where: { destinationId: targetId, status: 'POSTED',
            source: { externalId: comment.parentExternalId, sourcePostId: comment.sourcePostId } }, select: { permalink: true, externalId: true } });
          const parentUrl = facebookUrl(parent?.permalink);
          if (!parent || !actual.searchParams.get('reply_comment_id') ||
            ![facebookCommentId(parent.externalId), facebookCommentId(parentUrl?.searchParams.get('comment_id'))].includes(actual.searchParams.get('comment_id'))) {
            throw new ConflictException('Dán liên kết phản hồi trong nhánh của bình luận cha đã đăng.');
          }
        } else if (actual.searchParams.has('reply_comment_id')) {
          throw new ConflictException('Bình luận gốc cần đăng ở cấp đầu của bài đích.');
        }
        if (await t.publicationComment.findFirst({ where: { destinationId: targetId, externalId: commentId } })) {
          throw new ConflictException('Liên kết này đã được ghi nhận cho một bình luận.');
        }
        for (const key of [...actual.searchParams.keys()]) {
          if (!['id', 'story_fbid', 'fbid', 'v', 'comment_id', 'reply_comment_id'].includes(key)) actual.searchParams.delete(key);
        }
        actual.hash = '';
        const updated = await t.publicationComment.updateMany({ where: { id: current.id, status: current.status, sendVersion: current.sendVersion },
          data: { status: 'POSTED', externalId: commentId, permalink: actual.href, sendDetail: null, updatedAt: now } });
        if (!updated.count) throw new ConflictException('Lượt gửi đã thay đổi. Tải lại bài.');
      } else {
        const text = input.action === 'omit' ? current?.text ?? comment.text
          : composed ? input.text : commentReplayBody(removeAdvertisingLinks(input.text), comment.text);
        if (input.action !== 'omit' && !text) throw new BadRequestException('Nhập nội dung bình luận.');
        let authorTargetId = current?.authorTargetId;
        let personaApprovalId = current?.personaApprovalId ?? null;
        if (input.action !== 'omit') {
          personaApprovalId = input.personaApprovalId ?? null;
          const listenerId = personaApprovalId ? await commentListener(t, targetId, comment) : null;
          const author = personaApprovalId
            ? (listenerId ? await personaCommentAuthor(t, personaApprovalId, listenerId) : null)
            : (input.authorTargetId ? await t.targetAccount.findFirst({
              where: { id: input.authorTargetId, enabled: true, connector: 'fb-web' }, select: { id: true },
            }) : null);
          if (!author) throw new ConflictException('Chọn profile cũ đang bật hoặc vai đã duyệt khớp UID và người nghe.');
          authorTargetId = author.id;
        }
        const status = input.action === 'approve' ? 'APPROVED' : input.action === 'omit' ? 'OMITTED' : 'DRAFT';
        const update = { status, text, authorTargetId, personaApprovalId, sendDetail: null } as const;
        if (current) await t.publicationComment.update({ where: { id: current.id }, data: update });
        else await t.publicationComment.create({ data: { ...update, destinationId: targetId,
          ...(composed ? { id: commentId, sourcePostId: id } : { sourceCommentId: commentId }) } });
      }
      await audit(t, { entityType: 'source_post', entityId: id, action: 'comment_' + input.action, actor: actor.actor,
        at: this.clock.now(), data: { ...(composed ? { composedCommentId: commentId } : { sourceCommentId: commentId }), targetId, publicationId: pub?.id } });
      return { ok: true };
    });
  }

  /**
   * Queue every approved (or failed) comment of one destination post, top-level comments first.
   * A reply is queued with its parent: the worker waits for the parent before sending it.
   */
  @Post('posts/:id/destinations/:targetId/comments/send')
  @Roles('operator')
  async sendApprovedComments(@Param('id', ParseUUIDPipe) id: string, @Param('targetId', ParseUUIDPipe) targetId: string,
    @Actor() actor: Principal) {
    return tx(this.db, async t => {
      await t.$queryRaw`SELECT id FROM source_posts WHERE id=${id}::uuid FOR UPDATE`;
      const post = await t.sourcePost.findUnique({ where: { id }, select: { sourceId: true, archivedAt: true } });
      if (!post || post.archivedAt) throw new NotFoundException('Không tìm thấy bài hoặc bài đã chuyển vào thùng rác.');
      const pub = await t.publication.findUnique({ where: { targetId_sourcePostId: { targetId, sourcePostId: id } } });
      if (!pub || !SUCCESS.includes(pub.status) || !facebookPostLink(pub.permalink)) {
        throw new ConflictException('Cần bài đích đã đăng thành công và có liên kết trực tiếp.');
      }
      const comments = await t.sourceComment.findMany({ where: { sourcePostId: id }, orderBy: [{ position: 'asc' }, { id: 'asc' }],
        include: { replays: { where: { destinationId: targetId } } } });
      const byExternalId = new Map(comments.map(c => [c.externalId, c]));
      const depth = (comment: typeof comments[number]) => {
        let level = 0;
        for (let parent = comment.parentExternalId; parent && level < 50; parent = byExternalId.get(parent)?.parentExternalId ?? null) level++;
        return level;
      };
      // Stable sort: every level in thread order, parents before their replies.
      const ordered = comments.map(comment => ({ comment, level: depth(comment) })).sort((a, b) => a.level - b.level);
      const now = this.clock.now();
      const queuedParents = new Set<string>();
      const skipped: Array<{ commentId: string; text: string; reason: string }> = [];
      for (const { comment } of ordered) {
        const current = comment.replays[0];
        if (!current || !['APPROVED', 'FAILED'].includes(current.status)) continue;
        try {
          await this.queueCommentSend(t, { postId: id, sourceId: post.sourceId, targetId, pub, comment, current, now, queuedParents });
          queuedParents.add(comment.externalId);
        } catch (error) {
          if (!(error instanceof ConflictException)) throw error;
          skipped.push({ commentId: comment.id, text: commentBody(comment.text).slice(0, 80), reason: error.message });
        }
      }
      await audit(t, { entityType: 'source_post', entityId: id, action: 'comments_send_all', actor: actor.actor, at: now,
        data: { targetId, queued: queuedParents.size, skipped: skipped.length } });
      return { queued: queuedParents.size, skipped };
    });
  }

  /** Check one approved comment and queue it for the worker; throws ConflictException with the reason it cannot go. */
  private async queueCommentSend(t: Tx, { postId: id, sourceId, targetId, pub, comment, current, now, queuedParents }: {
    postId: string; sourceId: string; targetId: string; now: Date; queuedParents?: Set<string>;
    pub: Prisma.PublicationGetPayload<object> | null;
    comment: { parentExternalId: string | null; text: string; sourcePostId: string };
    current: Prisma.PublicationCommentGetPayload<object> | null;
  }) {
    if (!current || !['APPROVED', 'FAILED', 'QUEUED'].includes(current.status) || !pub || !SUCCESS.includes(pub.status) || !facebookPostLink(pub.permalink)) {
      throw new ConflictException('Cần duyệt bình luận và xác nhận liên kết trực tiếp của bài đích.');
    }
    const text = current.sourceCommentId ? commentReplayBody(current.text, comment.text) : current.text.trim();
    if (!text) throw new ConflictException('Cần duyệt bình luận có nội dung trước khi gửi.');
    const author = current.authorTargetId && await t.targetAccount.findFirst({ where: { id: current.authorTargetId, enabled: true,
      connector: { in: ['fb-web', EXTENSION_CONNECTOR] }, profile: { isNot: null } } });
    const target = await t.targetAccount.findUniqueOrThrow({ where: { id: targetId } });
    if (!author || !target.enabled) throw new ConflictException('Cần chọn hồ sơ Facebook đang bật và có trình duyệt đã đăng nhập.');
    if (author.connector === EXTENSION_CONNECTOR) {
      const listener = await commentListener(t, targetId, comment);
      const approved = listener && current.personaApprovalId && await personaCommentAuthor(t, current.personaApprovalId, listener);
      if (!approved || approved.id !== author.id) throw new ConflictException('Vai đã duyệt không còn khớp UID gửi hoặc người nghe.');
    }
    for (const accountId of new Set([author.id, targetId])) {
      if (await activeKillSwitch(t, { sourceId, targetId: accountId, connector: author.connector })) {
        throw new ConflictException('Luồng đăng bình luận đang bị tạm dừng.');
      }
    }
    const snapshot = (await t.contentVariant.findUnique({ where: { id: pub.variantId }, select: { snapshot: true } }))?.snapshot as unknown as PublishSnapshot | null;
    if (author.id !== targetId && (snapshot?.audience ?? target.audience) === 'ONLY_ME'
      && !(author.connector === EXTENSION_CONNECTOR && pub.commentAccessConfirmedAt)) {
      throw new ConflictException('Bài đích ở chế độ Chỉ mình tôi. Hồ sơ khác không thể bình luận.');
    }
    if (comment.parentExternalId && !queuedParents?.has(comment.parentExternalId)) {
      const parent = await t.publicationComment.findFirst({ where: { destinationId: targetId,
        source: { sourcePostId: id, externalId: comment.parentExternalId } }, select: { status: true, permalink: true } });
      if (parent?.status === 'OMITTED') {
        throw new ConflictException('Bình luận cha đã được bỏ qua trên bài đích nên phản hồi này không có chỗ để đăng.');
      }
      // A parent that is being sent is fine: the worker sends the reply once the parent is posted.
      const parentOnItsWay = parent?.status === 'QUEUED' || parent?.status === 'SENDING';
      if (!parentOnItsWay && (parent?.status !== 'POSTED' || !parent.permalink)) {
        throw new ConflictException('Chờ bình luận cha được ghi nhận trên bài đích.');
      }
    }
    const updated = await t.publicationComment.updateMany({ where: { id: current.id, status: current.status, sendVersion: current.sendVersion },
      data: { status: 'QUEUED', text, sendVersion: { increment: 1 }, sendDetail: null, updatedAt: now } });
    if (!updated.count) throw new ConflictException('Lượt gửi đã thay đổi. Tải lại bài.');
    await enqueue(t, Q.CommentPublish, { replayId: current.id, sendVersion: current.sendVersion + 1 });
  }

  @Patch('posts/:id/destinations/:targetId/comment-access')
  @Roles('operator')
  async confirmCommentAccess(@Param('id', ParseUUIDPipe) id: string, @Param('targetId', ParseUUIDPipe) targetId: string,
    @Body() body: unknown, @Actor() actor: Principal) {
    const { confirmed } = parse(z.object({ confirmed: z.boolean() }), body);
    return tx(this.db, async t => {
      await t.$queryRaw`SELECT id FROM source_posts WHERE id=${id}::uuid FOR UPDATE`;
      const pub = await t.publication.findFirst({ where: { sourcePostId: id, targetId, status: { in: [...SUCCESS] },
        post: { archivedAt: null }, target: { enabled: true, connector: EXTENSION_CONNECTOR } } });
      if (!pub || !facebookPostLink(pub.permalink)) throw new ConflictException('Cần bài đích đã đăng và có liên kết trực tiếp.');
      const now = this.clock.now();
      await t.publication.update({ where: { id: pub.id }, data: { commentAccessConfirmedAt: confirmed ? now : null } });
      await audit(t, { entityType: 'publication', entityId: pub.id, action: 'comment_access_changed', actor: actor.actor, at: now, data: { confirmed } });
      return { ok: true };
    });
  }

  @Patch('posts/:id/destinations/:targetId/permalink')
  @Roles('operator')
  async confirmPublishedLink(@Param('id', ParseUUIDPipe) id: string, @Param('targetId', ParseUUIDPipe) targetId: string,
    @Body() body: unknown, @Actor() actor: Principal) {
    const input = parse(z.object({ permalink: z.string().trim().url().max(2000) }), body);
    const link = facebookPostLink(input.permalink);
    if (!link) throw new BadRequestException('Dán liên kết trực tiếp tới bài đã đăng trên profile đích.');
    const { url, id: externalId } = link;
    return tx(this.db, async t => {
      await t.$queryRaw`SELECT id FROM target_accounts WHERE id=${targetId}::uuid FOR UPDATE`;
      await t.$queryRaw`SELECT id FROM source_posts WHERE id=${id}::uuid FOR SHARE`;
      const pub = await t.publication.findUnique({ where: { targetId_sourcePostId: { targetId, sourcePostId: id } }, include: { post: true } });
      if (!pub || !SUCCESS.includes(pub.status) || pub.post.archivedAt) throw new ConflictException('Bài đích chưa được xác nhận đăng.');
      if (facebookPostLink(pub.permalink)) throw new ConflictException('Bài đích đã có liên kết trực tiếp.');
      const source = facebookUrl(pub.post.permalink);
      if (pub.post.externalId === externalId || (source && postId(source) === externalId)
        || await t.sourcePostAlias.findFirst({ where: { sourcePostId: id, externalId }, select: { externalId: true } })) {
        throw new BadRequestException('Dán liên kết của bài đích.');
      }
      if (await t.publication.findFirst({ where: { targetId, id: { not: pub.id }, OR: [{ externalPostId: externalId }, { permalink: url.href }] } })) {
        throw new ConflictException('Liên kết này đã được ghi nhận cho một bài khác.');
      }
      const update = await t.publication.updateMany({ where: { id: pub.id, status: pub.status, permalink: pub.permalink },
        data: { permalink: url.href, externalPostId: externalId } });
      if (!update.count) throw new ConflictException('Bài đã thay đổi. Tải lại trang.');
      await audit(t, { entityType: 'publication', entityId: pub.id, action: 'operator_confirmed_permalink', actor: actor.actor,
        at: this.clock.now(), data: { permalink: url.href } });
      return { ok: true };
    });
  }

  @Post('posts/:id/destinations/:targetId/confirm-share')
  @Roles('operator')
  async confirmShare(@Param('id', ParseUUIDPipe) id: string, @Param('targetId', ParseUUIDPipe) targetId: string,
    @Body() body: unknown, @Actor() actor: Principal) {
    const input = parse(z.object({ permalink: z.string().trim().url().max(1000) }), body);
    const link = facebookPostLink(input.permalink);
    if (!link) throw new BadRequestException('Dán liên kết trực tiếp tới bài đã chia sẻ trên profile đích.');
    const { url: observed, id: externalId } = link;
    const now = this.clock.now();
    return tx(this.db, async t => {
      const [locked] = await t.$queryRaw<Array<{ id: string }>>`SELECT id FROM target_accounts WHERE id=${targetId}::uuid FOR UPDATE`;
      if (!locked) throw new NotFoundException('Không tìm thấy profile đích.');
      await t.$queryRaw`SELECT id FROM source_posts WHERE id=${id}::uuid FOR SHARE`;
      const post = await t.sourcePost.findUnique({ where: { id } });
      if (!post?.latestRevisionId || post.archivedAt) throw new NotFoundException('Không tìm thấy bài nguồn hoặc bài đã chuyển vào thùng rác.');
      const variant = await t.contentVariant.findFirst({ where: { sourcePostId: id, targetId, status: 'NEEDS_REVIEW', revisionId: post.latestRevisionId },
        select: { id: true, contentType: true, revision: { select: { raw: true } } } });
      const original = facebookUrl((variant?.revision.raw as { sharedPermalink?: string } | null)?.sharedPermalink);
      if (!variant || !original) throw new ConflictException('Bài này chưa có bản chờ duyệt để chia sẻ trực tiếp.');
      const source = facebookUrl(post.permalink);
      if (externalId === post.externalId || externalId === postId(original) || (source && postId(source) === externalId)
        || await t.sourcePostAlias.findFirst({ where: { sourcePostId: id, externalId }, select: { externalId: true } })) {
        throw new BadRequestException('Dán liên kết bài mới trên profile đích thay cho bài gốc.');
      }
      const existing = await t.publication.findFirst({ where: { targetId, OR: [{ sourcePostId: id }, { externalPostId: externalId }] }, select: { id: true } });
      if (existing) throw new ConflictException('Bài hoặc liên kết này đã có lượt đăng trong SeedingSys.');
      const pub = await t.publication.create({ data: { targetId, sourcePostId: id, variantId: variant.id, externalPostId: externalId,
        workflow: workflowFor(variant.contentType) ?? 'STANDARD', contentType: variant.contentType, status: 'OPERATOR_CONFIRMED',
        permalink: observed.href, snapshotHash: hashObject({ targetId, variantId: variant.id, permalink: observed.href }),
        verifiedAt: now, lastReason: 'operator_native_share',
      } });
      await closeVariantReviewTasks(t, variant.id, actor.actor, now, 'operator_native_share');
      await audit(t, { entityType: 'publication', entityId: pub.id, action: 'operator_native_share', actor: actor.actor, at: now, data: { permalink: observed.href } });
      return { publicationId: pub.id };
    });
  }
}
