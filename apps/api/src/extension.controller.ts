import {
  Body, ConflictException, Controller, Headers, Inject, NotFoundException, Param, ParseUUIDPipe, Post, UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ACTIVE, EXTENSION_CONNECTOR, EXTENSION_VERSION } from '@seedingsys/contracts';
import {
  accountResource, activeKillSwitch, activeLease, assertLeaseHeld, audit, tx, type Db, type ExtensionCommand, type Tx,
} from '@seedingsys/db';
import type { Clock } from '@seedingsys/domain';
import { ProfileToken, Roles, type Principal } from './auth';
import { CLOCK, DB } from './tokens';
import { Actor, parse } from './util';
import { RadarImport } from './persona-radar';
import { claimRadarScan, finishRadarScan } from './radar-dispatch';

const profileUid = z.string().regex(/^\d{1,32}$/);
const profile = { installationId: z.string().uuid(), uid: profileUid.nullable() };
const request = z.discriminatedUnion('action', [
  z.object({ ...profile, action: z.literal('poll'), radarProtocol: z.literal(1).optional() }),
  z.object({ ...profile, action: z.literal('authorize'), commandId: z.string().uuid() }),
  z.object({ ...profile, action: z.literal('complete'), commandId: z.string().uuid(), outcome: z.enum(['prepared', 'clicked', 'blocked']) }),
  z.object({ ...profile, action: z.literal('radar-complete'), commandId: z.string().uuid(), report: RadarImport.nullable() }),
]);

function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

async function lockTarget(t: Tx, id: string) {
  await t.$queryRaw`SELECT id FROM target_accounts WHERE id = ${id}::uuid FOR UPDATE`;
}

async function commandIsCurrent(t: Tx, command: ExtensionCommand, now: Date) {
  const pub = await t.publication.findUnique({
    where: { id: command.publicationId },
    select: { targetId: true, status: true, contentType: true, post: { select: { sourceId: true, archivedAt: true } } },
  });
  if (!pub || pub.targetId !== command.targetId || pub.contentType !== 'TEXT' || pub.post.archivedAt) return false;
  if (pub.status !== (command.action === 'commit' ? 'COMMITTING' : 'PREPARING')) return false;
  const mapping = await t.sourceTargetMapping.findUnique({
    where: { sourceId_targetId: { sourceId: pub.post.sourceId, targetId: command.targetId } },
    select: { enabled: true },
  });
  if (!mapping?.enabled) return false;
  if (await activeKillSwitch(t, { sourceId: pub.post.sourceId, targetId: command.targetId, connector: EXTENSION_CONNECTOR, contentType: 'TEXT' })) return false;
  return assertLeaseHeld(t, { resource: accountResource(command.targetId), token: command.fencingToken }, now, 5_000);
}

@Controller()
export class ExtensionController {
  constructor(@Inject(DB) private readonly db: Db, @Inject(CLOCK) private readonly clock: Clock) {}

  @Post('targets/extension/import')
  @Roles('admin')
  async importUids(@Body() body: unknown, @Actor() actor: Principal) {
    const { uids } = parse(z.object({ uids: z.array(profileUid).min(1).max(200) }), body);
    return tx(this.db, async t => {
      // Reserve the next target codes even if another admin is creating a target.
      await t.$executeRaw`LOCK TABLE target_accounts IN SHARE ROW EXCLUSIVE MODE`;
      const targets = await t.targetAccount.findMany({ select: { code: true, externalId: true } });
      const existing = new Set(targets.map(target => target.externalId));
      const codes = new Set(targets.map(target => target.code));
      let next = 1;
      const added: Array<{ code: string; uid: string }> = [];
      const skipped: string[] = [];
      for (const uid of new Set(uids)) {
        if (existing.has(uid)) {
          skipped.push(uid);
          continue;
        }
        while (codes.has(`B${next}`)) next++;
        added.push({ code: `B${next++}`, uid });
      }
      if (added.length) await t.targetAccount.createMany({ data: added.map(({ code, uid }) => ({
        code, externalId: uid, name: 'Facebook ' + uid, connector: EXTENSION_CONNECTOR, audience: 'ONLY_ME', enabled: false,
      })) });
      if (added.length) await audit(t, {
        entityType: 'target', entityId: 'extension-import', action: 'targets_imported', actor: actor.actor, data: { added }, at: this.clock.now(),
      });
      return { added, skipped };
    });
  }

  @Post('targets/:id/extension/key')
  @Roles('admin')
  async issue(@Param('id', ParseUUIDPipe) id: string, @Actor() actor: Principal) {
    const token = 'profile_' + randomBytes(32).toString('base64url');
    return tx(this.db, async t => {
      await lockTarget(t, id);
      const target = await t.targetAccount.findUnique({ where: { id } });
      if (!target || target.connector !== EXTENSION_CONNECTOR) throw new NotFoundException('Chọn cách đăng qua extension.');
      if (target.audience !== 'ONLY_ME' || !profileUid.safeParse(target.externalId).success) {
        throw new ConflictException('Cần UID số và đối tượng Chỉ mình tôi.');
      }
      const now = this.clock.now();
      await this.ensureIdle(t, id, now);
      const name = 'extension:' + target.code;
      const node = await t.workerNode.upsert({
        where: { name }, create: { name, kind: 'BROWSER' }, update: { lastHeartbeatAt: null },
      });
      await t.browserProfile.upsert({
        where: { targetId: id },
        create: { targetId: id, workerNodeId: node.id, profileDir: name },
        update: { workerNodeId: node.id, profileDir: name },
      });
      const data = { uid: target.externalId, tokenHash: tokenHash(token), installationId: null };
      await t.extensionBinding.upsert({ where: { targetId: id }, create: { targetId: id, ...data }, update: data });
      await t.extensionRadarScan.updateMany({ where: { targetId: id, state: 'QUEUED' }, data: { state: 'FAILED' } });
      await t.capabilityCheck.upsert({
        where: { targetId_contentType_connector_connectorVersion: {
          targetId: id, contentType: 'TEXT', connector: EXTENSION_CONNECTOR, connectorVersion: EXTENSION_VERSION,
        } },
        create: {
          targetId: id, contentType: 'TEXT', connector: EXTENSION_CONNECTOR, connectorVersion: EXTENSION_VERSION,
          passed: true, cases: 0, notes: 'Private text pilot with operator reconciliation',
        },
        update: { passed: true },
      });
      await audit(t, { entityType: 'target', entityId: id, action: 'extension_key_issued', actor: actor.actor, at: now });
      return { token };
    });
  }

  @Post('targets/:id/extension/revoke')
  @Roles('admin')
  async revoke(@Param('id', ParseUUIDPipe) id: string, @Actor() actor: Principal) {
    return tx(this.db, async t => {
      await lockTarget(t, id);
      const now = this.clock.now();
      await this.ensureIdle(t, id, now);
      const removed = await t.extensionBinding.deleteMany({ where: { targetId: id } });
      if (removed.count) {
        await t.extensionRadarScan.updateMany({ where: { targetId: id, state: 'QUEUED' }, data: { state: 'FAILED' } });
        const profile = await t.browserProfile.findUnique({ where: { targetId: id } });
        if (profile?.workerNodeId) {
          await t.workerNode.update({ where: { id: profile.workerNodeId }, data: { lastHeartbeatAt: null } });
        }
        await audit(t, { entityType: 'target', entityId: id, action: 'extension_key_revoked', actor: actor.actor, at: now });
      }
      return { ok: true };
    });
  }

  @Post('extension')
  @ProfileToken()
  async message(@Headers('authorization') header: string | undefined, @Body() body: unknown) {
    const token = /^Bearer (profile_[\w-]{43})$/.exec(header ?? '')?.[1];
    if (!token) throw new UnauthorizedException('Mã profile không hợp lệ.');
    const hash = tokenHash(token);
    const input = parse(request, body);
    const found = await this.db.extensionBinding.findUnique({ where: { tokenHash: hash }, select: { targetId: true } });
    if (!found) throw new UnauthorizedException('Mã profile không hợp lệ.');

    return tx(this.db, async t => {
      await lockTarget(t, found.targetId);
      const binding = await t.extensionBinding.findUnique({
        where: { tokenHash: hash },
        include: { target: { include: { profile: true } } },
      });
      if (!binding || (binding.installationId && binding.installationId !== input.installationId)) {
        throw new UnauthorizedException('Mã profile đã bị thay thế hoặc đã ghép với profile khác.');
      }
      const target = binding.target;
      const nodeId = target.profile?.workerNodeId;
      const now = this.clock.now();
      if (!nodeId || target.connector !== EXTENSION_CONNECTOR || target.externalId !== binding.uid || target.audience !== 'ONLY_ME') {
        throw new ConflictException('Cấu hình đích đã thay đổi.');
      }
      if (input.action === 'poll') {
        if (input.uid !== binding.uid) {
          if (binding.installationId) await t.workerNode.update({ where: { id: nodeId }, data: { lastHeartbeatAt: null } });
          return { code: target.code, state: input.uid ? 'WRONG_UID' : 'LOGGED_OUT', command: null };
        }
        if (!binding.installationId) await t.extensionBinding.update({
          where: { targetId: target.id }, data: { installationId: input.installationId },
        });
        await t.workerNode.update({ where: { id: nodeId }, data: { lastHeartbeatAt: now, capabilities: { radarProtocol: input.radarProtocol ?? 0 } } });
        await t.extensionCommand.deleteMany({ where: { targetId: target.id, expiresAt: { lt: new Date(now.getTime() - 300_000) } } });
        const command = target.enabled ? await t.extensionCommand.findFirst({
          where: { targetId: target.id, expiresAt: { gt: now }, claimedAt: null }, orderBy: { expiresAt: 'asc' },
        }) : null;
        if (!command || !await commandIsCurrent(t, command, now)) {
          const radar = target.enabled && input.radarProtocol === 1 ? await claimRadarScan(t, target.id, input.installationId, now) : null;
          return { code: target.code, state: 'CONNECTED', command: radar };
        }
        await t.extensionCommand.update({ where: { id: command.id }, data: { claimedAt: now } });
        return {
          code: target.code, state: 'CONNECTED',
          command: { id: command.id, action: command.action, sessionId: command.sessionId, caption: command.caption,
            lifetimeMs: command.expiresAt.getTime() - now.getTime() },
        };
      }
      if (!binding.installationId) throw new UnauthorizedException('Profile chưa kết nối.');
      if (input.action === 'radar-complete') {
        if (input.uid !== binding.uid) throw new ConflictException('Profile đã đổi UID.');
        return finishRadarScan(t, {
          id: input.commandId, installationId: binding.installationId, targetId: target.id, report: target.enabled ? input.report : null, now,
        });
      }
      const command = await t.extensionCommand.findFirst({ where: { id: input.commandId, targetId: target.id, claimedAt: { not: null } } });
      if (!command || command.expiresAt <= now) throw new ConflictException('Lệnh đã hết hạn.');
      if (input.action === 'authorize') {
        if (input.uid !== binding.uid || !target.enabled || command.action !== 'commit' || command.authorizedAt || command.result
          || !await commandIsCurrent(t, command, now)) {
          throw new ConflictException('Lệnh đăng không còn được phép thực thi.');
        }
        await t.extensionCommand.update({ where: { id: command.id }, data: { authorizedAt: now } });
        return { lifetimeMs: Math.min(5_000, command.expiresAt.getTime() - now.getTime()) };
      }
      if ((input.outcome === 'prepared' && (command.action !== 'prepare' || input.uid !== binding.uid))
        || (input.outcome === 'clicked' && (command.action !== 'commit' || !command.authorizedAt))) {
        throw new ConflictException('Kết quả không khớp với lệnh đã cấp.');
      }
      if (!command.result) await t.extensionCommand.update({ where: { id: command.id }, data: { result: { outcome: input.outcome } } });
      return { ok: true };
    });
  }

  private async ensureIdle(t: Tx, id: string, now: Date) {
    if (await activeLease(t, accountResource(id), now)
      || await t.publication.findFirst({ where: { targetId: id, status: { in: ['QUEUED', ...ACTIVE] } }, select: { id: true } })) {
      throw new ConflictException('Chờ lượt đăng đang chạy kết thúc trước khi đổi mã profile.');
    }
  }
}
