import { BadRequestException, Body, ConflictException, Controller, Get, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { EXTENSION_CONNECTOR, EXTENSION_FRESH_MS, INSTAGRAM_PROFILE_PROTOCOL, InstagramResearchProtocolSchema, RESEARCH_KINDS, ResearchIssueSchema, researchLimitFor, ResearchReportSchema, SUCCESS,
  type ContentType, type ResearchKind, type ResearchReport, type ResearchWorkspace } from '@seedingsys/contracts';
import { accountResource, activeKillSwitch, audit, completeInstagramContent, ingestPost, instagramBatchPlan, instagramContentType,
  instagramPostMedia, json, lockInstagramBatch, prepareCommentDrafts, releaseLease, storeInstagramBatchPost, storeInstagramComments,
  tx, type Db, type Tx } from '@seedingsys/db';
import { facebookCommentId, facebookPostLink, facebookSourceUrl, hashObject, INSTAGRAM_RESEARCH_MEDIA_CONNECTOR,
  instagramSourceLink, type Clock } from '@seedingsys/domain';
import { Roles, type Principal } from './auth';
import { batchResearch, continuousResearch, instagramThreadJobs, notifyInstagramThread, outsideInstagramThread, outsideResearchBatch, researchBatch,
  researchBatchIssue, researchBatchJobs, researchDestination, researchProgress } from './research-dispatch';
import { CLOCK, DB } from './tokens';
import { Actor, parse } from './util';
import { z } from 'zod';

const researchKinds = { in: [...RESEARCH_KINDS] };
const importInput = z.object({ sourceId: z.string().uuid(), textOnly: z.boolean().optional(), useExisting: z.boolean().optional(),
  rightsConfirmed: z.boolean().optional() });
const batchInput = z.object({ destinationUid: z.string().regex(/^\d{4,24}$/).optional(),
  readerCode: z.string().regex(/^B\d+$/).max(20).optional(), includeComments: z.literal(true).optional() });
const batchImportInput = importInput.pick({ sourceId: true, rightsConfirmed: true });

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
    const [jobs, sources, owners, targets] = await Promise.all([
      this.db.extensionRadarScan.findMany({ where: { kind: researchKinds, ...outsideResearchBatch }, take: 20,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], include: { target: { select: { code: true } } } }),
      this.db.source.findMany({ where: { enabled: true, connector: 'manual' },
        select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } }),
      this.db.extensionBinding.findMany({ where: { installationId: { not: null }, target: { connector: EXTENSION_CONNECTOR } },
        select: { uid: true, target: { select: { code: true, externalId: true, enabled: true, name: true,
          profile: { select: { workerNode: { select: { lastHeartbeatAt: true, capabilities: true } } } } } } },
        orderBy: { target: { code: 'asc' } } }),
      this.db.targetAccount.findMany({ where: { code: { startsWith: 'B' } }, select: { code: true, name: true, externalId: true },
        orderBy: { code: 'asc' } }),
    ]);
    const destinations = targets.filter(target => /^\d{4,24}$/.test(target.externalId))
      .map(({ code, name, externalId: uid }) => ({ code, name, uid }));
    const destinationsByUid = new Map(destinations.map(destination => [destination.uid, destination]));
    const profiles = owners.map(({ target }) => {
      const node = target.profile?.workerNode;
      const caps = node?.capabilities as { researchProtocol?: number; instagramResearch?: number; instagramLoggedIn?: boolean | null } | null;
      const online = Boolean(node?.lastHeartbeatAt && +now - +node.lastHeartbeatAt <= EXTENSION_FRESH_MS);
      const canResearch = target.enabled && online && caps?.researchProtocol === 1;
      const instagramPermission = InstagramResearchProtocolSchema.safeParse(caps?.instagramResearch).success;
      const instagramLoggedIn = instagramPermission && online ? caps?.instagramLoggedIn ?? null : null;
      const canReadInstagram = canResearch && instagramLoggedIn === true;
      return { code: target.code, name: target.name, enabled: target.enabled, online, canResearch, instagramPermission, instagramLoggedIn, canReadInstagram,
        canReadInstagramProfile: canReadInstagram && caps?.instagramResearch === INSTAGRAM_PROFILE_PROTOCOL };
    });
    const parents = new Map(jobs.filter(job => job.kind === 'RESEARCH_PROFILE').map(job => [job.id, job]));
    const grouped = new Map<string, NonNullable<ResearchWorkspace['jobs'][number]['batch']>>();
    if (parents.size) {
      const rows = await this.db.extensionRadarScan.findMany({ where: { AND: [batchResearch, { OR: [...parents.keys()].map(researchBatchJobs) }] },
        select: { state: true, expiresAt: true, result: true, url: true, target: { select: { code: true } } } });
      for (const row of rows) {
        const parent = researchBatch(row.result)?.batchProfileId;
        if (!parent) continue;
        const plan = instagramBatchPlan(parents.get(parent)?.result);
        const uid = plan?.batchDestinationUid;
        const counts = grouped.get(parent) ?? { total: 0, queued: 0, running: 0, complete: 0, ready: 0, failed: 0, incomplete: 0, posts: [],
          destination: uid ? destinationsByUid.get(uid) ?? { uid, code: '', name: '' } : null,
          importSourceCode: sources.find(source => source.id === plan?.batchImport?.sourceId)?.code ?? null };
        const state = row.state === 'RUNNING' && row.expiresAt <= now ? 'EXPIRED' : row.state;
        const report = state === 'COMPLETE' ? ResearchReportSchema.safeParse(row.result).data : undefined;
        counts.total++;
        if (state === 'QUEUED') counts.queued++;
        else if (state === 'RUNNING') counts.running++;
        else if (state === 'COMPLETE') {
          counts.complete++;
          if (completeInstagramContent(report)) counts.ready++;
          else counts.incomplete++;
        } else counts.failed++;
        const media = report?.kind === 'RESEARCH_POST' ? report.instagramMedia ?? [] : [];
        counts.posts.push({ url: row.url, state: state === 'COMPLETE' && !completeInstagramContent(report) ? 'PARTIAL' : state,
          readerCode: state === 'QUEUED' ? null : row.target.code, issue: researchBatchIssue(row.result),
          caption: report?.kind === 'RESEARCH_POST' ? report.body : null,
          images: media.filter(item => item.kind === 'image').length, videos: media.filter(item => item.kind === 'video').length });
        grouped.set(parent, counts);
      }
    }
    return { sources, destinations, profiles, jobs: jobs.map(row => {
      const progress = researchProgress(row.result);
      const result = row.state === 'COMPLETE' ? ResearchReportSchema.parse(row.result) : progress?.report ?? null;
      const issue = row.state === 'FAILED' ? z.object({ issue: ResearchIssueSchema }).safeParse(row.result).data?.issue ?? null : null;
      const uid = result?.kind === 'RESEARCH_POST' ? numericOwner(result.authorUrl) : undefined;
      const ownerCode = owners.find(owner => owner.target.enabled && owner.uid === uid && owner.uid === owner.target.externalId)?.target.code ?? null;
      let state = row.state;
      if (progress?.stopped) state = 'CANCELLED';
      if (['QUEUED', 'RUNNING'].includes(state)) {
        if (progress && (progress.needsProfile || !profiles.find(profile => profile.code === row.target.code)?.canReadInstagramProfile)) state = 'WAITING_PROFILE';
        else if (!progress && row.expiresAt <= now) state = 'EXPIRED';
      }
      return { id: row.id, createdAt: row.createdAt.toISOString(), targetCode: row.target.code, url: row.url, kind: row.kind as ResearchKind,
        state, result, ownerCode, issue, continuous: Boolean(progress), batch: grouped.get(row.id) };
    }) };
  }

  @Post()
  async enqueue(@Body() body: unknown, @Actor() actor: Principal) {
    const input = parse(z.object({ url: z.string().trim().max(500), limit: z.number().int().min(1),
      targetCode: z.string().regex(/^B\d+$/).max(20).optional(), saveCommentsTo: z.string().uuid().optional() }), body);
    const dest = researchDestination(input.url);
    if (!dest) throw new BadRequestException('Dán link trực tiếp tới bài viết, Reel, video hoặc profile Facebook hay Instagram.');
    const max = researchLimitFor(dest.url);
    if (input.limit > max) throw new BadRequestException(`Liên kết này cho phép tối đa ${max} mục mỗi lượt đọc.`);
    const instagramLink = instagramSourceLink(dest.url);
    const instagram = Boolean(instagramLink);
    const continuous = instagram && dest.kind === 'RESEARCH_PROFILE';
    const queued = await tx(this.db, async t => {
      await t.$executeRaw`SELECT pg_advisory_xact_lock(340173120)`;
      const now = this.clock.now();
      if (input.saveCommentsTo) {
        const stored = instagramLink?.type === 'post' && await t.sourcePost.findFirst({
          where: { id: input.saveCommentsTo, archivedAt: null, externalId: 'instagram:' + instagramLink.id },
          select: { permalink: true },
        });
        if (!stored || instagramSourceLink(stored.permalink ?? '')?.url !== dest.url) {
          throw new BadRequestException('Liên kết phải khớp bài Instagram trong Kho.');
        }
      }
      const active = { OR: [{ expiresAt: { gt: now } }, continuousResearch], state: { in: ['QUEUED', 'RUNNING'] } };
      const targetCode = input.targetCode ? { code: input.targetCode } : {};
      const same = await t.extensionRadarScan.findFirst({ where: { ...dest, ...active, limit: input.limit,
        AND: [outsideResearchBatch, input.saveCommentsTo ? instagramThreadJobs(input.saveCommentsTo) : outsideInstagramThread,
          ...(continuous ? [continuousResearch, { result: { path: ['automatic'], equals: !input.targetCode } }] : [])],
        ...(input.targetCode && { target: targetCode }) },
        include: { target: { select: { code: true } } } });
      if (same) return { id: same.id, targetCode: same.target.code, targetId: same.targetId };
      const bindings = await t.extensionBinding.findMany({
        where: { installationId: { not: null }, target: { ...targetCode, connector: EXTENSION_CONNECTOR, enabled: true,
          profile: { is: { workerNode: { lastHeartbeatAt: { gte: new Date(+now - EXTENSION_FRESH_MS) } } } },
        } },
        include: { target: { include: { profile: { include: { workerNode: true } } } } },
        orderBy: { target: { code: 'asc' } },
      });
      const busy = await t.extensionRadarScan.groupBy({ by: ['targetId'], where: { ...active, AND: [outsideResearchBatch] }, _count: { _all: true } });
      const load = new Map(busy.map(row => [row.targetId, row._count._all]));
      const protocol = (binding: typeof bindings[number]) => (binding.target.profile?.workerNode?.capabilities as { instagramResearch?: number } | null)?.instagramResearch ?? 0;
      bindings.sort((a, b) => (instagram && dest.kind === 'RESEARCH_PROFILE' ? protocol(b) - protocol(a) : 0)
        || (load.get(a.targetId) ?? 0) - (load.get(b.targetId) ?? 0));
      for (const binding of bindings) {
        const caps = binding.target.profile?.workerNode?.capabilities as {
          researchProtocol?: number; instagramLoggedIn?: boolean; instagramCommentsProtocol?: number;
        } | null;
        if (!binding.installationId || binding.target.externalId !== binding.uid || caps?.researchProtocol !== 1
          || (instagram && (!InstagramResearchProtocolSchema.safeParse(protocol(binding)).success || caps.instagramLoggedIn !== true))
          || (continuous && protocol(binding) !== INSTAGRAM_PROFILE_PROTOCOL)
          || (input.saveCommentsTo && (protocol(binding) !== INSTAGRAM_PROFILE_PROTOCOL || caps?.instagramCommentsProtocol !== 1))
          || (load.get(binding.targetId) ?? 0) >= 5
          || await activeKillSwitch(t, { targetId: binding.targetId, connector: EXTENSION_CONNECTOR })) continue;
        const task = await t.extensionRadarScan.create({ data: { ...dest, limit: input.limit, targetId: binding.targetId,
          installationId: binding.installationId, state: 'QUEUED', createdAt: now, expiresAt: new Date(+now + 900_000),
          ...(continuous && { result: json({ continuous: true, automatic: !input.targetCode }), expiresAt: now }),
          ...(input.saveCommentsTo && { result: json({ instagramThread: { postId: input.saveCommentsTo, requested: true } }) }) } });
        await audit(t, { entityType: 'research', entityId: task.id, action: 'research_queued', actor: actor.actor,
          at: now, data: { kind: task.kind, targetId: binding.targetId } });
        return { id: task.id, targetCode: binding.target.code, targetId: binding.targetId };
      }
      if (input.saveCommentsTo) throw new ConflictException('Cần Chrome profile online, đã đăng nhập Instagram và dùng SeedingSys 1.2.15 trở lên.');
      if (input.targetCode) throw new ConflictException(instagram
        ? `${input.targetCode} cần được bật, online, đã đăng nhập Instagram và có extension phù hợp.`
        : `${input.targetCode} cần được bật, online và còn chỗ nhận lượt đọc.`);
      throw new ConflictException(instagram
        ? 'Cần một Chrome profile đang online, đã đăng nhập Instagram và có extension phù hợp. Kiểm tra ở nút Tài khoản Instagram.'
        : 'Cần một profile đã ghép, đang online với extension hỗ trợ Post Research và còn chỗ nhận việc.');
    });
    if (input.saveCommentsTo) notifyInstagramThread(queued.targetId);
    return { id: queued.id, targetCode: queued.targetCode };
  }

  @Post(':id/read-posts')
  async readPosts(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Actor() actor: Principal) {
    const input = parse(batchInput, body ?? {});
    return tx(this.db, async t => {
      await lockInstagramBatch(t, id);
      const parent = await t.extensionRadarScan.findFirst({ where: { id, kind: 'RESEARCH_PROFILE', state: 'COMPLETE' } });
      const report = ResearchReportSchema.safeParse(parent?.result).data;
      if (!parent || report?.kind !== 'RESEARCH_PROFILE' || instagramSourceLink(report.url)?.type !== 'profile') {
        throw new ConflictException('Cần một danh sách bài Instagram đã đọc xong.');
      }
      if (input.destinationUid) {
        const matches = await t.targetAccount.findMany({ where: { externalId: input.destinationUid, code: { startsWith: 'B' } },
          select: { id: true }, take: 2 });
        if (matches.length !== 1) throw new ConflictException('UID đích phải khớp đúng một tài khoản Facebook trong danh bạ B.');
        await t.extensionRadarScan.update({ where: { id }, data: { result: json({
          ...(parent.result && typeof parent.result === 'object' && !Array.isArray(parent.result) ? parent.result : {}),
          ...report, ...instagramBatchPlan(parent.result), batchDestinationUid: input.destinationUid,
        }) } });
      }
      const links = new Map<string, string>();
      for (const row of report.rows) {
        const link = instagramSourceLink(row.url);
        if (link?.type === 'post') links.set(link.id, link.url);
      }
      if (!links.size) throw new ConflictException('Danh sách này chưa có link bài Instagram.');
      const now = this.clock.now();
      const reader = input.readerCode ? await t.extensionBinding.findFirst({ where: { installationId: { not: null },
        target: { code: input.readerCode, enabled: true, connector: EXTENSION_CONNECTOR,
          profile: { is: { workerNode: { lastHeartbeatAt: { gte: new Date(+now - EXTENSION_FRESH_MS) } } } },
        },
      }, include: { target: { include: { profile: { include: { workerNode: true } } } } } }) : null;
      if (input.readerCode) {
        const capability = reader?.target.profile?.workerNode?.capabilities as Record<string, unknown> | undefined;
        if (!reader || reader.target.externalId !== reader.uid || capability?.researchProtocol !== 1
          || capability?.instagramResearch !== INSTAGRAM_PROFILE_PROTOCOL || capability?.instagramLoggedIn !== true
          || (input.includeComments && capability.instagramCommentsProtocol !== 1)) {
          throw new ConflictException(`${input.readerCode} cần online với đúng UID và đã đăng nhập Instagram.`);
        }
      }
      if (input.includeComments && !reader) throw new ConflictException('Chọn Chrome profile hỗ trợ đọc bình luận cho cả lô.');
      const existing = await t.extensionRadarScan.findMany({ where: { ...researchBatchJobs(id), kind: 'RESEARCH_POST' },
        select: { id: true, url: true, state: true, expiresAt: true, result: true, targetId: true } });
      const known = new Set(existing.map(row => row.url));
      const rememberedReaderId = existing.map(row => researchBatch(row.result)).find(batch => batch?.readerTargetId)?.readerTargetId;
      const assignedReader = reader ?? (rememberedReaderId ? await t.extensionBinding.findUnique({
        where: { targetId: rememberedReaderId }, select: { targetId: true, installationId: true },
      }) : null);
      const readerTargetId = reader?.targetId ?? rememberedReaderId;
      const marker = { batch: true, batchProfileId: id, ...(readerTargetId && { readerTargetId }),
        ...((input.includeComments || existing.some(row => researchBatch(row.result)?.includeComments)) && { includeComments: true }) };
      const result = json(marker);
      const route = { targetId: assignedReader?.targetId ?? parent.targetId, installationId: assignedReader?.installationId ?? parent.installationId };
      await t.extensionRadarScan.createMany({ data: [...links.values()].filter(url => !known.has(url)).map(url => ({
        url, kind: 'RESEARCH_POST', limit: 10, ...route,
        state: 'QUEUED', createdAt: now, expiresAt: now, result,
      })) });
      if (reader) for (const row of existing) {
        const phase = researchBatch(row.result);
        const tagged = { ...phase, ...marker };
        if (row.state === 'QUEUED') {
          await t.extensionRadarScan.updateMany({ where: { id: row.id, state: 'QUEUED' }, data: { ...route, result: json(tagged) } });
        } else if (input.includeComments && row.state === 'RUNNING' && row.targetId === reader.targetId) {
          await t.extensionRadarScan.updateMany({ where: { id: row.id, state: 'RUNNING' }, data: { result: json(tagged) } });
        } else if (input.includeComments && row.state === 'COMPLETE' && !phase?.commentsChecked) {
          const prior = ResearchReportSchema.safeParse(row.result).data;
          if (prior?.kind === 'RESEARCH_POST' && (!prior.instagramCommentStatus || prior.instagramCommentStatus === 'UNAVAILABLE')) {
            await t.extensionRadarScan.updateMany({ where: { id: row.id, state: 'COMPLETE' }, data: { ...route, state: 'QUEUED',
              leaseToken: null, expiresAt: now, result: json({ ...tagged, commentProbe: prior, postStartedAtMs: +row.expiresAt - 150_000 }),
            } });
          }
        }
      }
      const retry = input.includeComments ? [] : existing.filter(row => row.state === 'FAILED' || (row.state === 'RUNNING' && row.expiresAt <= now)
        || (row.state === 'COMPLETE' && !completeInstagramContent(ResearchReportSchema.safeParse(row.result).data)));
      if (retry.length) await t.extensionRadarScan.updateMany({ where: { id: { in: retry.map(row => row.id) },
        OR: [{ state: { in: ['FAILED', 'COMPLETE'] } }, { state: 'RUNNING', expiresAt: { lte: now } }] },
        data: { state: 'QUEUED', leaseToken: null, expiresAt: now, ...route, result } });
      await audit(t, { entityType: 'research', entityId: id, action: 'instagram_batch_queued', actor: actor.actor,
        at: now, data: { total: links.size, added: links.size - known.size, retried: retry.length,
          ...(input.destinationUid && { destinationUid: input.destinationUid }), ...(input.readerCode && { readerCode: input.readerCode }),
          ...(input.includeComments && { includeComments: true }) } });
      return { total: links.size };
    });
  }

  @Post(':id/stop')
  async stop(@Param('id', ParseUUIDPipe) id: string, @Actor() actor: Principal) {
    return tx(this.db, async t => {
      const scan = await t.extensionRadarScan.findUnique({ where: { id }, select: { targetId: true } });
      if (!scan) throw new ConflictException('Không tìm thấy lượt đọc.');
      await t.$queryRaw`SELECT id FROM target_accounts WHERE id = ${scan.targetId}::uuid FOR UPDATE`;
      const current = await t.extensionRadarScan.findUniqueOrThrow({ where: { id } });
      if (current.targetId !== scan.targetId) throw new ConflictException('Lượt đọc vừa được giao lại. Bấm Dừng lượt đọc một lần nữa.');
      const progress = researchProgress(current.result);
      if (!progress || !['QUEUED', 'RUNNING'].includes(current.state)) throw new ConflictException('Lượt đọc này đã dừng.');
      const now = this.clock.now();
      if (current.leaseToken !== null) await releaseLease(t, { resource: accountResource(current.targetId),
        holder: 'research:' + id, token: current.leaseToken, expiresAt: current.expiresAt }, now);
      await t.extensionRadarScan.update({ where: { id }, data: { state: 'FAILED', leaseToken: null, result: json({ ...progress, stopped: true }) } });
      await audit(t, { entityType: 'research', entityId: id, action: 'research_stopped', actor: actor.actor, at: now });
      return { ok: true };
    });
  }

  @Post(':id/import-posts')
  async importPosts(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Actor() actor: Principal) {
    const input = parse(batchImportInput, body);
    if (!input.rightsConfirmed) throw new ConflictException('Xác nhận quyền sử dụng lại nội dung Instagram trước khi lưu lô.');
    return tx(this.db, async t => {
      await lockInstagramBatch(t, id);
      await t.$queryRaw`SELECT id FROM sources WHERE id=${input.sourceId}::uuid FOR UPDATE`;
      const source = await t.source.findFirst({ where: { id: input.sourceId, connector: 'manual', enabled: true } });
      if (!source) throw new ConflictException('Chọn nguồn nhập tay đang bật.');
      const parent = await t.extensionRadarScan.findFirst({ where: { id, kind: 'RESEARCH_PROFILE', state: 'COMPLETE' } });
      const parentReport = ResearchReportSchema.safeParse(parent?.result).data;
      const destinationUid = instagramBatchPlan(parent?.result)?.batchDestinationUid;
      if (parentReport?.kind !== 'RESEARCH_PROFILE' || instagramSourceLink(parentReport.url)?.type !== 'profile' || !destinationUid) {
        throw new ConflictException('Chọn và lưu tài khoản Facebook đích của lô trước.');
      }
      await t.extensionRadarScan.update({ where: { id }, data: { result: json({
        ...(parent?.result && typeof parent.result === 'object' && !Array.isArray(parent.result) ? parent.result : {}),
        ...parentReport, batchDestinationUid: destinationUid, batchImport: { sourceId: source.id, actor: actor.actor },
      }) } });
      const jobs = await t.extensionRadarScan.findMany({ where: { AND: [batchResearch, researchBatchJobs(id)], kind: 'RESEARCH_POST', state: 'COMPLETE' },
        select: { id: true, result: true } });
      let saved = 0;
      const skipped: string[] = [];
      const now = this.clock.now();
      for (const job of jobs) {
        const data = ResearchReportSchema.safeParse(job.result).data;
        if (!completeInstagramContent(data)) continue;
        const stored = await storeInstagramBatchPost(t, data, {
          batchId: id, researchId: job.id, sourceId: source.id, destinationUid, actor: actor.actor, now,
        });
        if (stored) saved++;
        else skipped.push(data.url);
      }
      return { saved, skipped, sourceCode: source.code };
    }, 45_000);
  }

  @Post(':id/import')
  async importPost(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Actor() actor: Principal) {
    const input = parse(importInput, body);
    if (input.useExisting && actor.role === 'reviewer') throw new ConflictException('Cần quyền vận hành để gắn bài Facebook đã đăng.');
    return tx(this.db, async t => {
      await t.$queryRaw`SELECT id FROM sources WHERE id=${input.sourceId}::uuid FOR UPDATE`;
      const source = await t.source.findFirst({ where: { id: input.sourceId, connector: 'manual', enabled: true } });
      if (!source) throw new ConflictException('Chọn nguồn nhập tay đang bật.');
      const job = await t.extensionRadarScan.findFirst({ where: { id, kind: 'RESEARCH_POST', state: 'COMPLETE' } });
      const report = ResearchReportSchema.safeParse(job?.result);
      if (!report.success || report.data.kind !== 'RESEARCH_POST') throw new ConflictException('Cần kết quả quét bài đã hoàn tất.');
      const data = report.data;
      const instagram = instagramSourceLink(data.url);
      if (instagram?.type === 'post') {
        return this.importInstagram(t, input, data, instagram, { jobId: id, sourceCode: source.code, actor: actor.actor });
      }
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

  private async importInstagram(t: Tx, input: z.infer<typeof importInput>, data: Extract<ResearchReport, { kind: 'RESEARCH_POST' }>,
    link: Extract<NonNullable<ReturnType<typeof instagramSourceLink>>, { type: 'post' }>,
    context: { jobId: string; sourceCode: string; actor: string }) {
    if (input.useExisting) throw new ConflictException('Bài Instagram cần được đưa vào luồng dưới dạng bài mới.');
    if (!input.rightsConfirmed) throw new ConflictException('Xác nhận quyền sử dụng lại nội dung Instagram trước khi lưu.');
    const caption = data.body;
    const media = input.textOnly ? [] : instagramPostMedia(data, link);
    if (!input.textOnly && (data.mediaPartial || !media.length || media.length !== data.instagramMedia?.length)) {
      throw new ConflictException('Chưa đọc đủ ảnh hoặc video Instagram để chuẩn bị bài Facebook.');
    }
    const videos = media.filter(item => item.kind === 'video').length;
    if (videos && (videos > 1 || media.length > 1)) {
      throw new ConflictException('Dạng album này chứa video. Facebook cần một video riêng hoặc một album toàn ảnh.');
    }
    if (data.captionPartial || (!caption.trim() && !media.length)) {
      throw new ConflictException('Cần caption đầy đủ hoặc tệp media hợp lệ để lưu bài.');
    }
    const contentType = instagramContentType(media.length, Boolean(videos), link.kind === 'reel');
    const externalId = 'instagram:' + link.id;
    const where = { sourceId_externalId: { sourceId: input.sourceId, externalId } };
    const prior = await t.sourcePost.findUnique({ where });
    if (prior?.archivedAt) throw new ConflictException('Bài này đã nằm trong thùng rác của nguồn đã chọn.');
    if (prior && prior.contentType !== contentType) throw new ConflictException('Kho đã lưu bài này dưới định dạng khác.');
    const now = this.clock.now();
    if (!prior) {
      await ingestPost(t, { sourceId: input.sourceId, connector: INSTAGRAM_RESEARCH_MEDIA_CONNECTOR, baseline: false,
        now, actor: context.actor,
        post: { externalId, identityConfidence: 'HIGH', permalink: link.url, text: caption, contentType, media,
          incomplete: [], isPinned: false, isShared: false,
          raw: { platform: 'instagram', researchId: context.jobId, rightsConfirmed: true, instagramCommentStatus: data.instagramCommentStatus } } });
      await audit(t, { entityType: 'research', entityId: context.jobId, action: 'instagram_imported', actor: context.actor,
        at: now, data: { contentType, mediaCount: media.length, sourceId: input.sourceId } });
    }
    const post = prior ?? await t.sourcePost.findUniqueOrThrow({ where });
    const comments = await storeInstagramComments(t, post.id, data, now);
    return { postId: post.id, sourceCode: context.sourceCode, ownerCode: null, comments, contentType };
  }
}
