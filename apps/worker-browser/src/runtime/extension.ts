import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ConnectorError, type PublishConnector, type PublishSession, type TargetRef } from '@seedingsys/connectors-core';
import { EXTENSION_CONNECTOR, EXTENSION_FRESH_MS, EXTENSION_VERSION, extensionMediaProtocol, isExtensionMediaFormat, isExtensionPublishAudience, validExtensionMedia, type ExtensionCommentContext } from '@seedingsys/contracts';
import { json, type Db } from '@seedingsys/db';
import { facebookPostLink, type Clock } from '@seedingsys/domain';

export class ExtensionPublishConnector implements PublishConnector {
  readonly key = EXTENSION_CONNECTOR;
  readonly version = EXTENSION_VERSION;

  constructor(private readonly db: Db, private readonly clock: Clock) {}

  capabilities(target: TargetRef) {
    const compatible = isExtensionPublishAudience(target.audience) && /^\d{1,32}$/.test(target.externalId);
    return { TEXT: compatible, SINGLE_PHOTO: compatible, MULTI_PHOTO: compatible, MEDIA_ALBUM: compatible, VIDEO: compatible, REEL: compatible };
  }

  async openSession(target: TargetRef): Promise<PublishSession> {
    const operation = target.operation;
    if (!operation || !this.capabilities(target).TEXT) throw new ConnectorError('UNSUPPORTED', 'Cần bài chữ, UID số và đối tượng xem được extension hỗ trợ.');
    const binding = await this.db.extensionBinding.findUnique({
      where: { targetId: target.id },
      include: { target: { include: { profile: { include: { workerNode: true } } } } },
    });
    const heardAt = binding?.target.profile?.workerNode?.lastHeartbeatAt;
    if (!binding?.installationId || binding.uid !== target.externalId || !heardAt
      || this.clock.now().getTime() - heardAt.getTime() > EXTENSION_FRESH_MS) {
      throw new ConnectorError('TRANSIENT', 'Profile chưa kết nối hoặc đã ngắt kết nối.');
    }

    const sessionId = randomUUID();
    const protocols = binding.target.profile?.workerNode?.capabilities as { publishProtocol?: number; publishMediaProtocol?: number } | null;
    const postProtocol = protocols?.publishProtocol;
    let draftCaption: string | undefined;
    let draftMediaCount = 0;
    const send = async (action: 'prepare' | 'commit' | 'comment-prepare' | 'comment-commit', caption: string, comment?: ExtensionCommentContext) => {
      const commits = action === 'commit' || action === 'comment-commit';
      const timeoutMs = action === 'comment-commit' || (action === 'commit' && postProtocol === 2) ? 105_000 : commits ? 50_000 : 75_000;
      const command = await this.db.extensionCommand.create({
        data: { targetId: target.id, publicationId: operation.publicationId, fencingToken: operation.fencingToken, sessionId,
          action, caption, ...(comment && { comment: json(comment) }), expiresAt: new Date(this.clock.now().getTime() + timeoutMs) },
        select: { id: true },
      });
      const deadline = Date.now() + timeoutMs;
      try {
        while (Date.now() < deadline) {
          const current = await this.db.extensionCommand.findUnique({ where: { id: command.id }, select: { result: true } });
          const result = current?.result as { outcome?: string; issue?: string; receipt?: { externalId: string; permalink: string } } | null | undefined;
          if (result?.outcome) return result;
          await delay(350);
        }
        throw new ConnectorError('TRANSIENT', 'Profile không trả kết quả đúng hạn.', commits);
      } finally {
        await this.db.extensionCommand.updateMany({
          where: { id: command.id }, data: { expiresAt: this.clock.now(), caption: '' },
        });
      }
    };

    return {
      sessionState: async () => 'OK',
      checkIdentity: async expected => ({ ok: binding.uid === expected, observed: binding.uid }),
      postComment: async ({ post, parentId, text }, beforeSubmit) => {
        if (!operation.comment) throw new ConnectorError('UNSUPPORTED', 'Thiếu lượt bình luận đã duyệt.');
        const comment = { ...operation.comment, postUrl: post.href, parentId };
        const prepared = await send('comment-prepare', text, comment);
        if (prepared.outcome !== 'prepared') {
          throw new ConnectorError('UI_UNEXPECTED', prepared.issue ?? 'Extension không xác nhận được đúng ô bình luận.');
        }
        await beforeSubmit();
        const result = await send('comment-commit', text, comment);
        return result.outcome === 'clicked' ? result.receipt ?? null : null;
      },
      prepare: async (snapshot, media) => {
        const format = snapshot.contentType;
        const validMedia = isExtensionMediaFormat(format) && (protocols?.publishMediaProtocol ?? 0) >= extensionMediaProtocol(format)
          && media.length === snapshot.media.length && validExtensionMedia(format, snapshot.media);
        if (snapshot.audience !== target.audience || (snapshot.contentType === 'TEXT'
          ? !!(media.length || snapshot.media.length || !snapshot.caption.trim()) : !validMedia)) {
          throw new ConnectorError('UNSUPPORTED', 'Định dạng, tệp hoặc đối tượng xem không khớp với Chrome profile đang kết nối.');
        }
        if (snapshot.audience === 'PUBLIC' && postProtocol !== 2) {
          throw new ConnectorError('UNSUPPORTED', 'Tải lại extension hỗ trợ đăng công khai trong Chrome profile này.');
        }
        const prepared = await send('prepare', snapshot.caption);
        if (prepared.outcome !== 'prepared') {
          throw new ConnectorError('UI_UNEXPECTED', prepared.issue ?? 'Profile chưa xác nhận nội dung hoặc đối tượng xem của bản nháp.');
        }
        draftCaption = snapshot.caption;
        draftMediaCount = snapshot.media.length;
        return { id: sessionId };
      },
      previewCheck: async (draft, expected) => {
        const ok = draft.id === sessionId && draftCaption === expected.caption && expected.mediaCount === draftMediaCount;
        return { ok, audienceOk: expected.audience === target.audience, problems: ok ? [] : ['EXTENSION_PREVIEW_MISMATCH'] };
      },
      commit: async draft => {
        if (draft.id !== sessionId || draftCaption === undefined) throw new ConnectorError('PREVIEW_MISMATCH', 'Bản nháp đã thay đổi.');
        const result = await send('commit', draftCaption);
        if (result.outcome !== 'clicked') throw new ConnectorError('TRANSIENT', result.issue ?? 'Cần đối soát kết quả của lệnh đăng.', true);
        return { raw: { submittedBy: EXTENSION_CONNECTOR },
          ...(result.receipt && { permalink: result.receipt.permalink, externalPostId: result.receipt.externalId }) };
      },
      verify: async ({ commitSignal }) => {
        const post = facebookPostLink(commitSignal?.permalink);
        if (post && post.id === commitSignal?.externalPostId) {
          return { kind: 'VERIFIED', permalink: post.url.href, externalPostId: post.id, evidence: { method: 'extension-timeline' } };
        }
        return { kind: 'NOT_FOUND', conclusive: false };
      },
      discardDraft: async () => undefined,
      close: async () => undefined,
    };
  }
}
