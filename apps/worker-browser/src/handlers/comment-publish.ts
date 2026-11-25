import { isConnectorError, type PublishSession } from '@seedingsys/connectors-core';
import { COMMENT_PUBLISH_RETRIES, COMMENT_QUEUE_MS, EXTENSION_CONNECTOR, EXTENSION_FRESH_MS, SUCCESS, type PublishSnapshot } from '@seedingsys/contracts';
import { accountResource, acquireLease, activeKillSwitch, assertLeaseHeld, audit, commentListener, personaCommentAuthor, releaseLease, tx, type Tx } from '@seedingsys/db';
import { commentReplayBody, facebookCommentId, facebookPostId, facebookPostLink, facebookUrl, RetryLaterError } from '@seedingsys/domain';
import type { BrowserCtx } from '../ctx';

export async function handleCommentPublish(ctx: BrowserCtx, { replayId, sendVersion }: { replayId: string; sendVersion: number }, retryCount = 0) {
  const where = { id: replayId, sendVersion };
  const replay = await ctx.db.publicationComment.findFirst({ where: { ...where, status: 'QUEUED' }, include: {
    author: { include: { profile: { include: { workerNode: true } } } },
    source: { include: { post: true } },
  } });
  if (!replay) return;
  const { author, source, destinationId } = replay;
  const expiresAt = +replay.updatedAt + COMMENT_QUEUE_MS;
  let session: PublishSession | undefined;
  let lease: Awaited<ReturnType<typeof acquireLease>> = null;
  let started = false;
  try {
    if (+ctx.clock.now() >= expiresAt) throw new Error('Hết thời gian chờ worker. Có thể gửi lại.');
    if (author?.connector === 'fb-web' && author.profile?.workerNode && author.profile.workerNode.name !== ctx.actor) {
      throw new RetryLaterError('Chờ worker quản lý hồ sơ bình luận.');
    }
    if (!author?.enabled || !['fb-web', EXTENSION_CONNECTOR].includes(author.connector) || !author.profile || source.post.archivedAt) {
      throw new Error('Bài nguồn hoặc hồ sơ đăng bình luận hiện không khả dụng.');
    }
    const remote = author.connector === EXTENSION_CONNECTOR;
    if (remote) {
      const listener = await commentListener(ctx.db, destinationId, source);
      const approved = listener && replay.personaApprovalId && await personaCommentAuthor(ctx.db, replay.personaApprovalId, listener);
      if (!approved || approved.id !== author.id) throw new Error('UID hiện tại không khớp vai đã duyệt.');
      const node = author.profile.workerNode;
      if (!node?.lastHeartbeatAt || +ctx.clock.now() - +node.lastHeartbeatAt > EXTENSION_FRESH_MS
        || (node.capabilities as { commentProtocol?: number } | null)?.commentProtocol !== 1) {
        throw new RetryLaterError('Chờ đúng Chrome profile với extension hỗ trợ bình luận.');
      }
    }
    const publication = await ctx.db.publication.findUnique({ where: { targetId_sourcePostId: { targetId: destinationId, sourcePostId: source.sourcePostId } },
      include: { target: true, variant: { select: { snapshot: true } } } });
    const destination = facebookPostLink(publication?.permalink);
    if (!destination || !publication || !SUCCESS.includes(publication.status) || !publication.target.enabled) {
      throw new Error('Bài đích chưa được xác nhận hoặc không còn khả dụng.');
    }
    const { url: post, id: postId } = destination;
    if (remote) post.hostname = 'www.facebook.com';
    const snapshot = publication.variant.snapshot as unknown as PublishSnapshot | null;
    if (author.id !== destinationId && (snapshot?.audience ?? publication.target.audience) === 'ONLY_ME'
      && !(remote && publication.commentAccessConfirmedAt)) {
      throw new Error('Bài đích ở chế độ Chỉ mình tôi. Hồ sơ khác không thể bình luận.');
    }
    const parent = source.parentExternalId ? await ctx.db.publicationComment.findFirst({
      where: { destinationId, source: { externalId: source.parentExternalId, sourcePostId: source.sourcePostId } },
    }) : null;
    // Sent together with its parent: wait (through queue retries) until the parent is on the destination post.
    if (parent && (parent.status === 'QUEUED' || parent.status === 'SENDING')) throw new RetryLaterError('Chờ bình luận cha đăng xong.');
    if (source.parentExternalId && parent?.status !== 'POSTED') {
      throw new Error(parent?.status === 'OMITTED' ? 'Bình luận cha đã được bỏ qua trên bài đích nên phản hồi này không có chỗ để đăng.'
        : 'Bình luận cha chưa đăng được trên bài đích. Gửi lại bình luận cha trước.');
    }
    const parentUrl = parent ? facebookUrl(parent.permalink) : null;
    // A parent recorded from a pasted link may carry encoded ids; the connector's receipt uses digits.
    const parentId = facebookCommentId(parentUrl?.searchParams.get('reply_comment_id') ?? parentUrl?.searchParams.get('comment_id')) ?? undefined;
    const parentRootId = facebookCommentId(parentUrl?.searchParams.get('comment_id'));
    if (source.parentExternalId && (!parentId || !parentRootId || !parentUrl || facebookPostId(parentUrl) !== postId)) {
      throw new Error('Chờ bình luận cha được đăng và có liên kết trên bài đích.');
    }
    const paused = (db: Tx = ctx.db) => Promise.all([...new Set([author.id, destinationId])].map(targetId =>
      activeKillSwitch(db, { sourceId: source.post.sourceId, targetId, connector: author.connector }))).then(results => results.some(Boolean));
    if (await paused()) throw new Error('Đang tạm dừng đăng trên hồ sơ Facebook.');
    lease = await acquireLease(ctx.db, { resource: accountResource(author.id), holder: ctx.workerId + ':comment-publish',
      ttlMs: 240_000, now: ctx.clock.now(), purpose: 'comment-publish' });
    if (!lease) throw new RetryLaterError('Hồ sơ đang bận. Bình luận sẽ chờ.');
    const connector = ctx.registry.publisher(author.connector);
    session = await connector.openSession({ ...author, profileDir: author.profile.profileDir, ...(remote && {
      operation: { publicationId: publication.id, fencingToken: lease.token, comment: { replayId, sendVersion } },
    }) });
    if (!session.postComment || await session.sessionState() !== 'OK' || !(await session.checkIdentity(author.externalId)).ok) {
      throw new Error('Hồ sơ Facebook chưa sẵn sàng hoặc đang đăng nhập sai tài khoản.');
    }
    if (parentRootId) {
      post.searchParams.set('comment_id', parentRootId);
      if (parentId && parentId !== parentRootId) post.searchParams.set('reply_comment_id', parentId);
    }
    const text = commentReplayBody(replay.text, source.text);
    if (!text) throw new Error('Bình luận trống sau khi bỏ nhãn tác giả.');
    const result = await session.postComment({ post, parentId, text }, async () => {
      await tx(ctx.db, async t => {
        const [current] = await t.$queryRaw<Array<{ archived_at: Date | null }>>`SELECT archived_at FROM source_posts WHERE id=${source.sourcePostId}::uuid FOR SHARE`;
        const now = ctx.clock.now();
        if (+now >= expiresAt || !current || current.archived_at || !await assertLeaseHeld(t, lease!, now, 30_000)) {
          throw new Error('Bài nguồn hoặc phiên đăng không còn hiệu lực.');
        }
        if (await paused(t)) throw new Error('Đăng bình luận vừa được tạm dừng.');
        const valid = await t.publication.findFirst({ where: { id: publication.id, permalink: publication.permalink,
          commentAccessConfirmedAt: publication.commentAccessConfirmedAt,
          status: { in: [...SUCCESS] }, target: { enabled: true } }, select: { id: true } });
        const authorReady = await t.targetAccount.findFirst({ where: { id: author.id, enabled: true, connector: author.connector,
          externalId: author.externalId, profile: { is: { id: author.profile!.id, profileDir: author.profile!.profileDir,
            workerNodeId: author.profile!.workerNodeId } } }, select: { id: true } });
        if (!valid || !authorReady) throw new Error('Bài đích hoặc hồ sơ đăng vừa thay đổi.');
        const changed = await t.publicationComment.updateMany({ where: { ...where, status: 'QUEUED' }, data: {
          status: 'SENDING', text, updatedAt: now,
        } });
        if (!changed.count) throw new Error('Lượt gửi đã thay đổi.');
      });
      started = true;
    });
    const receipt = facebookUrl(result?.permalink);
    const receiptRoot = facebookCommentId(receipt?.searchParams.get('comment_id'));
    const receiptReply = facebookCommentId(receipt?.searchParams.get('reply_comment_id'));
    if (!started || !result || !receipt || facebookPostId(receipt) !== postId || !/^[A-Za-z0-9_:-]{1,150}$/.test(result.externalId) ||
      !receiptRoot || (receiptReply ?? receiptRoot) !== facebookCommentId(result.externalId) ||
      (parentRootId ? receiptRoot !== parentRootId || !receiptReply || receiptReply === parentId : !!receiptReply)) {
      throw new Error('Chưa xác minh được liên kết bình luận.');
    }
    await tx(ctx.db, async t => {
      const changed = await t.publicationComment.updateMany({ where: { ...where, status: 'SENDING' },
        data: { status: 'POSTED', ...result, sendDetail: null, updatedAt: ctx.clock.now() } });
      if (changed.count) await audit(t, { entityType: 'source_post', entityId: source.sourcePostId, actor: ctx.actor,
        action: 'comment_published', at: ctx.clock.now(), data: { replayId, authorTargetId: author.id, destinationId } });
    });
  } catch (err) {
    if (!started && err instanceof RetryLaterError && retryCount < COMMENT_PUBLISH_RETRIES) throw err;
    const uncertain = started || (isConnectorError(err) && err.sideEffectPossible);
    const detail = uncertain ? 'Chưa xác minh được kết quả. Mở bài đích để đối chiếu và ghi nhận liên kết.'
      : (err instanceof Error ? err.message : 'Không chuẩn bị được bình luận.').slice(0, 350);
    await ctx.db.publicationComment.updateMany({ where: { ...where, status: started ? 'SENDING' : 'QUEUED' },
      data: { status: uncertain ? 'UNKNOWN' : 'FAILED', sendDetail: detail, updatedAt: ctx.clock.now() } });
  } finally {
    try {
      await session?.close();
    } finally {
      if (lease) await releaseLease(ctx.db, lease, ctx.clock.now());
    }
  }
}
