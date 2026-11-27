import { BadRequestException, Body, ConflictException, Controller, Get, Inject, Post, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { sniffMime } from '@seedingsys/connectors-manual';
import { EXTENSION_CONNECTOR, EXTENSION_FRESH_MS, FB_WEB_PUBLISH_FORMATS, type ComposeAccount, type ComposeReceipt, type ContentType } from '@seedingsys/contracts';
import { BacklogDispatchError, dispatchBacklogItemInTransaction, freezeSnapshot, ingestPost, SnapshotBlockedError, tx, type Db, type IngestPost } from '@seedingsys/db';
import { hashObject, removeAdvertisingLinks, sha256, type Clock } from '@seedingsys/domain';
import { assetObjectKey, type ObjectStore } from '@seedingsys/storage';
import { Roles, type Principal } from './auth';
import { dispatchMessage } from './ops.controller';
import { CLOCK, DB, STORE } from './tokens';
import { Actor, parse } from './util';

export const COMPOSE_SOURCE_REF = 'seedingsys:compose';
const maxFile = 120 * 1024 * 1024;
interface Upload { buffer: Buffer }
const input = z.object({
  id: z.string().uuid(), targetId: z.string().uuid(), text: z.string().trim().min(1).max(5000),
  audience: z.enum(['PUBLIC', 'ONLY_ME', 'FRIENDS']),
});

const accountQuery = {
  profile: { select: { workerNode: { select: { lastHeartbeatAt: true, capabilities: true } } } },
  extension: { select: { installationId: true } },
} as const;

@Controller('compose')
@Roles('operator')
export class ComposeController {
  constructor(@Inject(DB) private readonly db: Db, @Inject(CLOCK) private readonly clock: Clock,
    @Inject(STORE) private readonly store: ObjectStore) {}

  @Get('accounts')
  async accounts(): Promise<ComposeAccount[]> {
    const [targets, releases, checks] = await Promise.all([
      this.db.targetAccount.findMany({ include: accountQuery }),
      this.db.connectorRelease.findMany({ where: { active: true }, orderBy: { releasedAt: 'desc' }, distinct: ['connector'] }),
      this.db.capabilityCheck.findMany({ where: { passed: true }, select: { targetId: true, connector: true, connectorVersion: true, contentType: true } }),
    ]);
    const enabledFormats = (process.env.FB_ENABLED_FORMATS ?? '').toUpperCase().split(',').map(format => format.trim());
    const now = +this.clock.now();
    return targets.sort((a, b) => a.code.localeCompare(b.code, 'vi', { numeric: true })).map(target => {
      const { id, code, name, audience, connector } = target;
      const release = releases.find(row => row.connector === connector);
      const node = target.profile?.workerNode;
      const extension = connector === EXTENSION_CONNECTOR;
      const since = extension ? EXTENSION_FRESH_MS : 90_000;
      const caps = node?.capabilities as { publishProtocol?: number } | null | undefined;
      const certified = checks.filter(row => row.targetId === id && row.connector === connector && row.connectorVersion === release?.version).map(row => row.contentType);
      const formats = connector === 'fb-web'
        ? FB_WEB_PUBLISH_FORMATS.filter(format => enabledFormats.includes(format)) : certified;
      const supported = formats.filter(format => ['TEXT', 'SINGLE_PHOTO', 'MULTI_PHOTO', 'VIDEO'].includes(format) &&
        (!extension || format === 'TEXT'));
      const unavailable = !target.enabled ? 'Đang tắt'
        : extension && !target.extension?.installationId ? 'Chưa ghép Chrome'
        : !node?.lastHeartbeatAt || now - +node.lastHeartbeatAt > since ? 'Đang ngoại tuyến'
        : extension && audience === 'PUBLIC' && caps?.publishProtocol !== 2 ? 'Cần cập nhật extension để đăng công khai'
        : !release || !supported.length ? 'Chưa có định dạng đăng khả dụng' : null;
      return { id, code, name, audience, formats: supported, unavailable };
    });
  }

  @Post()
  @UseInterceptors(FilesInterceptor('media', 10, { limits: { fileSize: maxFile, files: 10, fields: 4 } }))
  async publish(@Body() body: unknown, @UploadedFiles() uploads: Upload[] | undefined, @Actor() actor: Principal): Promise<ComposeReceipt> {
    const d = parse(input, body);
    const caption = removeAdvertisingLinks(d.text).trim();
    if (!caption || caption !== d.text) throw new BadRequestException('Bỏ liên kết quảng cáo hoặc tham số theo dõi khỏi nội dung trước khi đăng.');
    const files = uploads ?? [];
    if (files.reduce((sum, file) => sum + file.buffer.length, 0) > maxFile) throw new BadRequestException('Tổng dung lượng tệp tối đa 120 MB.');
    const typed = files.map(({ buffer }) => ({ buffer, mime: sniffMime(buffer) }));
    if (typed.some(file => !file.mime)) throw new BadRequestException('Chọn tệp ảnh hoặc video hợp lệ.');
    const videos = typed.filter(file => file.mime?.startsWith('video/')).length;
    if (videos && files.length !== 1) throw new BadRequestException('Chọn một video hoặc một nhóm ảnh.');
    const contentType: ContentType = videos ? 'VIDEO' : files.length > 1 ? 'MULTI_PHOTO' : files.length === 1 ? 'SINGLE_PHOTO' : 'TEXT';
    const media: IngestPost['media'] = [];
    const checksums = typed.map(file => sha256(file.buffer));
    const requestHash = hashObject({ targetId: d.targetId, caption, audience: d.audience, checksums });
    for (const [index, file] of typed.entries()) {
      const mime = file.mime!;
      const checksum = checksums[index];
      const objectKey = assetObjectKey(checksum, mime);
      if (!(await this.store.exists(objectKey))) await this.store.put(objectKey, file.buffer, mime);
      media.push({ kind: mime.startsWith('video/') ? 'video' : 'image', mime, ref: 'supplied:' + checksum,
        stored: { bytes: file.buffer.length, checksum, objectKey } });
    }

    const dispatch = { db: this.db, clock: this.clock, actor: actor.actor };
    try {
      return await tx(this.db, async t => {
        await t.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${d.id}, 4178))`;
        const externalId = 'compose:' + d.id;
        const existing = await t.sourcePost.findFirst({ where: { externalId, source: { externalRef: COMPOSE_SOURCE_REF } },
          select: { latestRevisionId: true, publications: { select: { id: true, target: { select: { code: true } } } } } });
        if (existing) {
          const revision = existing.latestRevisionId && await t.sourcePostRevision.findUnique({
            where: { id: existing.latestRevisionId }, select: { raw: true },
          });
          if (!revision || (revision.raw as { requestHash?: string } | null)?.requestHash !== requestHash || !existing.publications[0]) {
            throw new ConflictException('Yêu cầu đăng này đã thay đổi. Mở Kho bài viết để kiểm tra.');
          }
          return { publicationId: existing.publications[0].id, targetCode: existing.publications[0].target.code };
        }
        let source = await t.source.findFirst({ where: { connector: 'manual', externalRef: COMPOSE_SOURCE_REF }, select: { id: true } });
        if (!source) {
          await t.$executeRaw`LOCK TABLE sources IN SHARE ROW EXCLUSIVE MODE`;
          source = await t.source.findFirst({ where: { connector: 'manual', externalRef: COMPOSE_SOURCE_REF }, select: { id: true } });
          if (!source) {
            const used = new Set((await t.source.findMany({ select: { code: true } })).map(row => row.code));
            let n = 1;
            while (used.has('N' + n)) n++;
            source = await t.source.create({ data: { code: 'N' + n, name: 'Bài tự soạn', connector: 'manual',
              externalRef: COMPOSE_SOURCE_REF, enabled: false }, select: { id: true } });
          }
        }
        await t.$queryRaw`SELECT id FROM target_accounts WHERE id=${d.targetId}::uuid FOR UPDATE`;
        const target = await t.targetAccount.findUnique({ where: { id: d.targetId }, include: accountQuery });
        if (!target) throw new ConflictException('Không tìm thấy tài khoản đăng.');
        if (target.audience !== d.audience) throw new ConflictException('Đối tượng xem vừa thay đổi. Tải lại màn đăng bài.');
        if (target.connector === EXTENSION_CONNECTOR && (!target.extension?.installationId || contentType !== 'TEXT')) {
          throw new ConflictException(contentType !== 'TEXT' ? 'Extension của tài khoản này hiện chỉ đăng bài chữ.' : 'Tài khoản chưa ghép Chrome.');
        }
        const caps = target.profile?.workerNode?.capabilities as { publishProtocol?: number } | null | undefined;
        if (target.connector === EXTENSION_CONNECTOR && target.audience === 'PUBLIC' && caps?.publishProtocol !== 2) {
          throw new ConflictException('Cần cập nhật extension để đăng công khai.');
        }
        if (target.connector === 'fb-web' && !(process.env.FB_ENABLED_FORMATS ?? '').toUpperCase().split(',').map(x => x.trim()).includes(contentType)) {
          throw new ConflictException('Cách đăng hiện tại chưa bật định dạng này.');
        }
        await t.sourceTargetMapping.upsert({ where: { sourceId_targetId: { sourceId: source.id, targetId: target.id } },
          update: {}, create: { sourceId: source.id, targetId: target.id, reviewMode: 'MANUAL' } });
        const now = this.clock.now();
        await ingestPost(t, { sourceId: source.id, connector: 'manual', baseline: false, archiveOnly: true, actor: actor.actor, now,
          post: { externalId, identityConfidence: 'HIGH', contentType, text: caption, isPinned: false, isShared: false, incomplete: [],
            postedAt: now, media, raw: { origin: 'seedingSysCompose', requestHash } } });
        const post = await t.sourcePost.findUniqueOrThrow({ where: { sourceId_externalId: { sourceId: source.id, externalId } } });
        const variant = await t.contentVariant.create({ data: { sourcePostId: post.id, revisionId: post.latestRevisionId!,
          targetId: target.id, contentType, status: 'NEEDS_REVIEW', caption } });
        if (!await freezeSnapshot(t, { variantId: variant.id, from: 'NEEDS_REVIEW', caption, now,
          actor: actor.actor, reviewedBy: actor.actor })) throw new ConflictException('Không chuẩn bị được bài này để đăng.');
        const publicationId = await dispatchBacklogItemInTransaction(t, dispatch, variant.id);
        return { publicationId, targetCode: target.code };
      });
    } catch (error) {
      if (error instanceof SnapshotBlockedError) throw new ConflictException(error.message);
      if (error instanceof BacklogDispatchError) throw new ConflictException(dispatchMessage(error.reason));
      throw error;
    }
  }
}
