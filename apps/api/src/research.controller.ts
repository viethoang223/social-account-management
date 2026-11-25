import { BadRequestException, Body, ConflictException, Controller, Get, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { EXTENSION_CONNECTOR, EXTENSION_FRESH_MS, RESEARCH_KINDS, RESEARCH_LIMIT, ResearchReportSchema, SUCCESS, type ResearchKind, type ResearchWorkspace } from '@seedingsys/contracts';
import { activeKillSwitch, audit, ingestPost, prepareCommentDrafts, tx, type Db } from '@seedingsys/db';
import { facebookCommentId, facebookPostLink, facebookSourceUrl, hashObject, type Clock } from '@seedingsys/domain';
import { Roles, type Principal } from './auth';
import { researchDestination } from './research-dispatch';
import { CLOCK, DB } from './tokens';
import { Actor, parse } from './util';
import { z } from 'zod';

const researchKinds = { in: [...RESEARCH_KINDS] };

function numericOwner(author: string | null) {
  const url = author && facebookSourceUrl(author);
  if (!url) return undefined;
  return url.searchParams.get('id') ?? /^\/people\/[^/]+\/(\d+)$/.exec(url.pathname)?.[1];
}

@Controller('research')
@Roles('reviewer', 'operator')
export class ResearchController {
  constructor(@Inject(DB) private readonly db: Db, @Inject(CLOCK) private readonly clock: Clock) {}

  @Get()
  async workspace(): Promise<ResearchWorkspace> {
    const now = this.clock.now();
    const [jobs, sources, owners] = await Promise.all([
      this.db.extensionRadarScan.findMany({ where: { kind: researchKinds }, take: 20,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], include: { target: { select: { code: true } } } }),
      this.db.source.findMany({ where: { enabled: true, connector: 'manual' },
        select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } }),
      this.db.extensionBinding.findMany({ where: { installationId: { not: null }, target: { enabled: true, connector: EXTENSION_CONNECTOR } },
        select: { uid: true, target: { select: { code: true, externalId: true } } } }),
    ]);
    return { sources, jobs: jobs.map(row => {
      const result = row.state === 'COMPLETE' ? ResearchReportSchema.parse(row.result) : null;
      const uid = result?.kind === 'RESEARCH_POST' ? numericOwner(result.authorUrl) : undefined;
      const ownerCode = owners.find(owner => owner.uid === uid && owner.uid === owner.target.externalId)?.target.code ?? null;
      return { id: row.id, createdAt: row.createdAt.toISOString(), targetCode: row.target.code, url: row.url, kind: row.kind as ResearchKind,
        state: row.expiresAt <= now && ['QUEUED', 'RUNNING'].includes(row.state) ? 'EXPIRED' : row.state, result, ownerCode };
    }) };
  }

  @Post()
  async enqueue(@Body() body: unknown, @Actor() actor: Principal) {
    const input = parse(z.object({ url: z.string().trim().max(500), limit: z.number().int().min(1).max(RESEARCH_LIMIT) }), body);
    const dest = researchDestination(input.url);
    if (!dest) throw new BadRequestException('Dán link trực tiếp tới bài viết, Reel, video hoặc profile Facebook.');
    return tx(this.db, async t => {
      await t.$executeRaw`SELECT pg_advisory_xact_lock(340173120)`;
      const now = this.clock.now();
      const active = { expiresAt: { gt: now }, state: { in: ['QUEUED', 'RUNNING'] } };
      const same = await t.extensionRadarScan.findFirst({ where: { ...dest, ...active, limit: input.limit },
        include: { target: { select: { code: true } } } });
      if (same) return { id: same.id, targetCode: same.target.code };
      const bindings = await t.extensionBinding.findMany({
        where: { installationId: { not: null }, target: { connector: EXTENSION_CONNECTOR, enabled: true,
          profile: { is: { workerNode: { lastHeartbeatAt: { gte: new Date(+now - EXTENSION_FRESH_MS) } } } },
        } },
        include: { target: { include: { profile: { include: { workerNode: true } } } } },
        orderBy: { target: { code: 'asc' } },
      });
      const busy = await t.extensionRadarScan.groupBy({ by: ['targetId'], where: active, _count: { _all: true } });
      const load = new Map(busy.map(row => [row.targetId, row._count._all]));
      bindings.sort((a, b) => (load.get(a.targetId) ?? 0) - (load.get(b.targetId) ?? 0));
      for (const binding of bindings) {
        const caps = binding.target.profile?.workerNode?.capabilities as { researchProtocol?: number } | null;
        if (!binding.installationId || binding.target.externalId !== binding.uid || caps?.researchProtocol !== 1
          || (load.get(binding.targetId) ?? 0) >= 5
          || await activeKillSwitch(t, { targetId: binding.targetId, connector: EXTENSION_CONNECTOR })) continue;
        const task = await t.extensionRadarScan.create({ data: { ...dest, limit: input.limit, targetId: binding.targetId,
          installationId: binding.installationId, state: 'QUEUED', createdAt: now, expiresAt: new Date(+now + 900_000) } });
        await audit(t, { entityType: 'research', entityId: task.id, action: 'research_queued', actor: actor.actor,
          at: now, data: { kind: task.kind, targetId: binding.targetId } });
        return { id: task.id, targetCode: binding.target.code };
      }
      throw new ConflictException('Cần một profile đã ghép, đang online với extension hỗ trợ Post Research và còn chỗ nhận việc.');
    });
  }

  @Post(':id/import')
  async importPost(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Actor() actor: Principal) {
    const input = parse(z.object({ sourceId: z.string().uuid(), textOnly: z.boolean().optional(), useExisting: z.boolean().optional() }), body);
    if (input.useExisting && actor.role === 'reviewer') throw new ConflictException('Cần quyền vận hành để gắn bài Facebook đã đăng.');
    return tx(this.db, async t => {
      await t.$queryRaw`SELECT id FROM sources WHERE id=${input.sourceId}::uuid FOR UPDATE`;
      const source = await t.source.findFirst({ where: { id: input.sourceId, connector: 'manual', enabled: true } });
      if (!source) throw new ConflictException('Chọn nguồn nhập tay đang bật.');
      const job = await t.extensionRadarScan.findFirst({ where: { id, kind: 'RESEARCH_POST', state: 'COMPLETE' } });
      const report = ResearchReportSchema.safeParse(job?.result);
      if (!report.success || report.data.kind !== 'RESEARCH_POST') throw new ConflictException('Cần kết quả quét bài đã hoàn tất.');
      const data = report.data;
      const caption = data.body.trim();
      const link = facebookPostLink(data.url);
      if (!link || (!input.useExisting && (!caption || data.captionPartial))) {
        throw new ConflictException('Cần lượt quét có caption đầy đủ để đưa vào kho.');
      }
      if (data.hasMedia && !input.textOnly) throw new ConflictException('Bài có ảnh hoặc video. Xác nhận chỉ lưu caption và bình luận.');
      const now = this.clock.now();
      const externalId = 'research:' + link.id;
      let post = await t.sourcePost.findUnique({ where: { sourceId_externalId: { sourceId: source.id, externalId } } });
      if (post?.archivedAt) throw new ConflictException('Bài đã ở trong thùng rác.');
      if (!post) {
        await ingestPost(t, { sourceId: source.id, connector: 'manual', baseline: false, now, actor: actor.actor, archiveOnly: true,
          post: { externalId, identityConfidence: 'HIGH', text: caption, permalink: link.url.href,
            contentType: 'TEXT', isPinned: false, isShared: false, media: [], incomplete: [], raw: { researchId: id } } });
        post = await t.sourcePost.findUniqueOrThrow({ where: { sourceId_externalId: { sourceId: source.id, externalId } } });
      }
      await t.$queryRaw`SELECT id FROM source_posts WHERE id=${post.id}::uuid FOR UPDATE`;
      let ownerCode: string | null = null;
      let ownerId: string | undefined;
      if (input.useExisting) {
        const uid = numericOwner(data.authorUrl);
        const owner = uid ? await t.targetAccount.findFirst({ where: { externalId: uid, enabled: true, connector: EXTENSION_CONNECTOR,
          extension: { is: { uid, installationId: { not: null } } } } }) : null;
        if (!owner || !post.latestRevisionId) throw new ConflictException('Lượt quét chưa xác minh được UID chủ bài đã ghép.');
        const existing = await t.publication.findFirst({ where: { targetId: owner.id,
          OR: [{ sourcePostId: post.id }, { externalPostId: link.id }] } });
        if (existing && (existing.sourcePostId !== post.id || existing.externalPostId !== link.id || !SUCCESS.includes(existing.status))) {
          throw new ConflictException('Bài Facebook này đã thuộc một bài khác trong kho.');
        }
        if (!existing) {
          const variant = await t.contentVariant.create({ data: { targetId: owner.id, sourcePostId: post.id, revisionId: post.latestRevisionId,
            contentType: 'TEXT', status: 'BASELINE', caption } });
          const publication = await t.publication.create({ data: { targetId: owner.id, sourcePostId: post.id, variantId: variant.id,
            workflow: 'STANDARD', contentType: 'TEXT', status: 'OPERATOR_CONFIRMED', externalPostId: link.id,
            permalink: link.url.href, snapshotHash: hashObject({ variantId: variant.id, postId: link.id }),
            verifiedAt: now, lastReason: 'operator_link_research' } });
          await audit(t, { entityType: 'publication', entityId: publication.id, action: 'research_post_linked', actor: actor.actor, at: now });
        }
        ownerCode = owner.code;
        ownerId = owner.id;
      }
      const stack: string[] = [];
      const seen = new Set<string>();
      const occurrences = new Map<string, number>();
      let stored = 0;
      for (const [position, comment] of data.comments.entries()) {
        const explicitParent = facebookCommentId(comment.parentExternalId);
        if ((explicitParent && !seen.has(explicitParent)) || (!explicitParent && comment.depth > stack.length)) continue;
        if (comment.depth <= stack.length) stack.length = comment.depth;
        const parentExternalId = explicitParent ?? stack.at(-1) ?? null;
        const native = facebookCommentId(comment.externalId);
        const key = hashObject({ parentExternalId, name: comment.name, text: comment.text });
        const occurrence = occurrences.get(key) ?? 0;
        occurrences.set(key, occurrence + 1);
        const externalId = native && !seen.has(native) ? native : `research:${key}:${occurrence}`;
        seen.add(externalId);
        stack.push(externalId);
        const row = { lastSeenAt: now, authorName: comment.name, text: comment.text, parentExternalId, position };
        await t.sourceComment.upsert({ where: { sourcePostId_externalId: { sourcePostId: post.id, externalId } },
          create: { sourcePostId: post.id, externalId, ...row }, update: { lastSeenAt: now } });
        stored++;
      }
      const mappings = await t.sourceTargetMapping.findMany({ where: { sourceId: source.id, enabled: true }, select: { targetId: true } });
      await prepareCommentDrafts(t, post.id, [...new Set([...mappings.map(m => m.targetId), ...(ownerId ? [ownerId] : [])])], now);
      await audit(t, { entityType: 'source_post', entityId: post.id, action: 'research_imported', actor: actor.actor,
        at: now, data: { researchId: id, comments: stored, partial: data.partial, textOnly: data.hasMedia } });
      return { postId: post.id, sourceCode: source.code, comments: stored, ownerCode };
    });
  }
}
