import { BadRequestException, Body, ConflictException, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res, StreamableFile } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { FB_CAPABILITY_MIN_CASES, Q, SUCCESS } from '@seedingsys/contracts';
import { audit, BacklogDispatchError, dispatchBacklogItem, editBacklogCaption, enqueue, freezeSnapshot, listBacklog, movePublication, moveVariant, setControl, SnapshotBlockedError, tx, type Db } from '@seedingsys/db';
import { facebookPostId, facebookPostLink, facebookUrl, removeAdvertisingLinks, vnDay, type Clock } from '@seedingsys/domain';
import { Roles, type Principal } from './auth';
import type { ObjectStore } from '@seedingsys/storage';
import { CLOCK, DB, STORE } from './tokens';
import { Actor, out, parse } from './util';

const DISPATCH_MESSAGES: Record<string, string> = {
  ACCOUNT_BUSY: 'Tài khoản đích đang xử lý một bài. Thử lại khi lượt đó hoàn tất.',
  UNRESOLVED_PUBLICATION: 'Tài khoản đích còn bài chưa rõ kết quả. Xử lý lượt đó trước.',
  NO_WORKER: 'Tài khoản đích chưa có worker đang hoạt động.',
  NO_CONNECTOR_RELEASE: 'Cách đăng của tài khoản đích chưa có phiên bản hoạt động.',
  TARGET_DISABLED: 'Tài khoản đích đang tắt.',
  AUDIENCE_CONFIG_CHANGED: 'Quyền xem đã duyệt khác cài đặt hiện tại. Xác nhận quyền xem mới trước khi đăng.',
  MAPPING_DISABLED: 'Luồng từ nguồn đến tài khoản đích đang tắt.',
  STRICT_ORDER_WAIT: 'Luồng đang bật giữ thứ tự và còn bài cũ hơn cần xử lý.',
  ITEM_EXPIRED: 'Bài đã hết hiệu lực.',
  SOURCE_REVISION_CHANGED: 'Bài nguồn đã có bản mới. Mở Kho bài để chuẩn bị lại bản đăng.',
  ITEM_UNAVAILABLE: 'Bài này không còn sẵn sàng. Tải lại Backlog để kiểm tra.',
  MEDIA_INCOMPLETE: 'Bài chưa lưu đủ ảnh hoặc video.',
  NATIVE_SHARE_REQUIRED: 'Mở bài gốc để chia sẻ trực tiếp trên Facebook.',
  FORMAT_NOT_CERTIFIED: 'Định dạng này chưa được chứng nhận cho tài khoản đích.',
  FORMAT_UNSUPPORTED: 'Kết nối của tài khoản đích chưa hỗ trợ định dạng này.',
  RETRY_LIMIT_REACHED: 'Bài đã hết số lần thử đăng trong cấu hình luồng.',
  DUPLICATE_CONTENT: 'Tài khoản đích đã đăng hoặc đang chờ đăng nội dung này từ một bài nguồn khác.',
};

export function dispatchMessage(reason: string): string {
  if (reason.startsWith('KILL_SWITCH_')) return 'Đang bị tạm dừng bởi công tắc dừng.';
  return DISPATCH_MESSAGES[reason] ?? 'Lượt đăng vừa thay đổi. Tải lại Backlog và thử lại.';
}

@Controller()
export class OpsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(STORE) private readonly store: ObjectStore,
  ) {}

  @Get('health')
  async health() {
    await this.db.$queryRaw`SELECT 1`;
    return { ok: true, at: this.clock.now().toISOString() };
  }

  @Get('me')
  me(@Actor() a: Principal) {
    return { role: a.role, actor: a.actor };
  }

  /** Media bytes for the review screen (read-only, from managed storage). */
  @Get('assets/:id/content')
  async asset(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const a = await this.db.asset.findUnique({ where: { id } });
    if (!a?.objectKey || a.status !== 'STORED') throw new NotFoundException();
    res.set({ 'Content-Type': a.mime ?? 'application/octet-stream', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
    const size = Number(a.bytes);
    let selected: { start: number; end: number } | undefined;
    if (Number.isSafeInteger(size) && size > 0) {
      res.set('Accept-Ranges', 'bytes');
      if (req.headers.range) {
        const ranges = req.range(size);
        if (!Array.isArray(ranges) || ranges.type !== 'bytes' || ranges.length !== 1) {
          res.status(416).set('Content-Range', 'bytes */' + size);
          return;
        }
        selected = ranges[0];
        res.status(206).set('Content-Range', 'bytes ' + selected.start + '-' + selected.end + '/' + size)
          .set('Content-Length', String(selected.end - selected.start + 1));
      } else res.set('Content-Length', String(size));
    }
    return new StreamableFile(await this.store.open(a.objectKey, selected));
  }

  /** Which formats passed their capability test, per target and connector version. */
  @Get('capabilities')
  async capabilities() {
    const [checks, releases] = await Promise.all([
      this.db.capabilityCheck.findMany({ orderBy: [{ target: { code: 'asc' } }, { contentType: 'asc' }], include: { target: { select: { code: true } } } }),
      this.db.connectorRelease.findMany({ orderBy: { releasedAt: 'desc' } }),
    ]);
    return out({ checks: checks.map(check => ({ ...check,
      qualified: check.passed && (check.connector !== 'fb-web' || check.cases >= FB_CAPABILITY_MIN_CASES),
    })), releases });
  }

  @Get('slots')
  async slots(@Query('hours') hours = '24') {
    const now = this.clock.now();
    return out(
      await this.db.publicationSlot.findMany({
        where: { slotAt: { gte: new Date(now.getTime() - Number(hours) * 3600_000) } },
        orderBy: [{ slotAt: 'desc' }, { target: { code: 'asc' } }],
        take: 500,
        include: { target: { select: { code: true } } },
      }),
    );
  }

  /** Content waiting to be posted, per target (oldest first = the order it will go out). */
  @Get('backlog')
  async backlog() {
    const rows = await listBacklog(this.db, this.clock.now());
    return out(rows.map(row => ({ ...row, blockedText: row.blockReason ? dispatchMessage(row.blockReason) : null })));
  }

  @Patch('backlog/:id')
  @Roles('reviewer')
  async updateBacklogCaption(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Actor() a: Principal) {
    const data = parse(z.object({ caption: z.string().trim().max(5000), snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
      audience: z.enum(['ONLY_ME', 'FRIENDS', 'PUBLIC']).optional() }), body);
    const updated = await tx(this.db, t => editBacklogCaption(t, { ...data, variantId: id, actor: a.actor, now: this.clock.now() }));
    if (!updated) throw new ConflictException('Bài đã thay đổi, hết hiệu lực hoặc đã được gửi đăng. Tải lại Backlog để kiểm tra.');
    return { ok: true };
  }

  @Post('backlog/:id/publish')
  @Roles('operator')
  async publishBacklogItem(@Param('id', ParseUUIDPipe) id: string, @Actor() a: Principal) {
    try {
      const publicationId = await dispatchBacklogItem({ db: this.db, clock: this.clock, actor: a.actor }, id);
      return { publicationId };
    } catch (error) {
      if (!(error instanceof BacklogDispatchError)) throw error;
      throw new ConflictException(dispatchMessage(error.reason));
    }
  }

  // ───────────── dashboard (spec §17) ─────────────
  @Get('dashboard')
  async dashboard() {
    const now = this.clock.now();
    const sources = await this.db.source.findMany({ orderBy: { code: 'asc' } });
    const targets = await this.db.targetAccount.findMany({ orderBy: { code: 'asc' } });
    const paused = await this.db.control.findMany({ where: { paused: true } });
    // Backlog = READY, still valid, and not published / in flight for that target.
    const ready = await this.db.$queryRaw<Array<{ target_id: string; n: number; oldest: Date | null }>>`
      SELECT v.target_id, count(*)::int AS n, min(v.ready_at) AS oldest
      FROM content_variants v
      JOIN source_posts sp ON sp.id = v.source_post_id AND sp.archived_at IS NULL
      LEFT JOIN publications p ON p.target_id = v.target_id AND p.source_post_id = v.source_post_id
      WHERE v.status = 'READY' AND (v.expires_at IS NULL OR v.expires_at > ${now})
        AND (p.id IS NULL OR p.status IN ('FAILED_CONFIRMED','CANCELLED'))
      GROUP BY v.target_id`;
    const since = new Date(now.getTime() - 24 * 3600_000);
    const slots = await this.db.publicationSlot.groupBy({ by: ['status'], where: { slotAt: { gte: since } }, _count: true });
    const pubs = await this.db.publication.groupBy({ by: ['contentType', 'status'], where: { updatedAt: { gte: since } }, _count: true });
    const tasks = await this.db.operatorTask.groupBy({ by: ['kind'], where: { status: { in: ['OPEN', 'CLAIMED'] } }, _count: true });
    const llm = await this.db.llmUsage.aggregate({ where: { day: vnDay(now) }, _sum: { costMicroUsd: true, inputTokens: true, outputTokens: true } });
    const workers = await this.db.workerNode.findMany({ orderBy: { name: 'asc' } });

    const byFormat: Record<string, { verified: number; operatorConfirmed: number; failed: number; unknown: number; total: number }> = {};
    for (const p of pubs) {
      const f = (byFormat[p.contentType] ??= { verified: 0, operatorConfirmed: 0, failed: 0, unknown: 0, total: 0 });
      f.total += p._count;
      if (p.status === 'PUBLISHED_VERIFIED') f.verified += p._count;
      else if (p.status === 'OPERATOR_CONFIRMED') f.operatorConfirmed += p._count;
      else if (p.status === 'FAILED_CONFIRMED') f.failed += p._count;
      else if (['UNKNOWN', 'RECONCILING', 'NEEDS_OPERATOR'].includes(p.status)) f.unknown += p._count; // never counted as success
    }
    return out({
      at: now,
      sources: sources.map((s) => ({
        code: s.code,
        enabled: s.enabled,
        lastSuccessAt: s.lastSuccessAt,
        lagSec: s.lastSuccessAt ? Math.round((now.getTime() - s.lastSuccessAt.getTime()) / 1000) : null,
        stale: !s.lastSuccessAt || now.getTime() - s.lastSuccessAt.getTime() > 10 * 60_000,
        lastError: s.lastError,
        lastErrorAt: s.lastErrorAt,
        incomplete: s.lastIncomplete,
        paused: paused.some((c) => c.scope === 'SOURCE' && c.scopeKey === s.id),
      })),
      targets: targets.map((t) => {
        const r = ready.find((x) => x.target_id === t.id);
        return {
          code: t.code,
          enabled: t.enabled,
          audience: t.audience,
          ready: r?.n ?? 0,
          oldestReadyAgeMin: r?.oldest ? Math.round((now.getTime() - r.oldest.getTime()) / 60_000) : null,
          paused: paused.find((c) => c.scope === 'TARGET' && c.scopeKey === t.id)?.reason ?? null,
        };
      }),
      slots24h: Object.fromEntries(slots.map((s) => [s.status, s._count])),
      publications24hByFormat: byFormat,
      openTasks: Object.fromEntries(tasks.map((t) => [t.kind, t._count])),
      llmToday: { usd: Number(llm._sum.costMicroUsd ?? 0n) / 1e6, inputTokens: llm._sum.inputTokens ?? 0, outputTokens: llm._sum.outputTokens ?? 0 },
      killSwitches: paused,
      workers: workers.map((w) => ({ name: w.name, kind: w.kind, lastHeartbeatAt: w.lastHeartbeatAt })),
    });
  }

  // ───────────── review ─────────────
  @Get('review')
  async reviewQueue() {
    return out(
      await this.db.contentVariant.findMany({
        where: { status: 'NEEDS_REVIEW', revision: { post: { archivedAt: null } }, publications: { none: { status: { in: [...SUCCESS] } } } },
        orderBy: { createdAt: 'asc' },
        include: {
          target: { select: { code: true } },
          revision: { select: { text: true, albumTitle: true, incomplete: true, mediaStatus: true, raw: true, post: { select: { permalink: true, contentType: true, isShared: true, identityConfidence: true, latestRevisionId: true, source: { select: { code: true, connector: true } } } }, assets: { orderBy: { position: 'asc' }, select: { position: true, asset: { select: { id: true, kind: true, status: true, mime: true } } } } } },
          checks: { where: { kind: { not: 'not_verbatim' } }, orderBy: { createdAt: 'desc' }, take: 8 },
        },
      }).then(items => items.filter(item => item.revisionId === item.revision.post.latestRevisionId).map(({ revision: { raw, ...revision }, ...item }) => {
        const share = facebookUrl((raw as { sharedPermalink?: unknown } | null)?.sharedPermalink);
        return { ...item, revision: { ...revision, post: { ...revision.post, permalink: facebookUrl(revision.post.permalink)?.href ?? null }, sharedPermalink: share?.href ?? null } };
      })),
    );
  }

  @Patch('review/:id/caption')
  @Roles('reviewer')
  async saveReviewCaption(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Actor() a: Principal) {
    const data = parse(z.object({ caption: z.string().trim().max(5000) }), body);
    const caption = removeAdvertisingLinks(data.caption);
    if (!caption && data.caption) throw new BadRequestException('Caption chỉ có liên kết quảng cáo.');
    const now = this.clock.now();
    const ok = await tx(this.db, async t => {
      const saved = await t.contentVariant.updateMany({
        where: { id, status: 'NEEDS_REVIEW', ...(caption ? {} : { contentType: 'REEL' }),
          revision: { post: { archivedAt: null } }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        data: { caption },
      });
      if (saved.count) await audit(t, { entityType: 'variant', entityId: id, action: 'caption_edited', actor: a.actor, at: now });
      return !!saved.count;
    });
    if (!ok) throw new ConflictException('Bài đã đổi trạng thái hoặc hết hiệu lực.');
    return { ok: true };
  }

  @Post('review/:id/approve')
  @Roles('reviewer')
  async approve(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Actor() a: Principal) {
    const { caption } = parse(z.object({ caption: z.string().trim().max(5000).optional() }), body ?? {});
    const now = this.clock.now();
    const ok = await tx(this.db, async (t) => {
      let done: boolean;
      try {
        done = await freezeSnapshot(t, { variantId: id, from: 'NEEDS_REVIEW', now, actor: a.actor, caption, reviewedBy: a.actor });
      } catch (e) {
        if (!(e instanceof SnapshotBlockedError)) throw e;
        throw new ConflictException(e.message);
      }
      if (done) await this.closeTasks(t, { variantId: id, kind: 'REVIEW_CONTENT' }, a.actor, { approved: true, edited: !!caption });
      return done;
    });
    if (!ok) throw new ConflictException('Bài đã thay đổi, hết hiệu lực hoặc không còn chờ duyệt.');
    return { ok: true };
  }

  @Post('review/:id/reject')
  @Roles('reviewer')
  async reject(@Param('id') id: string, @Body() body: unknown, @Actor() a: Principal) {
    const { reason } = parse(z.object({ reason: z.string().min(1) }), body ?? {});
    const now = this.clock.now();
    const ok = await tx(this.db, async (t) => {
      const done = await moveVariant(t, { id, from: 'NEEDS_REVIEW', to: 'REJECTED', actor: a.actor, now, reason });
      if (done) await this.closeTasks(t, { variantId: id, kind: 'REVIEW_CONTENT' }, a.actor, { rejected: reason });
      return done;
    });
    if (!ok) throw new ConflictException('variant is not waiting for review');
    return { ok: true };
  }

  @Post('review/:id/rewrite')
  @Roles('reviewer')
  async rewrite(@Param('id') id: string, @Actor() a: Principal) {
    const now = this.clock.now();
    const ok = await tx(this.db, async (t) => {
      const done = await moveVariant(t, { id, from: 'NEEDS_REVIEW', to: 'REWRITING', actor: a.actor, now, reason: 'manual rewrite', data: { rewriteTries: 0, reviewReasons: [] } });
      if (done) {
        await enqueue(t, Q.ContentRewrite, { variantId: id, useAi: true });
        await this.closeTasks(t, { variantId: id, kind: 'REVIEW_CONTENT' }, a.actor, { rewrite: true });
      }
      return done;
    });
    if (!ok) throw new ConflictException('variant is not waiting for review');
    return { ok: true };
  }

  // ───────────── publications ─────────────
  @Get('publications')
  async publications(@Query('status') status?: string, @Query('target') target?: string) {
    return out(
      await this.db.publication.findMany({
        where: { ...(status ? { status: status as never } : {}), ...(target ? { target: { code: target } } : {}) },
        orderBy: { updatedAt: 'desc' },
        take: 200,
        include: { target: { select: { code: true } } },
      }),
    );
  }

  @Get('publications/:id')
  async publication(@Param('id') id: string) {
    const p = await this.db.publication.findUnique({ where: { id }, include: { attempts: { orderBy: { attemptNo: 'asc' } }, target: true, variant: true } });
    if (!p) throw new NotFoundException();
    const history = await this.db.auditEvent.findMany({ where: { entityType: 'publication', entityId: id }, orderBy: { id: 'asc' } });
    return out({ ...p, history });
  }

  /** Operator checked the platform and found the post: record the permalink. */
  @Post('publications/:id/confirm')
  @Roles('operator')
  async confirm(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Actor() a: Principal) {
    const input = parse(z.object({ permalink: z.string().trim().url().max(2000) }), body ?? {});
    const url = new URL(input.permalink);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new BadRequestException('Liên kết bài đăng không hợp lệ.');
    const now = this.clock.now();
    const ok = await tx(this.db, async (t) => {
      const pub = await t.publication.findUnique({ where: { id }, include: { post: true, target: { select: { connector: true } } } });
      if (!pub || pub.status !== 'NEEDS_OPERATOR') return false;
      await t.$queryRaw`SELECT id FROM target_accounts WHERE id=${pub.targetId}::uuid FOR UPDATE`;
      let externalPostId: string | undefined;
      let permalink = url.href;
      if (pub.target.connector === 'fb-web' || pub.target.connector === 'fb-extension') {
        const link = facebookPostLink(permalink);
        if (!link) throw new BadRequestException('Dán liên kết trực tiếp tới bài đã đăng trên profile đích.');
        const externalId = link.id;
        const sourceLink = facebookUrl(pub.post.permalink);
        if (externalId === pub.post.externalId || (sourceLink && facebookPostId(sourceLink) === externalId)
          || await t.sourcePostAlias.findFirst({ where: { sourcePostId: pub.sourcePostId, externalId }, select: { externalId: true } })) {
          throw new BadRequestException('Dán liên kết của bài đích.');
        }
        externalPostId = externalId;
        permalink = link.url.href;
      }
      if (await t.publication.findFirst({ where: { targetId: pub.targetId, id: { not: id },
        OR: [{ permalink }, ...(externalPostId ? [{ externalPostId }] : [])] }, select: { id: true } })) {
        throw new ConflictException('Liên kết này đã được ghi nhận cho một bài khác.');
      }
      const done = await movePublication(t, { id, from: 'NEEDS_OPERATOR', to: 'OPERATOR_CONFIRMED', actor: a.actor, now,
        data: { permalink, externalPostId, verifiedAt: now }, reason: 'operator found post' });
      if (done) await this.closeTasks(t, { publicationId: id, kind: 'CONFIRM_RESULT' }, a.actor, { permalink });
      return done;
    });
    if (!ok) throw new ConflictException('publication is not waiting for an operator');
    return { ok: true };
  }

  /** Operator checked the platform and is certain there is no post: content may be scheduled again. */
  @Post('publications/:id/confirm-absent')
  @Roles('operator')
  async confirmAbsent(@Param('id') id: string, @Body() body: unknown, @Actor() a: Principal) {
    const { note } = parse(z.object({ note: z.string().min(3) }), body ?? {});
    const now = this.clock.now();
    const ok = await tx(this.db, async (t) => {
      const done = await movePublication(t, { id, from: 'NEEDS_OPERATOR', to: 'FAILED_CONFIRMED', actor: a.actor, now, reason: `operator: ${note}` });
      if (done) await this.closeTasks(t, { publicationId: id, kind: 'CONFIRM_RESULT' }, a.actor, { absent: note });
      return done;
    });
    if (!ok) throw new ConflictException('publication is not waiting for an operator');
    return { ok: true };
  }

  // ───────────── operator tasks ─────────────
  @Get('operator-tasks')
  async tasks(@Query('status') status = 'OPEN') {
    return out(await this.db.operatorTask.findMany({ where: { status: status as never }, orderBy: { createdAt: 'asc' } }));
  }

  @Post('operator-tasks/:id/claim')
  @Roles('operator', 'reviewer')
  async claim(@Param('id') id: string, @Actor() a: Principal) {
    const r = await this.db.operatorTask.updateMany({ where: { id, status: 'OPEN' }, data: { status: 'CLAIMED', claimedBy: a.actor } });
    if (!r.count) throw new ConflictException('task is not open');
    return { ok: true };
  }

  /**
   * Close an account takeover. The account is resumed; the very next publish re-checks session and
   * identity before doing anything, and pauses it again if the problem persists.
   */
  @Post('operator-tasks/:id/resolve')
  @Roles('operator')
  async resolve(@Param('id') id: string, @Body() body: unknown, @Actor() a: Principal) {
    const { note, resumeAccount } = parse(z.object({ note: z.string().min(3), resumeAccount: z.boolean().default(true) }), body ?? {});
    const task = await this.db.operatorTask.findUnique({ where: { id } });
    if (!task || !['OPEN', 'CLAIMED'].includes(task.status)) throw new ConflictException('task is not open');
    if (task.kind !== 'TAKEOVER_ACCOUNT') throw new BadRequestException('use the review / publication endpoints for this task kind');
    const now = this.clock.now();
    await tx(this.db, async (t) => {
      await t.operatorTask.update({ where: { id }, data: { status: 'DONE', resolvedBy: a.actor, resolution: { note, resumeAccount }, closedAt: now } });
      if (resumeAccount && task.targetId) await setControl(t, 'TARGET', task.targetId, false, a.actor, `resumed: ${note}`);
      await audit(t, { entityType: 'operator_task', entityId: id, action: 'resolved', actor: a.actor, data: { note, resumeAccount }, at: now });
    });
    return { ok: true };
  }

  // ───────────── kill switches ─────────────
  @Get('controls')
  async controls() {
    return out(await this.db.control.findMany({ orderBy: { updatedAt: 'desc' } }));
  }

  @Put('controls')
  @Roles('operator')
  async setControl(@Body() body: unknown, @Actor() a: Principal) {
    const d = parse(
      z.object({ scope: z.enum(['GLOBAL', 'SOURCE', 'TARGET', 'FORMAT', 'CONNECTOR']), scopeKey: z.string().min(1), paused: z.boolean(), reason: z.string().min(3) }),
      body,
    );
    if (d.scope === 'GLOBAL' && d.scopeKey !== '*') throw new BadRequestException('GLOBAL scopeKey must be "*"');
    const now = this.clock.now();
    const c = await tx(this.db, async (t) => {
      const r = await setControl(t, d.scope, d.scopeKey, d.paused, a.actor, d.reason);
      await audit(t, { entityType: 'control', entityId: r.id, action: d.paused ? 'paused' : 'resumed', actor: a.actor, data: d, at: now });
      return r;
    });
    return out(c);
  }

  @Get('reports/summary')
  async report(@Query('days') days = '7') {
    const since = new Date(this.clock.now().getTime() - Number(days) * 86_400_000);
    const pubs = await this.db.publication.groupBy({ by: ['contentType', 'status'], where: { createdAt: { gte: since } }, _count: true });
    const attempts = await this.db.publicationAttempt.groupBy({ by: ['outcome'], where: { startedAt: { gte: since } }, _count: true });
    const operatorConfirmed = pubs.filter((p) => p.status === 'OPERATOR_CONFIRMED').reduce((s, p) => s + p._count, 0);
    const verified = pubs.filter((p) => SUCCESS.includes(p.status)).reduce((s, p) => s + p._count, 0);
    const llm = await this.db.llmUsage.aggregate({ where: { at: { gte: since } }, _sum: { costMicroUsd: true } });
    return out({
      since,
      publications: pubs,
      attempts,
      automatic: verified - operatorConfirmed,
      operatorConfirmed,
      llmUsd: Number(llm._sum.costMicroUsd ?? 0n) / 1e6,
      llmUsdPerSuccess: verified ? Number(llm._sum.costMicroUsd ?? 0n) / 1e6 / verified : null,
    });
  }

  private async closeTasks(t: Parameters<Parameters<typeof tx>[1]>[0], where: { variantId?: string; publicationId?: string; kind: 'REVIEW_CONTENT' | 'CONFIRM_RESULT' }, actor: string, resolution: object) {
    await t.operatorTask.updateMany({
      where: { ...where, status: { in: ['OPEN', 'CLAIMED'] } },
      data: { status: 'DONE', resolvedBy: actor, resolution, closedAt: this.clock.now() },
    });
  }
}
