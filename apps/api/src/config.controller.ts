import { BadRequestException, Body, ConflictException, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { EXTENSION_CONNECTOR, isExtensionPublishAudience, Q, SOURCE_CODE_PATTERN } from '@seedingsys/contracts';
import { activeKillSwitch, activeLease, audit, enqueue, Prisma, sourceResource, tx, type Db } from '@seedingsys/db';
import { facebookSourceUrl, isFacebookTimelineReader, type Clock } from '@seedingsys/domain';
import { Roles, type Principal } from './auth';
import { CLOCK, DB } from './tokens';
import { Actor, out, parse } from './util';

const SourceIn = z.object({
  code: z.string().regex(new RegExp(`^${SOURCE_CODE_PATTERN}$`), 'Mã nguồn dùng tiền tố N, ví dụ N21.'),
  name: z.string().min(1),
  externalRef: z.string().min(1),
  connector: z.enum(['fake', 'manual', 'fb-graph', 'fb-web', 'fb-public', 'fb-session']),
  enabled: z.boolean().optional(),
  pollIntervalSec: z.number().int().min(60).optional(),
  overlapCount: z.number().int().min(0).max(50).optional(),
  collectComments: z.boolean().optional(),
});

function publicSourceRef(ref: string): string {
  const url = facebookSourceUrl(ref);
  if (!url) throw new BadRequestException('Nhập URL trang cá nhân hoặc fanpage trên facebook.com.');
  return url.href;
}

const facebookUid = z.string().regex(/^\d{1,32}$/, 'UID Facebook phải có từ 1 đến 32 chữ số.').nullable();
const ParentAccountsIn = z.object({ changes: z.array(z.object({
  slot: z.number().int().positive().max(2_147_483_647), uid: facebookUid, previousUid: facebookUid,
})).min(1).max(100) });

const TargetIn = z.object({
  code: z.string().regex(/^B\d+$/),
  name: z.string().min(1),
  externalId: z.string().min(1),
  connector: z.enum(['fake', 'fb-web', EXTENSION_CONNECTOR]),
  audience: z.enum(['ONLY_ME', 'FRIENDS', 'PUBLIC']).optional(),
  uiLocale: z.string().optional(),
  enabled: z.boolean().optional(),
  styleProfile: z.record(z.unknown()).optional(),
});
function validateExtensionTarget(connector: string, uid: string, audience: string) {
  if (connector === EXTENSION_CONNECTOR && (!/^\d{1,32}$/.test(uid) || !isExtensionPublishAudience(audience))) {
    throw new BadRequestException('Đích extension cần UID số và đối tượng Chỉ mình tôi hoặc Công khai.');
  }
}

const MappingIn = z.object({
  sourceId: z.string().uuid(),
  targetId: z.string().uuid(),
  enabled: z.boolean().optional(),
  contentTtlHours: z.number().int().min(1).optional(),
  lateWindowMin: z.number().int().min(1).max(59).optional(),
  strictOrder: z.boolean().optional(),
  reviewMode: z.enum(['AUTO', 'MANUAL']).optional(),
  maxPublishTries: z.number().int().min(1).max(5).optional(),
});

@Controller()
export class ConfigController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get('sources')
  async sources() {
    return out(await this.db.source.findMany({ orderBy: { code: 'asc' } }));
  }
  @Post('sources')
  @Roles('admin')
  async createSource(@Body() body: unknown, @Actor() a: Principal) {
    const data = parse(SourceIn, body);
    if (isFacebookTimelineReader(data.connector)) data.externalRef = publicSourceRef(data.externalRef);
    const s = await this.db.source.create({ data });
    await audit(this.db, { entityType: 'source', entityId: s.id, action: 'created', actor: a.actor, at: this.clock.now() });
    return out(s);
  }
  @Patch('sources/:id')
  @Roles('admin')
  async updateSource(@Param('id') id: string, @Body() body: unknown, @Actor() a: Principal) {
    const data = parse(SourceIn.partial(), body);
    const s = await tx(this.db, async (t) => {
      const current = await t.source.findUniqueOrThrow({ where: { id } });
      const connector = data.connector ?? current.connector;
      if (isFacebookTimelineReader(connector)) data.externalRef = publicSourceRef(data.externalRef ?? current.externalRef);
      const reset = (isFacebookTimelineReader(connector) || isFacebookTimelineReader(current.connector))
        && (connector !== current.connector || (data.externalRef !== undefined && data.externalRef !== current.externalRef));
      const changed = await t.source.updateMany({
        where: { id, connector: current.connector, externalRef: current.externalRef },
        data: {
          ...data,
          ...(reset && {
            watermark: Prisma.DbNull, baselineDone: false, lastPollAt: null, lastSuccessAt: null,
            lastError: null, lastErrorAt: null, lastIncomplete: Prisma.DbNull,
          }),
        },
      });
      if (!changed.count) throw new ConflictException('Nguồn vừa thay đổi. Tải lại cấu hình và lưu lại.');
      await audit(t, { entityType: 'source', entityId: id, action: 'updated', actor: a.actor, data, at: this.clock.now() });
      return t.source.findUniqueOrThrow({ where: { id } });
    });
    return out(s);
  }

  @Post('sources/:id/poll')
  @Roles('admin')
  async pollSource(@Param('id', ParseUUIDPipe) id: string, @Actor() a: Principal) {
    return tx(this.db, async (t) => {
      // Serialize manual requests against other requests and the scheduler's source update.
      const locked = await t.$queryRaw<Array<{ id: string }>>`SELECT id FROM sources WHERE id = ${id}::uuid FOR UPDATE`;
      if (!locked.length) throw new NotFoundException('Không tìm thấy nguồn.');
      const now = this.clock.now();
      const source = await t.source.findUniqueOrThrow({ where: { id } });
      if (!source.enabled) throw new ConflictException('Bật nguồn trước khi quét.');
      if (source.connector === 'manual') throw new ConflictException('Nguồn này nhận nội dung từ trang Nhập bài.');
      if (await activeKillSwitch(t, { sourceId: id, connector: source.connector })) {
        throw new ConflictException('Nguồn đang bị tạm dừng bởi công tắc dừng.');
      }
      const pending = await t.outboxEvent.findFirst({ where: { queue: Q.SourcePoll, singletonKey: id, publishedAt: null }, select: { id: true } });
      if (pending || await activeLease(t, sourceResource(id), now)) return { queued: false };

      await t.source.update({ where: { id }, data: { lastPollAt: now } });
      await enqueue(t, Q.SourcePoll, { sourceId: id, collectComments: source.collectComments }, { singletonKey: id });
      await audit(t, { entityType: 'source', entityId: id, action: 'poll_requested', actor: a.actor, at: now });
      return { queued: true };
    });
  }

  @Get('targets')
  async targets() {
    return out(await this.db.targetAccount.findMany({
      orderBy: { code: 'asc' }, include: {
        profile: { include: { workerNode: { select: { lastHeartbeatAt: true } } } },
        extension: { select: { installationId: true } },
      },
    }));
  }

  @Get('parent-accounts')
  @Roles('admin')
  async parentAccounts() {
    return this.db.parentAccount.findMany({ orderBy: { slot: 'asc' } });
  }

  @Patch('parent-accounts')
  @Roles('admin')
  async updateParentAccounts(@Body() body: unknown, @Actor() a: Principal) {
    const { changes } = parse(ParentAccountsIn, body);
    const slots = changes.map(change => change.slot);
    if (new Set(slots).size !== slots.length) throw new BadRequestException('Mỗi mã A chỉ được gửi một lần.');
    try {
      return await tx(this.db, async t => {
        const rows = await t.$queryRaw<Array<{ slot: number; uid: string | null }>>`
          SELECT slot, uid FROM parent_accounts WHERE slot IN (${Prisma.join(slots)}) ORDER BY slot FOR UPDATE`;
        const current = new Map(rows.map(row => [row.slot, row.uid]));
        for (const change of changes) {
          if (!current.has(change.slot)) throw new NotFoundException(`Chưa có mã A${change.slot} trong danh bạ.`);
          if (current.get(change.slot) !== change.previousUid) {
            throw new ConflictException(`A${change.slot} vừa thay đổi. Tải lại trang rồi thử lại.`);
          }
        }
        const updates = changes.filter(change => change.uid !== change.previousUid);
        if (updates.length) {
          await t.parentAccount.updateMany({ where: { slot: { in: updates.map(change => change.slot) } }, data: { uid: null } });
          const now = this.clock.now();
          for (const { slot, uid } of updates) {
            if (uid !== null) await t.parentAccount.update({ where: { slot }, data: { uid } });
            await audit(t, { entityType: 'parent_account', entityId: `A${slot}`, action: uid === null ? 'uid_cleared' : 'uid_assigned', actor: a.actor, at: now });
          }
        }
        return t.parentAccount.findMany({ orderBy: { slot: 'asc' } });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2002') throw new ConflictException('UID Facebook chỉ được gán cho một mã A. Kiểm tra UID bị trùng.');
        if (error.code === 'P2034') throw new ConflictException('Danh bạ vừa thay đổi. Tải lại trang rồi thử lại.');
      }
      throw error;
    }
  }

  @Post('targets')
  @Roles('admin')
  async createTarget(@Body() body: unknown, @Actor() a: Principal) {
    const d = parse(TargetIn, body);
    validateExtensionTarget(d.connector, d.externalId, d.audience ?? 'ONLY_ME');
    const t = await this.db.targetAccount.create({ data: { ...d, styleProfile: (d.styleProfile ?? {}) as object } });
    await audit(this.db, { entityType: 'target', entityId: t.id, action: 'created', actor: a.actor, at: this.clock.now() });
    return out(t);
  }
  @Patch('targets/:id')
  @Roles('admin')
  async updateTarget(@Param('id') id: string, @Body() body: unknown, @Actor() a: Principal) {
    const d = parse(TargetIn.partial(), body);
    return tx(this.db, async t => {
      await t.$queryRaw`SELECT id FROM target_accounts WHERE id = ${id}::uuid FOR UPDATE`;
      const old = await t.targetAccount.findUniqueOrThrow({ where: { id }, include: { extension: true } });
      const connector = d.connector ?? old.connector;
      const uid = d.externalId ?? old.externalId;
      validateExtensionTarget(connector, uid, d.audience ?? old.audience);
      if (old.extension && (connector !== old.connector || uid !== old.externalId)) {
        throw new ConflictException('Thu hồi mã profile trước khi đổi UID hoặc cách đăng.');
      }
      const target = await t.targetAccount.update({ where: { id }, data: { ...d, styleProfile: d.styleProfile as object | undefined } });
      await audit(t, { entityType: 'target', entityId: id, action: 'updated', actor: a.actor, data: d, at: this.clock.now() });
      return out(target);
    });
  }

  @Get('mappings')
  async mappings() {
    return out(await this.db.sourceTargetMapping.findMany({ include: { source: { select: { code: true } }, target: { select: { code: true } } } }));
  }
  @Post('mappings')
  @Roles('admin')
  async createMapping(@Body() body: unknown, @Actor() a: Principal) {
    const m = await this.db.sourceTargetMapping.create({ data: parse(MappingIn, body) });
    await audit(this.db, { entityType: 'mapping', entityId: m.id, action: 'created', actor: a.actor, at: this.clock.now() });
    return out(m);
  }
  @Post('mappings/batch')
  @Roles('admin')
  async createMappings(@Body() body: unknown, @Actor() actor: Principal) {
    const { targetIds, ...settings } = parse(MappingIn.omit({ targetId: true }).extend({
      targetIds: z.array(z.string().uuid()).min(1).max(200),
    }), body);
    return tx(this.db, async t => {
      const targets = [...new Set(targetIds)];
      if (!await t.source.findUnique({ where: { id: settings.sourceId }, select: { id: true } })
        || await t.targetAccount.count({ where: { id: { in: targets } } }) !== targets.length) {
        throw new ConflictException('Nguồn hoặc tài khoản đã thay đổi. Tải lại danh sách.');
      }
      const created = await t.sourceTargetMapping.createManyAndReturn({
        data: targets.map(targetId => ({ ...settings, targetId })), skipDuplicates: true,
      });
      const now = this.clock.now();
      for (const mapping of created) {
        await audit(t, { entityType: 'mapping', entityId: mapping.id, action: 'created', actor: actor.actor, at: now });
      }
      return out({ created, skipped: targets.length - created.length });
    });
  }
  @Patch('mappings/:id')
  @Roles('admin')
  async updateMapping(@Param('id') id: string, @Body() body: unknown, @Actor() a: Principal) {
    const m = await this.db.sourceTargetMapping.update({ where: { id }, data: parse(MappingIn.partial().omit({ sourceId: true, targetId: true }), body) });
    await audit(this.db, { entityType: 'mapping', entityId: id, action: 'updated', actor: a.actor, data: body, at: this.clock.now() });
    return out(m);
  }
}
