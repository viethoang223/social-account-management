'use client';

import { useMemo, useState } from 'react';
import { ActionButton, bff, useSubmit } from '@/components/client';
import { Badge } from '@/components/ui';
import { fmtTime, reasonText } from '@/lib/format';
import type { CommentReplay, Destination, PostDetail, Revision, SourceComment } from './types';
import styles from './library.module.css';

const SCAN_LABEL = { QUEUED: 'Chờ quét', RUNNING: 'Đang quét bình luận', COMPLETE: 'Đã đọc hết phần truy cập được', PARTIAL: 'Đã lưu một phần', FAILED: 'Quét gián đoạn' };
const REPLAY_LABEL = { DRAFT: 'Nháp bình luận', APPROVED: 'Đã duyệt', QUEUED: 'Chờ worker', SENDING: 'Đang gửi', FAILED: 'Gửi thất bại',
  UNKNOWN: 'Chờ đối chiếu', POSTED: 'Đã ghi nhận đăng', OMITTED: 'Đã bỏ qua' };
const AUDIENCE: Record<string, string> = { ONLY_ME: 'Chỉ mình tôi', FRIENDS: 'Bạn bè', PUBLIC: 'Công khai' };
const SUCCESS = ['PUBLISHED_VERIFIED', 'OPERATOR_CONFIRMED'];

function PostPreview({ title, profile, caption, revision, link, type, footer }: {
  title: string; profile: string; caption: string; revision: Revision; link: string | null; type: string; footer?: string;
}) {
  const ready = revision.assets.filter(a => a.asset.status === 'STORED').length;
  return (
    <article className={styles.preview}>
      <header><div><small>{title}</small><strong>{profile}</strong></div><Badge s={type} /></header>
      {footer && <span className={styles.meta}>{footer}</span>}
      <p className={styles.caption}>{caption || <span className="muted">Bài không có caption</span>}</p>
      {revision.albumTitle && <p className="muted">Album {revision.albumTitle}</p>}
      {revision.assets.length > 0 && <div className={styles.media} data-single={revision.assets.length === 1 || undefined}>
        {revision.assets.map(({ position, asset }) => {
          const url = '/bff/assets/' + asset.id + '/content';
          if (asset.status !== 'STORED') return <div className={styles.placeholder} key={position}>{asset.kind === 'video' ? 'Video' : 'Ảnh'} {position + 1} chưa tải xong</div>;
          if (asset.kind === 'video') return <video key={position} src={url} controls preload="none" playsInline aria-label="Xem video của bài" />;
          return <a key={position} href={url} target="_blank" rel="noreferrer">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} loading="lazy" alt={`Ảnh ${position + 1} của bài`} />
          </a>;
        })}
      </div>}
      <div className={styles.previewBottom}>
        {revision.assets.length > 0 && <span>{ready}/{revision.assets.length} tệp đã lưu</span>}
        {link && <a href={link} target="_blank" rel="noreferrer">Mở trên Facebook ↗</a>}
      </div>
    </article>
  );
}

function DraftPreview({ postId, destination, canReview, canOperate }: { postId: string; destination: Destination; canReview: boolean; canOperate: boolean }) {
  const { variant: v, publication: p, target } = destination;
  const current = v?.caption ?? v?.revision.text ?? '';
  const [caption, setCaption] = useState(current);
  const [saved, setSaved] = useState(current);
  const [sharedLink, setSharedLink] = useState('');
  const [copiedShareCaption, setCopiedShareCaption] = useState(false);
  const submit = useSubmit();
  const changed = caption.trim() !== saved;
  const busy = !!p && !['FAILED_CONFIRMED', 'CANCELLED'].includes(p.status);
  const editing = !!v && !busy && (!v.expiresAt || Date.parse(v.expiresAt) > Date.now()) && ['NEEDS_REVIEW', 'READY'].includes(v.status);
  const postExists = !!p && SUCCESS.includes(p.status);
  if (!v) return <div className={styles.empty}>Chưa có bản đăng cho {target.code}.</div>;
  const share = v.revision.sharedPermalink;
  const mediaOk = ['READY', 'NOT_REQUIRED'].includes(v.revision.mediaStatus)
    && !v.revision.incomplete.some(f => f === 'MEDIA_UNAVAILABLE' || f === 'MEDIA_COUNT_UNKNOWN')
    && (!['VIDEO', 'REEL'].includes(v.contentType) || (v.revision.assets.length === 1 && v.revision.assets[0].asset.kind === 'video'))
    && v.revision.assets.every(({ asset }) => asset.status === 'STORED');
  const validCaption = v.contentType === 'REEL' || !!caption.trim();
  const approval = () => submit.run(() => bff('POST', `review/${v.id}/approve`, { caption: caption.trim() }), 'Đã duyệt để đăng');
  const save = () => submit.run(async () => {
    const result = v.status === 'READY'
      ? await bff('PATCH', `backlog/${v.id}`, { caption: caption.trim(), snapshotHash: v.snapshotHash })
      : await bff('PATCH', `review/${v.id}/caption`, { caption: caption.trim() });
    if (result.ok) setSaved(caption.trim());
    return result;
  });
  return (
    <div className={styles.destination}>
      <PostPreview title={postExists ? 'Bản đã đăng' : 'Xem trước khi đăng'} profile={`${target.code} · ${target.name}`}
        caption={caption} revision={v.revision} link={p?.permalink ?? null} type={v.contentType}
        footer={`${AUDIENCE[v.audience] ?? v.audience}${p?.verifiedAt ? ' · ' + fmtTime(p.verifiedAt) : ''}`} />
      <div className={styles.actionPanel}>
        <div><Badge s={busy ? p.status : v.status} />{!target.enabled && <> <Badge s="PAUSED" text="Đích đang tắt" /></>}</div>
        {p && !busy && p.lastReason && <p className="muted">Lượt đăng trước · {reasonText(p.lastReason)}</p>}
        {postExists && !p?.directLink && canOperate && <details>
          <summary>Thêm liên kết bài đã đăng trên {target.code}</summary>
          <label>Liên kết trực tiếp tới bài đích
            <input type="url" value={sharedLink} onChange={e => setSharedLink(e.target.value)} />
          </label>
          <button type="button" disabled={submit.pending || !sharedLink.trim()}
            onClick={() => submit.run(() => bff('PATCH', `library/posts/${postId}/destinations/${target.id}/permalink`, { permalink: sharedLink }),
              'Đã lưu liên kết bài đích')}>Lưu liên kết</button>
        </details>}
        {v.reviewReasons?.length > 0 && v.status === 'NEEDS_REVIEW' && <div className="muted">{v.reviewReasons.map(reasonText).join(' · ')}</div>}
        {share && !postExists && <a href={share} target="_blank" rel="noreferrer">Mở bài gốc để chia sẻ ↗</a>}
        {share && !postExists && v.revision.text && <button type="button" className="sm" onClick={() =>
          void navigator.clipboard.writeText(v.revision.text).then(() => setCopiedShareCaption(true)).catch(() => setCopiedShareCaption(false))}>
          {copiedShareCaption ? 'Đã sao chép caption gốc' : 'Sao chép caption nguồn'}
        </button>}
        {share && !p && canOperate && v.status === 'NEEDS_REVIEW' && <details>
          <summary>Ghi nhận đã chia sẻ trên {target.code}</summary>
          <label>Liên kết bài mới trên {target.code}
            <input type="url" value={sharedLink} onChange={e => setSharedLink(e.target.value)} />
          </label>
          <button type="button" disabled={submit.pending || !sharedLink.trim()}
            onClick={() => submit.run(() => bff('POST', `library/posts/${postId}/destinations/${target.id}/confirm-share`, { permalink: sharedLink }),
              'Đã ghi nhận bài chia sẻ')}>Ghi nhận bài chia sẻ</button>
        </details>}
        {canReview && editing && <>
          <label htmlFor={`preview-caption-${v.id}`}>Caption của {target.code}</label>
          <textarea id={`preview-caption-${v.id}`} value={caption} maxLength={5000} onChange={e => setCaption(e.target.value)} rows={4} />
          <div className={styles.actions}>
            <button type="button" disabled={submit.pending || !changed || !validCaption} onClick={save}>Lưu caption</button>
            {v.status === 'NEEDS_REVIEW' && !share && <button type="button" className="primary"
              disabled={submit.pending || !validCaption || !mediaOk || v.contentType === 'UNSUPPORTED'} onClick={approval}>Duyệt bài</button>}
          </div>
        </>}
        {canOperate && target.enabled && editing && v.status === 'READY' && !share &&
          <ActionButton path={`backlog/${v.id}/publish`} className="primary" disabled={changed || submit.pending}
            confirm={`Gửi ngay bài đã lưu tới ${target.code}?`}>Đăng ngay</ActionButton>}
        {submit.error && <p className="err" role="alert">{submit.error}</p>}
        {submit.done && <p className="okmsg" role="status">{submit.done}</p>}
      </div>
    </div>
  );
}

function orderComments(items: SourceComment[]) {
  const ids = new Set(items.map(c => c.externalId));
  const children = new Map<string, SourceComment[]>();
  for (const comment of items) {
    const parent = comment.parentExternalId && ids.has(comment.parentExternalId) ? comment.parentExternalId : '';
    const siblings = children.get(parent) ?? [];
    siblings.push(comment);
    children.set(parent, siblings);
  }
  const seen = new Set<string>();
  const lines: Array<{ comment: SourceComment; depth: number; missingParent: boolean }> = [];
  const walk = (root: SourceComment, depth: number, missingParent: boolean) => {
    const pending = [{ comment: root, depth, missingParent }];
    while (pending.length) {
      const node = pending.pop()!;
      if (seen.has(node.comment.externalId)) continue;
      seen.add(node.comment.externalId);
      lines.push(node);
      const nested = children.get(node.comment.externalId) ?? [];
      for (let i = nested.length - 1; i >= 0; i--) pending.push({ comment: nested[i], depth: node.depth + 1, missingParent: false });
    }
  };
  for (const comment of children.get('') ?? []) walk(comment, 0, !!comment.parentExternalId);
  for (const comment of items) if (!seen.has(comment.externalId)) walk(comment, 0, true);
  return lines;
}

function CommentDraft({ detail, comment, parent, composed, target, canReview, canOperate }: {
  detail: PostDetail; target: Destination; canReview: boolean; canOperate: boolean;
} & ({ comment: SourceComment; parent?: SourceComment; composed?: never }
  | { composed: { id: string; replay?: CommentReplay }; comment?: never; parent?: never })) {
  const replay = composed ? composed.replay : comment.replays.find(r => r.destinationId === target.target.id);
  const parentReplay = parent?.replays.find(r => r.destinationId === target.target.id);
  const legacyAuthors = detail.authors.filter(a => a.connector === 'fb-web');
  const listenerId = comment?.parentExternalId ? parentReplay?.authorTargetId : target.target.id;
  const roles = detail.approvedRoles.filter(role => role.listenerId === listenerId);
  const savedAuthor = replay?.personaApprovalId ? `role:${replay.personaApprovalId}`
    : replay?.authorTargetId ?? (roles.length === 1 ? `role:${roles[0].id}` : legacyAuthors.find(a => a.id === target.target.id)?.id ?? '');
  const savedText = replay?.text ?? comment?.text ?? '';
  const [edit, setEdit] = useState({ savedAuthor, savedText, author: savedAuthor, text: savedText });
  const currentEdit = edit.savedAuthor === savedAuthor && edit.savedText === savedText ? edit : undefined;
  const author = currentEdit?.author ?? savedAuthor;
  const text = currentEdit?.text ?? savedText;
  const [link, setLink] = useState('');
  const [copied, setCopied] = useState(false);
  const submit = useSubmit();
  const path = `library/posts/${detail.post.id}/destinations/${target.target.id}/${composed ? 'new-comments/' + composed.id : 'comments/' + comment.id}`;
  const publication = target.publication;
  // A reply may be sent while its parent is being sent: the worker waits for the parent first.
  const parentOnItsWay = parentReplay?.status === 'QUEUED' || parentReplay?.status === 'SENDING';
  const destinationLink = comment?.parentExternalId ? parentReplay?.permalink ?? (parentOnItsWay ? publication?.permalink : undefined) : publication?.permalink;
  const inFlight = replay?.status === 'QUEUED' || replay?.status === 'SENDING';
  const canHandoff = !!replay && ['APPROVED', 'FAILED', 'UNKNOWN'].includes(replay.status);
  const canPost = canHandoff && !!destinationLink && !!publication?.directLink && SUCCESS.includes(publication.status);
  const privatePost = (target.variant?.audience ?? target.target.audience) === 'ONLY_ME' && replay?.authorTargetId !== target.target.id
    && !(replay?.personaApprovalId && publication?.commentAccessConfirmed);
  const approvedRole = roles.find(role => `role:${role.id}` === author);
  const authorInput = approvedRole ? { personaApprovalId: approvedRole.id } : { authorTargetId: author };
  const selected = !!approvedRole || legacyAuthors.some(a => a.id === author);
  const dirty = author !== (replay?.personaApprovalId ? `role:${replay.personaApprovalId}` : replay?.authorTargetId) || text.trim() !== replay?.text;
  if (replay?.status === 'POSTED') return <p><a href={replay.permalink ?? '#'} target="_blank" rel="noreferrer">Xem bình luận đã ghi nhận trên {target.target.code} ↗</a></p>;
  return (
    <div className={styles.commentEditor}>
      {canReview && !inFlight && replay?.status !== 'UNKNOWN' && <>
        <label>Vai gửi bình luận
          <select value={author} onChange={e => setEdit({ savedAuthor, savedText, text, author: e.target.value })}>
            <option value="">Chọn vai hoặc profile</option>
            {roles.map(role => <option key={role.id} value={`role:${role.id}`}>{role.label}</option>)}
            {legacyAuthors.map(p => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
          </select>
        </label>
        {!roles.length && <p className="muted">Duyệt chiều xưng hô với {comment?.parentExternalId ? 'người gửi bình luận cha' : 'chủ bài đích'} trong <a href="/personas">Phân vai &amp; Radar</a>.</p>}
        <label>Nội dung bình luận<textarea rows={3} maxLength={4000} value={text}
          onChange={e => setEdit({ savedAuthor, savedText, author, text: e.target.value })} /></label>
        <div className={styles.actions}>
          <button type="button" disabled={submit.pending || !selected || !text.trim() || !dirty}
            onClick={() => submit.run(() => bff('PATCH', path, { action: 'draft', text, ...authorInput }))}>Lưu nháp</button>
          <button type="button" className="primary" disabled={submit.pending || !selected || !text.trim() || (replay?.status === 'APPROVED' && !dirty)}
            onClick={() => submit.run(() => bff('PATCH', path, { action: 'approve', text, ...authorInput }), 'Đã duyệt bình luận')}>Duyệt bình luận</button>
          {(!composed || replay) && <ActionButton method="PATCH" path={path} body={{ action: 'omit' }} disabled={replay?.status === 'OMITTED'}>Bỏ qua</ActionButton>}
        </div>
      </>}
      {replay?.sendDetail && <p className="muted" role="status">{replay.sendDetail}</p>}
      {canHandoff && (canReview || canOperate) && (canPost ? <div className={styles.commentHandoff}>
        {privatePost && <p className="muted">Bài đích ở chế độ Chỉ mình tôi. Hồ sơ khác không thể bình luận.</p>}
        {canOperate && !privatePost && replay.status !== 'UNKNOWN' && <ActionButton className="primary" method="PATCH" path={path} body={{ action: 'send' }}
          disabled={dirty || submit.pending} confirm={`Gửi bình luận bằng ${replay.author?.code ?? 'hồ sơ đã chọn'}?`}>
          {replay.status === 'FAILED' ? 'Gửi lại bình luận' : 'Gửi bình luận'}
        </ActionButton>}
        <p>Đối chiếu trên Facebook và dán liên kết bình luận để ghi nhận.</p>
        <textarea aria-label="Nội dung bình luận đã duyệt" value={replay.text} readOnly rows={3} />
        <div className={styles.actions}>
          <button type="button" onClick={() => void navigator.clipboard.writeText(replay.text).then(() => setCopied(true)).catch(() => setCopied(false))}>{copied ? 'Đã sao chép' : 'Sao chép nội dung'}</button>
          <a href={destinationLink!} target="_blank" rel="noreferrer">{parentReplay?.permalink ? 'Mở bình luận cha' : 'Mở bài đích'} ↗</a>
        </div>
        <label>Liên kết bình luận vừa đăng<input value={link} type="url" onChange={e => setLink(e.target.value)} /></label>
        <button type="button" disabled={submit.pending || !link.trim()}
          onClick={() => submit.run(() => bff('PATCH', path, { action: 'posted', permalink: link }), 'Đã ghi nhận đăng')}>Ghi nhận đã đăng</button>
        {canOperate && replay.status === 'UNKNOWN' && <ActionButton method="PATCH" path={path} body={{ action: 'confirmed_absent' }}
          disabled={submit.pending} confirm="Bạn đã mở đúng bài và đối chiếu trên Facebook rằng bình luận chưa xuất hiện?">
          Xác nhận chưa đăng
        </ActionButton>}
      </div> : <p className="muted">{!(publication && SUCCESS.includes(publication.status) && comment?.parentExternalId)
        ? 'Chờ bài đích đăng thành công và có liên kết Facebook.'
        : !parent ? 'Chưa quét được bình luận cha. Quét lại bình luận của bài nguồn trước khi đăng phản hồi này.'
        : parentReplay?.status === 'OMITTED' ? 'Bình luận cha đã được bỏ qua trên bài đích nên phản hồi này không có chỗ để đăng.'
        : 'Chờ ghi nhận bình luận cha trên bài đích.'}</p>)}
      {submit.error && <p className="err" role="alert">{submit.error}</p>}
      {submit.done && <p className="okmsg" role="status">{submit.done}</p>}
    </div>
  );
}

export function PostWorkspace({ detail, requestedTarget, canReview, canOperate, canArchive }: {
  detail: PostDetail; requestedTarget?: string; canReview: boolean; canOperate: boolean; canArchive: boolean;
}) {
  const { source, post, revision, scan, comments, destinations, instagramComments } = detail;
  const readingInstagram = instagramComments?.state === 'QUEUED' || instagramComments?.state === 'RUNNING';
  const instagramCommentLabels = {
    UNREAD: 'Bài Instagram này chưa được quét bình luận.',
    QUEUED: 'Đang chờ Chrome đọc bình luận Instagram.',
    RUNNING: 'Đang đọc bình luận Instagram.',
    READ: 'Đã lưu các bình luận Instagram đọc được.',
    EMPTY: 'Instagram báo bài này chưa có bình luận.',
    UNAVAILABLE: 'Chrome chưa đọc được bình luận từ phần Instagram hiển thị.',
    FAILED: 'Lượt đọc bình luận Instagram không hoàn tất.',
  };
  const [targetCode, setTargetCode] = useState(requestedTarget ?? destinations[0]?.target.code ?? '');
  const [selectedComment, setSelectedComment] = useState<string>();
  const [selectedComposed, setSelectedComposed] = useState<string>();
  const [visible, setVisible] = useState(40);
  const dest = destinations.find(d => d.target.code === targetCode) ?? destinations[0];
  const composed = detail.composedComments.filter(row => row.destinationId === dest?.target.id);
  const selectedDraft = composed.find(row => row.id === selectedComposed);
  const canCompose = canReview && !!dest?.publication?.directLink && SUCCESS.includes(dest.publication.status);
  const lines = useMemo(() => orderComments(comments), [comments]);
  const byId = useMemo(() => new Map(comments.map(c => [c.externalId, c])), [comments]);
  const running = scan?.status === 'RUNNING' || scan?.status === 'QUEUED';
  const totals = dest ? comments.reduce((result, comment) => {
    const replay = comment.replays.find(r => r.destinationId === dest.target.id);
    if (replay && ['APPROVED', 'QUEUED', 'SENDING'].includes(replay.status)) result.approved++;
    if (replay?.status === 'POSTED') result.posted++;
    return result;
  }, { approved: 0, posted: 0 }) : null;
  const sendable = dest ? comments.filter(c => ['APPROVED', 'FAILED'].includes(c.replays.find(r => r.destinationId === dest.target.id)?.status ?? '')).length : 0;
  const canSendAll = !!dest?.publication?.directLink && SUCCESS.includes(dest.publication.status) && sendable > 0;
  const sendAll = useSubmit();
  return (
    <>
      <div className={styles.comparisonHeading}>
        <h2>Đối chiếu bài {source.code}{dest ? ` → ${dest.target.code}` : ''}</h2>
        {canArchive && <ActionButton path={`library/posts/${post.id}/archive`} method="PATCH" body={{ archived: !post.archivedAt }}
          className={post.archivedAt ? '' : 'danger'}
          confirm={post.archivedAt ? 'Khôi phục bài về kho nguồn? Các bản duyệt có thể tiếp tục theo lịch hiện tại.'
            : `Chuyển bài khỏi kho ${source.code} vào thùng rác và dừng các lượt đăng đang chờ?`}>
          {post.archivedAt ? 'Khôi phục bài' : 'Xóa khỏi kho nguồn'}
        </ActionButton>}
        {destinations.length > 1 && <label>Profile đích <select value={dest?.target.code} onChange={e => { setTargetCode(e.target.value); setSelectedComment(undefined); setSelectedComposed(undefined); }}>
          {destinations.map(d => <option key={d.target.id} value={d.target.code}>{d.target.code} · {d.target.name}</option>)}
        </select></label>}
      </div>
      <div className={styles.comparison}>
        <PostPreview title="Bài nguồn" profile={`${source.code} · ${source.name}`} revision={revision} caption={revision.text}
          link={post.permalink} type={post.contentType} footer={fmtTime(post.postedAt ?? post.firstSeenAt)} />
        {dest ? <DraftPreview key={`${dest.target.id}:${dest.variant?.id}:${dest.variant?.snapshotHash ?? ''}:${dest.variant?.caption ?? ''}`}
          postId={post.id} destination={dest} canReview={canReview} canOperate={canOperate} /> : <div className={styles.empty}>Bài chưa có profile đích.</div>}
      </div>
      <section className={styles.thread}>
        <div className={styles.comparisonHeading}>
          <div><h2>Bình luận</h2><p className="muted">{comments.length} đã lưu{totals && dest && ` · ${totals.approved} chờ đăng · ${totals.posted} đã ghi nhận ở ${dest.target.code}`}</p></div>
          <div className={styles.actions}>
            {canCompose && <button type="button" className="primary" onClick={() => setSelectedComposed(crypto.randomUUID())}>Soạn bình luận mới</button>}
            {canOperate && dest?.publication?.extensionTarget && dest.publication.directLink && SUCCESS.includes(dest.publication.status) &&
              <ActionButton method="PATCH" path={`library/posts/${post.id}/destinations/${dest.target.id}/comment-access`}
                body={{ confirmed: !dest.publication.commentAccessConfirmed }}
                confirm={dest.publication.commentAccessConfirmed ? 'Dừng gửi bình luận từ UID khác vào bài này?'
                  : 'Bạn đã kiểm tra bài trực tiếp trên Facebook và các UID tham gia có quyền xem và bình luận?'} >
                {dest.publication.commentAccessConfirmed ? 'Gỡ xác nhận quyền bình luận' : 'Xác nhận UID khác có quyền bình luận'}
              </ActionButton>}
            {canOperate && dest && canSendAll && <button type="button" className="primary" disabled={sendAll.pending}
              onClick={() => {
                if (!window.confirm(`Gửi ${sendable} bình luận đã duyệt hoặc gửi lỗi lên bài của ${dest.target.code}? Bình luận gốc đi trước, phản hồi tự chờ bình luận cha.`)) return;
                sendAll.run(() => bff<{ queued: number; skipped: Array<{ text: string; reason: string }> }>('POST',
                  `library/posts/${post.id}/destinations/${dest.target.id}/comments/send`),
                  data => `Đã xếp ${data?.queued ?? 0} bình luận vào hàng gửi.` + (data?.skipped.length
                    ? ` Chưa gửi ${data.skipped.length}: ` + data.skipped.map(s => `"${s.text}" (${s.reason})`).join('; ') : ''));
              }}>Gửi tất cả đã duyệt ({sendable})</button>}
            {(canOperate || canReview) && detail.canScan && <ActionButton path={`library/posts/${post.id}/comments/scan`} disabled={running}>
              {scan ? 'Quét lại bình luận' : 'Quét bình luận'}
            </ActionButton>}
            {(canOperate || canReview) && instagramComments?.canScan && <ActionButton path="research" disabled={readingInstagram}
              body={{ url: instagramComments.url, limit: 20, saveCommentsTo: post.id }}>
              {instagramComments.state === 'UNREAD' ? 'Quét bình luận Instagram' : 'Quét lại bình luận Instagram'}
            </ActionButton>}
          </div>
        </div>
        {sendAll.error && <p className="err" role="alert">{sendAll.error}</p>}
        {sendAll.done && <p className="okmsg" role="status">{sendAll.done}</p>}
        {composed.length > 0 && <ol className={styles.commentList} aria-label="Bình luận soạn mới">
          {composed.map(row => <li key={row.id}>
            <header><strong>{row.author?.code ?? 'Bình luận mới'}</strong> <Badge s={row.status} text={REPLAY_LABEL[row.status]} /></header>
            <p>{row.text}</p>
            {row.permalink && row.status === 'POSTED'
              ? <a href={row.permalink} target="_blank" rel="noreferrer">Xem bình luận trên Facebook ↗</a>
              : (canReview || canOperate) && <button type="button" className="sm" aria-expanded={selectedComposed === row.id}
                onClick={() => setSelectedComposed(selectedComposed === row.id ? undefined : row.id)}>Xử lý bình luận</button>}
          </li>)}
        </ol>}
        {dest && selectedComposed && (selectedDraft || canCompose) && <CommentDraft key={selectedComposed}
          detail={detail} composed={{ id: selectedComposed, replay: selectedDraft }} target={dest} canReview={canReview} canOperate={canOperate} />}
        {!source.enabled && detail.canScan && <p className="muted">Nguồn đang tắt quét tự động. Bạn có thể quét bình luận của riêng bài này.</p>}
        {instagramComments && <p className="muted" role="status">{instagramCommentLabels[instagramComments.state]}
          {instagramComments.targetCode && ` · ${instagramComments.targetCode}`}{instagramComments.issue && ` · ${instagramComments.issue}`}</p>}
        {!detail.canScan && !scan && !instagramComments && <p className="muted">Kết nối của bài này chưa hỗ trợ quét bình luận.</p>}
        {scan && <div className={styles.progress} role="status">
          <strong>{SCAN_LABEL[scan.status]}</strong><span>{scan.readCount}{scan.expectedCount !== null ? `/${scan.expectedCount}` : ''} bình luận trong lượt này</span>
          {running && <progress aria-label="Tiến độ quét bình luận" max={scan.expectedCount || undefined} value={scan.expectedCount ? Math.min(scan.readCount, scan.expectedCount) : undefined} />}
          {scan.detail && <small>{scan.detail}</small>}
        </div>}
        {lines.length > 0 && <ol className={styles.commentList}>
          {lines.slice(0, visible).map(({ comment, depth, missingParent }) => {
            const replay = comment.replays.find(r => r.destinationId === dest?.target.id);
            return (
              <li key={comment.id} style={{ marginInlineStart: `${Math.min(depth, 6) * 1.2}rem` }}>
                <header><strong>{comment.authorName || 'Bình luận gốc'}</strong>
                  {depth > 0 && <small>Cấp {depth + 1}</small>}
                  {missingParent && <small>Chưa có bình luận cha</small>}
                  {comment.postedAt && <small>{fmtTime(comment.postedAt)}</small>}
                  {replay && <Badge s={replay.status} text={REPLAY_LABEL[replay.status]} />}
                  {replay?.author && <small>{replay.author.code}</small>}
                </header>
                <p>{comment.text || 'Không có nội dung chữ đọc được'}</p>
                <div className={styles.actions}>
                  {comment.permalink && <a href={comment.permalink} target="_blank" rel="noreferrer">Bình luận gốc ↗</a>}
                  {dest && (canReview || canOperate) && <button type="button" className="sm" aria-expanded={selectedComment === comment.id}
                    onClick={() => setSelectedComment(selectedComment === comment.id ? undefined : comment.id)}>{selectedComment === comment.id ? 'Thu gọn' : 'Xử lý cho ' + dest.target.code}</button>}
                </div>
                {dest && selectedComment === comment.id && <CommentDraft key={`${dest.target.id}:${comment.id}`} detail={detail} comment={comment}
                  parent={comment.parentExternalId ? byId.get(comment.parentExternalId) : undefined} target={dest} canReview={canReview} canOperate={canOperate} />}
              </li>
            );
          })}
        </ol>}
        {visible < lines.length && <button type="button" onClick={() => setVisible(visible + 40)}>Hiện thêm bình luận</button>}
      </section>
    </>
  );
}
