import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ConnectorError, type PublishConnector, type PublishSession, type TargetRef } from '@seedingsys/connectors-core';
import { EXTENSION_CONNECTOR, EXTENSION_FRESH_MS, EXTENSION_VERSION, type ExtensionCommentContext } from '@seedingsys/contracts';
import { json, type Db } from '@seedingsys/db';
import type { Clock } from '@seedingsys/domain';

export class ExtensionPublishConnector implements PublishConnector {
  readonly key = EXTENSION_CONNECTOR;
  readonly version = EXTENSION_VERSION;

  constructor(private readonly db: Db, private readonly clock: Clock) {}

  capabilities(target: TargetRef) {
    return { TEXT: target.audience === 'ONLY_ME' && /^\d{1,32}$/.test(target.externalId) };
  }

  async openSession(target: TargetRef): Promise<PublishSession> {
    const operation = target.operation;
    if (!operation || !this.capabilities(target).TEXT) throw new ConnectorError('UNSUPPORTED', 'Cần bài chữ, UID số và Chỉ mình tôi.');
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
    let draftCaption: string | undefined;
    const send = async (action: 'prepare' | 'commit' | 'comment-prepare' | 'comment-commit', caption: string, comment?: ExtensionCommentContext) => {
      const commits = action === 'commit' || action === 'comment-commit';
      const timeoutMs = action === 'comment-commit' ? 105_000 : commits ? 50_000 : 75_000;
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
        if (snapshot.contentType !== 'TEXT' || snapshot.audience !== 'ONLY_ME' || media.length || snapshot.media.length || !snapshot.caption.trim()) {
          throw new ConnectorError('UNSUPPORTED', 'Extension 1.0 chỉ nhận bài chữ ở chế độ Chỉ mình tôi.');
        }
        if ((await send('prepare', snapshot.caption)).outcome !== 'prepared') {
          throw new ConnectorError('UI_UNEXPECTED', 'Profile chưa xác nhận nội dung hoặc đối tượng xem của bản nháp.');
        }
        draftCaption = snapshot.caption;
        return { id: sessionId };
      },
      previewCheck: async (draft, expected) => {
        const ok = draft.id === sessionId && draftCaption === expected.caption && expected.mediaCount === 0;
        return { ok, audienceOk: expected.audience === 'ONLY_ME', problems: ok ? [] : ['EXTENSION_PREVIEW_MISMATCH'] };
      },
      commit: async draft => {
        if (draft.id !== sessionId || draftCaption === undefined) throw new ConnectorError('PREVIEW_MISMATCH', 'Bản nháp đã thay đổi.');
        if ((await send('commit', draftCaption)).outcome !== 'clicked') throw new ConnectorError('TRANSIENT', 'Cần đối soát kết quả của lệnh đăng.', true);
        return { raw: { submittedBy: EXTENSION_CONNECTOR } };
      },
      verify: async () => ({ kind: 'NOT_FOUND', conclusive: false }),
      discardDraft: async () => undefined,
      close: async () => undefined,
    };
  }
}
