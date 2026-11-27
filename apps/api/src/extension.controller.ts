import {
  Body, ConflictException, Controller, Headers, Inject, NotFoundException, Optional, Param, ParseUUIDPipe, Post, UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ACTIVE, EXTENSION_CONNECTOR, EXTENSION_MEDIA_CHUNK, EXTENSION_MEDIA_FILE_LIMIT, EXTENSION_MEDIA_LIMIT, EXTENSION_VERSION, InstagramResearchProtocolSchema,
  extensionMediaProtocol, isExtensionMediaFormat, isExtensionPublishAudience, ResearchIssueSchema, ResearchReportSchema, SUCCESS, validExtensionMedia,
  type ExtensionCommentContext, type ExtensionPublishAudience, type PublishSnapshot } from '@seedingsys/contracts';
import {
  accountResource, activeKillSwitch, activeLease, assertLeaseHeld, audit, commentListener, personaCommentAuthor, tx, type Db, type ExtensionCommand, type Tx,
} from '@seedingsys/db';
import { facebookCommentId, facebookPostId, facebookPostLink, facebookUrl, type Clock } from '@seedingsys/domain';
import { ProfileToken, Roles, type Principal } from './auth';
import type { ObjectStore } from '@seedingsys/storage';
import { CLOCK, DB, STORE } from './tokens';
import { Actor, parse } from './util';
import { RadarImport } from './persona-radar';
import { claimRadarScan, finishRadarScan } from './radar-dispatch';
import { claimResearch, continuousResearch, finishResearch, waitForInstagramThread } from './research-dispatch';
import { claimPublicationVerify, finishPublicationVerify, PublicationVerifyReport, queuePublicationVerify } from './publication-verify';

const profileUid = z.string().regex(/^\d{1,32}$/);
const profile = { installationId: z.string().uuid(), uid: profileUid.nullable() };
const request = z.discriminatedUnion('action', [
  z.object({ ...profile, action: z.literal('poll'), radarProtocol: z.literal(1).optional(), commentProtocol: z.union([z.literal(1), z.literal(2)]).optional(),
    extensionVersion: z.string().regex(/^\d{1,4}(?:\.\d{1,4}){0,3}$/).optional(),
    researchProtocol: z.literal(1).optional(), publishProtocol: z.literal(2).optional(), instagramResearch: InstagramResearchProtocolSchema.optional(),
    instagramLoggedIn: z.boolean().optional(), instagramJobId: z.string().uuid().optional(), instagramCadenceTrial: z.literal(1).optional(),
    instagramCommentsProtocol: z.literal(1).optional(),
    publicationVerifyProtocol: z.literal(1).optional(), publishMediaProtocol: z.union([z.literal(1), z.literal(2)]).optional() }),
  z.object({ ...profile, action: z.literal('wait-instagram-thread') }),
  z.object({ ...profile, action: z.literal('authorize'), commandId: z.string().uuid() }),
  z.object({ ...profile, action: z.literal('read-publish-media'), commandId: z.string().uuid(),
    offset: z.number().int().min(0).max(EXTENSION_MEDIA_LIMIT - 1), fileIndex: z.number().int().min(0).max(EXTENSION_MEDIA_FILE_LIMIT - 1).optional() }),
  z.object({ ...profile, action: z.literal('complete'), commandId: z.string().uuid(), outcome: z.enum(['prepared', 'clicked', 'blocked']),
    issue: z.string().trim().max(240).optional(), verification: z.literal('reopened-post').optional(),
    receipt: z.object({ externalId: z.string().regex(/^[\w:-]{1,150}$/), permalink: z.string().max(2000).url() }).optional() }),
  z.object({ ...profile, action: z.literal('radar-complete'), commandId: z.string().uuid(), report: RadarImport.nullable() }),
  z.object({ ...profile, action: z.literal('research-complete'), commandId: z.string().uuid(), report: ResearchReportSchema.nullable(),
    issue: ResearchIssueSchema.optional(), lease: z.string().regex(/^\d{1,20}$/).optional(), pending: z.boolean().optional() }),
  z.object({ ...profile, action: z.literal('publication-verify-complete'), commandId: z.string().uuid(), report: PublicationVerifyReport.nullable() }),
]);

function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

async function lockTarget(t: Tx, id: string) {
  await t.$queryRaw`SELECT id FROM target_accounts WHERE id = ${id}::uuid FOR UPDATE`;
}

async function commandIsCurrent(t: Tx, command: ExtensionCommand, now: Date) {
  if (command.action.startsWith('comment-')) return await commentCommandIsCurrent(t, command, now) ? {} : null;
  if (command.action !== 'prepare' && command.action !== 'commit') return null;
  const pub = await t.publication.findUnique({
    where: { id: command.publicationId },
    select: { targetId: true, status: true, contentType: true, post: { select: { sourceId: true, archivedAt: true } },
      target: { select: { audience: true } }, variant: { select: { snapshot: true } } },
  });
  if (!pub || pub.targetId !== command.targetId || (pub.contentType !== 'TEXT' && !isExtensionMediaFormat(pub.contentType)) || pub.post.archivedAt) return null;
  const preparingState = ['REEL', 'VIDEO'].includes(pub.contentType) ? 'UPLOADING_DRAFT' : 'PREPARING';
  if (pub.status !== (command.action === 'commit' ? 'COMMITTING' : preparingState)) return null;
  const snapshot = pub.variant.snapshot as unknown as PublishSnapshot | null;
  const audience = snapshot?.audience;
  if (!isExtensionPublishAudience(audience) || audience !== pub.target.audience || snapshot?.caption !== command.caption
    || snapshot.contentType !== pub.contentType || snapshot.targetId !== command.targetId) return null;
  const mapping = await t.sourceTargetMapping.findUnique({
    where: { sourceId_targetId: { sourceId: pub.post.sourceId, targetId: command.targetId } },
    select: { enabled: true },
  });
  if (!mapping?.enabled) return null;
  if (await activeKillSwitch(t, { sourceId: pub.post.sourceId, targetId: command.targetId, connector: EXTENSION_CONNECTOR, contentType: pub.contentType })) return null;
  if (!await assertLeaseHeld(t, { resource: accountResource(command.targetId), token: command.fencingToken }, now, 5_000)) return null;
  if (!isExtensionMediaFormat(pub.contentType)) return { audience } satisfies { audience: ExtensionPublishAudience };
  if (!Array.isArray(snapshot.media) || !validExtensionMedia(pub.contentType, snapshot.media)) return null;
  const assets = await t.asset.findMany({ where: { id: { in: snapshot.media.map(item => item.assetId) } },
    select: { id: true, bytes: true, objectKey: true, mime: true, checksum: true, status: true } });
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  let total = 0n;
  const files = [];
  for (const [index, item] of snapshot.media.entries()) {
    const asset = byId.get(item.assetId);
    if (item.position !== index || !asset?.bytes || asset.bytes < 1n || asset.status !== 'STORED' || asset.checksum !== item.checksum
      || asset.objectKey !== item.objectKey || asset.mime !== item.mime) return null;
    total += asset.bytes;
    if (total > BigInt(EXTENSION_MEDIA_LIMIT)) return null;
    files.push({ mime: item.mime, size: Number(asset.bytes), checksum: item.checksum });
  }
  const format = pub.contentType;
  const media = extensionMediaProtocol(format) === 1 ? { format, ...files[0] } : { format, files };
  return { audience, media, objectKeys: snapshot.media.map(item => item.objectKey) };
}

async function commentCommandIsCurrent(t: Tx, command: ExtensionCommand, now: Date) {
  const data = command.comment as ExtensionCommentContext | null;
  if (!data) return false;
  const replay = await t.publicationComment.findFirst({
    where: { id: data.replayId, sendVersion: data.sendVersion, authorTargetId: command.targetId,
      status: command.action === 'comment-commit' ? 'SENDING' : 'QUEUED', text: command.caption },
    include: { source: { include: { post: true } }, sourcePost: true },
  });
  const post = replay?.source?.post ?? replay?.sourcePost;
  if (!replay?.personaApprovalId || !post || post.archivedAt) return false;
  const parentExternalId = replay.source?.parentExternalId ?? null;
  const pub = await t.publication.findFirst({
    where: { id: command.publicationId, targetId: replay.destinationId, sourcePostId: post.id, status: { in: [...SUCCESS] },
      target: { enabled: true } }, select: { permalink: true, commentAccessConfirmedAt: true,
      target: { select: { audience: true } }, variant: { select: { snapshot: true } } },
  });
  const requested = facebookUrl(data.postUrl);
  if (!pub || !requested || facebookPostId(requested) !== facebookPostLink(pub.permalink)?.id) return false;
  const audience = (pub.variant.snapshot as unknown as PublishSnapshot | null)?.audience ?? pub.target.audience;
  if (audience === 'ONLY_ME' && replay.destinationId !== command.targetId && !pub.commentAccessConfirmedAt) return false;
  const listener = await commentListener(t, replay.destinationId, { sourcePostId: post.id, parentExternalId });
  const author = listener && await personaCommentAuthor(t, replay.personaApprovalId, listener);
  if (!author || author.id !== command.targetId) return false;
  if (parentExternalId) {
    const parent = await t.publicationComment.findFirst({
      where: { destinationId: replay.destinationId, status: 'POSTED',
        source: { sourcePostId: post.id, externalId: parentExternalId } },
      select: { permalink: true },
    });
    const parentUrl = facebookUrl(parent?.permalink);
    const root = facebookCommentId(parentUrl?.searchParams.get('comment_id'));
    const reply = facebookCommentId(parentUrl?.searchParams.get('reply_comment_id'));
    if (!root || data.parentId !== (reply ?? root) || root !== requested.searchParams.get('comment_id')
      || (reply ?? null) !== requested.searchParams.get('reply_comment_id')) return false;
  } else if (data.parentId || requested.searchParams.has('comment_id') || requested.searchParams.has('reply_comment_id')) return false;
  for (const targetId of new Set([command.targetId, replay.destinationId])) {
    if (await activeKillSwitch(t, { sourceId: post.sourceId, targetId, connector: EXTENSION_CONNECTOR })) return false;
  }
  return assertLeaseHeld(t, { resource: accountResource(command.targetId), token: command.fencingToken }, now, 5_000);
}

@Controller()
export class ExtensionController {
  constructor(@Inject(DB) private readonly db: Db, @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(STORE) private readonly store?: ObjectStore) {}

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
      if (!isExtensionPublishAudience(target.audience) || !profileUid.safeParse(target.externalId).success) {
        throw new ConflictException('Cần UID số và đối tượng Chỉ mình tôi hoặc Công khai.');
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

  @Post('publications/:id/verify')
  @Roles('operator')
  async verifyOldPublication(@Param('id', ParseUUIDPipe) id: string) {
    const pub = await this.db.publication.findUnique({ where: { id }, select: { targetId: true } });
    if (!pub) throw new NotFoundException('Không tìm thấy lượt đăng.');
    const queued = await tx(this.db, async t => {
      await lockTarget(t, pub.targetId);
      return queuePublicationVerify(t, id, pub.targetId, this.clock.now());
    });
    if (!queued) throw new ConflictException('Lượt này không có bằng chứng gửi từ extension để đối soát.');
    return queued;
  }

  @Post('extension')
  @ProfileToken()
  async message(@Headers('authorization') header: string | undefined, @Body() body: unknown) {
    const token = /^Bearer (profile_[\w-]{43})$/.exec(header ?? '')?.[1];
    if (!token) throw new UnauthorizedException('Mã profile không hợp lệ.');
    const hash = tokenHash(token);
    const input = parse(request, body);
    if (input.action === 'wait-instagram-thread') {
      const binding = await this.db.extensionBinding.findUnique({ where: { tokenHash: hash }, select: {
        targetId: true, installationId: true, uid: true,
        target: { select: { code: true, enabled: true, externalId: true, connector: true } },
      } });
      if (!binding?.installationId || binding.installationId !== input.installationId || binding.uid !== input.uid
        || binding.target.connector !== EXTENSION_CONNECTOR || binding.target.externalId !== binding.uid || !binding.target.enabled) {
        throw new UnauthorizedException('Phiên ghép profile không còn hiệu lực.');
      }
      // Waiting only sends a wake-up. Poll still checks the profile, UID and lease before it can claim a command.
      const ready = await waitForInstagramThread(this.db, binding.targetId, input.installationId, () => this.clock.now());
      return { code: binding.target.code, state: 'CONNECTED', command: null, ready };
    }
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
      if (!nodeId || target.connector !== EXTENSION_CONNECTOR || target.externalId !== binding.uid || !isExtensionPublishAudience(target.audience)) {
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
        await t.workerNode.update({ where: { id: nodeId }, data: { lastHeartbeatAt: now, capabilities: {
          radarProtocol: input.radarProtocol ?? 0, commentProtocol: input.commentProtocol ?? 0, researchProtocol: input.researchProtocol ?? 0,
          extensionVersion: input.extensionVersion ?? null,
          publishProtocol: input.publishProtocol ?? 0,
          publishMediaProtocol: input.publishMediaProtocol ?? 0,
          instagramResearch: input.instagramResearch ?? 0,
          instagramLoggedIn: input.instagramResearch ? input.instagramLoggedIn ?? null : null,
          publicationVerifyProtocol: input.publicationVerifyProtocol ?? 0, instagramCadenceTrial: input.instagramCadenceTrial ?? 0,
          instagramCommentsProtocol: input.instagramCommentsProtocol ?? 0,
        } } });
        const tracked = input.instagramJobId ? { instagramJobActive: !!await t.extensionRadarScan.findFirst({
          where: { id: input.instagramJobId, targetId: target.id, installationId: input.installationId,
            state: { in: ['QUEUED', 'RUNNING'] }, ...continuousResearch }, select: { id: true },
        }) } : {};
        await t.extensionCommand.deleteMany({ where: { targetId: target.id, expiresAt: { lt: new Date(now.getTime() - 300_000) } } });
        const command = target.enabled ? await t.extensionCommand.findFirst({
          where: { targetId: target.id, expiresAt: { gt: now }, claimedAt: null, action: { in: [
            ...(target.audience !== 'PUBLIC' || input.publishProtocol === 2 ? ['prepare', 'commit'] : []),
            ...(input.commentProtocol ? ['comment-prepare', 'comment-commit'] : []),
          ] },
          }, orderBy: { expiresAt: 'asc' },
        }) : null;
        const composed = (command?.comment as ExtensionCommentContext | null)?.composed;
        const current = command && (!composed || input.commentProtocol === 2) ? await commandIsCurrent(t, command, now) : null;
        if (!command || !current || (current.media && (input.publishMediaProtocol ?? 0) < extensionMediaProtocol(current.media.format))) {
          const verification = target.enabled && input.publicationVerifyProtocol === 1
            ? await claimPublicationVerify(t, target.id, binding.uid, now) : null;
          if (verification) return { code: target.code, state: 'CONNECTED', command: verification, ...tracked };
          const radar = target.enabled && input.radarProtocol === 1 ? await claimRadarScan(t, target.id, input.installationId, now) : null;
          const research = !radar && target.enabled && input.researchProtocol === 1
            ? await claimResearch(t, target.id, input.installationId, now, input.instagramResearch, input.instagramLoggedIn,
              input.instagramCadenceTrial, input.instagramCommentsProtocol) : null;
          return { code: target.code, state: 'CONNECTED', command: radar ?? research, ...tracked };
        }
        await t.extensionCommand.update({ where: { id: command.id }, data: { claimedAt: now } });
        const { objectKeys: _objectKeys, ...payload } = current as typeof current & { objectKeys?: string[] };
        return {
          code: target.code, state: 'CONNECTED', ...tracked,
          command: { id: command.id, action: command.action, sessionId: command.sessionId, caption: command.caption, comment: command.comment,
            ...payload, lifetimeMs: command.expiresAt.getTime() - now.getTime() },
        };
      }
      if (!binding.installationId) throw new UnauthorizedException('Profile chưa kết nối.');
      if (input.action === 'publication-verify-complete') {
        if (!target.enabled || input.uid !== binding.uid) throw new ConflictException('Profile đã đổi UID hoặc đích không còn hoạt động.');
        return finishPublicationVerify(t, { id: input.commandId, targetId: target.id, uid: binding.uid, now, report: input.report });
      }
      if (input.action === 'research-complete') {
        if (input.uid !== binding.uid) throw new ConflictException('Profile đã đổi UID.');
        return finishResearch(t, {
          id: input.commandId, installationId: binding.installationId, targetId: target.id, report: target.enabled ? input.report : null,
          issue: target.enabled ? input.issue : undefined, lease: input.lease, pending: target.enabled && input.pending, now,
        });
      }
      if (input.action === 'radar-complete') {
        if (input.uid !== binding.uid) throw new ConflictException('Profile đã đổi UID.');
        return finishRadarScan(t, {
          id: input.commandId, installationId: binding.installationId, targetId: target.id, report: target.enabled ? input.report : null, now,
        });
      }
      const command = await t.extensionCommand.findFirst({ where: { id: input.commandId, targetId: target.id, claimedAt: { not: null } } });
      if (!command || command.action === 'publication-verify' || command.expiresAt <= now) throw new ConflictException('Lệnh đã hết hạn hoặc sai loại.');
      if (input.action === 'read-publish-media') {
        const current = target.enabled && input.uid === binding.uid && command.action === 'prepare' && !command.result
          ? await commandIsCurrent(t, command, now) : null;
        const index = input.fileIndex ?? 0;
        const files = current?.media ? current.media.files ?? [current.media] : [];
        const file = files[index];
        const objectKey = current?.objectKeys?.[index];
        if (!this.store || !file || !objectKey || input.offset % EXTENSION_MEDIA_CHUNK || input.offset >= file.size) {
          throw new ConflictException('Tệp này không còn thuộc lệnh đăng đang chuẩn bị.');
        }
        const end = Math.min(file.size, input.offset + EXTENSION_MEDIA_CHUNK);
        const stream = await this.store.open(objectKey, { start: input.offset, end: end - 1 });
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        if (bytes.length !== end - input.offset) throw new ConflictException('Thiếu dữ liệu tệp đã lưu.');
        return { offset: input.offset, ...(input.fileIndex !== undefined && { fileIndex: input.fileIndex }), data: bytes.toString('base64') };
      }
      if (input.action === 'authorize') {
        if (input.uid !== binding.uid || !target.enabled || !['commit', 'comment-commit'].includes(command.action) || command.authorizedAt || command.result
          || !await commandIsCurrent(t, command, now)) {
          throw new ConflictException('Lệnh đăng không còn được phép thực thi.');
        }
        await t.extensionCommand.update({ where: { id: command.id }, data: { authorizedAt: now } });
        return { lifetimeMs: Math.min(5_000, command.expiresAt.getTime() - now.getTime()) };
      }
      if ((input.outcome === 'prepared' && (!['prepare', 'comment-prepare'].includes(command.action) || input.uid !== binding.uid))
        || (input.outcome === 'clicked' && (!['commit', 'comment-commit'].includes(command.action) || !command.authorizedAt || input.uid !== binding.uid))
        || (input.receipt && (!['commit', 'comment-commit'].includes(command.action) || input.outcome !== 'clicked'))
        || (input.verification && !input.receipt)
        || (input.issue && input.outcome !== 'blocked')) {
        throw new ConflictException('Kết quả không khớp với lệnh đã cấp.');
      }
      if (command.action === 'commit' && input.receipt && facebookPostLink(input.receipt.permalink)?.id !== input.receipt.externalId) {
        throw new ConflictException('Liên kết không trỏ đến bài vừa đăng.');
      }
      if (!command.result) await t.extensionCommand.update({ where: { id: command.id }, data: {
        result: { outcome: input.outcome, ...(input.receipt && { receipt: input.receipt }), ...(input.issue && { issue: input.issue }),
          ...(input.verification && { verification: input.verification }) },
      } });
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
