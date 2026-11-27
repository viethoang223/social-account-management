'use client';

import Link from 'next/link';
import { useState } from 'react';
import { instagramSourceLink, researchIssueText, researchLimitFor, type ResearchReport, type ResearchWorkspace as Data } from '@seedingsys/contracts';
import { ActionButton, AutoRefresh, bff, useSubmit } from '@/components/client';
import { Badge } from '@/components/ui';
import { fmtTime } from '@/lib/format';
import styles from './research.module.css';

const states: Record<string, string> = {
  QUEUED: 'Chờ profile', RUNNING: 'Đang đọc', WAITING_PROFILE: 'Chờ Chrome tiếp tục', COMPLETE: 'Hoàn tất',
  FAILED: 'Không đọc được', EXPIRED: 'Hết thời gian', CANCELLED: 'Đã dừng',
};
const external = { target: '_blank', rel: 'noreferrer' } as const;
const queue = (url: string, limit: number, targetCode?: string) => bff<{ targetCode: string }>('POST', 'research', { url, limit, targetCode });
const assigned = (data?: { targetCode: string }) => `Đã giao cho ${data?.targetCode ?? 'profile đang online'}.`;
const active = new Set(['QUEUED', 'RUNNING', 'WAITING_PROFILE']);

function instagramStatus(profile: Data['profiles'][number]) {
  if (!profile.online) return 'Chrome ngoại tuyến';
  if (!profile.instagramPermission) return 'Chưa cấp quyền đọc Instagram';
  if (profile.instagramLoggedIn === null) return 'Extension chưa báo tình trạng đăng nhập';
  if (!profile.instagramLoggedIn) return 'Cần đăng nhập Instagram';
  if (!profile.enabled) return 'Có phiên Instagram · tài khoản đang tắt';
  if (!profile.canReadInstagramProfile) return 'Có phiên Instagram · cần cập nhật extension để tìm trên profile';
  return 'Có phiên đăng nhập Instagram · sẵn sàng';
}

function ExportResult({ result, id }: { result: ResearchReport; id: string }) {
  const download = () => {
    const blob = new Blob([JSON.stringify({ schema: 'seedingsys.post-research/1', ...result }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `post-research-${id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <button type="button" onClick={download}>Tải JSON</button>;
}

function ImportResult({ result, id, sources, ownerCode, canOperate }: {
  result: Extract<ResearchReport, { kind: 'RESEARCH_POST' }>; id: string; sources: Data['sources'];
  ownerCode: string | null; canOperate: boolean;
}) {
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? '');
  const [textOnly, setTextOnly] = useState(false);
  const [useExisting, setUseExisting] = useState(false);
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [postHref, setPostHref] = useState('');
  const submit = useSubmit();
  if (!sources.length) return <p className="muted">Thêm nguồn nhập tay đang bật để lưu vào Kho bài viết.</p>;
  const instagram = result.instagramMedia !== undefined;
  const videos = result.instagramMedia?.filter(item => item.kind === 'video').length ?? 0;
  const mediaReady = !!result.instagramMedia?.length && !result.mediaPartial && (!videos || result.instagramMedia.length === 1);
  const ready = instagram ? rightsConfirmed && !result.captionPartial
    && (textOnly ? !!result.body : mediaReady)
    : !!(useExisting || (result.body && !result.captionPartial)) && (!result.hasMedia || textOnly);
  return <form className={styles.importForm} onSubmit={event => {
    event.preventDefault();
    setPostHref('');
    submit.run(async () => {
      const response = await bff<{ postId: string; sourceCode: string; ownerCode: string | null; comments: number }>('POST',
        `research/${id}/import`, { sourceId, textOnly, useExisting, ...(instagram && { rightsConfirmed }) });
      if (response.ok) {
        const { sourceCode, postId, ownerCode: owner } = response.data;
        setPostHref('/library?' + new URLSearchParams({ profile: sourceCode, post: postId, ...(owner && { to: owner }) }));
      }
      return response;
    }, data => instagram ? 'Đã đưa bài Instagram vào kho. Media sẽ được tải trước khi có thể đăng.'
      : `Đã lưu bài và ${data?.comments ?? 0} bình luận nguồn.`);
  }}>
    <label>Nguồn trong Kho bài viết<select value={sourceId} onChange={e => setSourceId(e.target.value)}>
      {sources.map(source => <option key={source.id} value={source.id}>{source.code} · {source.name}</option>)}
    </select></label>
    {result.hasMedia && <label className={styles.check}><input type="checkbox" checked={textOnly} onChange={e => setTextOnly(e.target.checked)} />
      {instagram ? 'Chỉ nhập caption vào luồng Facebook' : 'Lưu caption và bình luận dạng chữ'}</label>}
    {instagram && <label className={styles.check}><input type="checkbox" checked={rightsConfirmed} onChange={e => setRightsConfirmed(e.target.checked)} />
      Tôi có quyền sử dụng lại nội dung này trên Facebook.</label>}
    {canOperate && ownerCode && <label className={styles.check}><input type="checkbox" checked={useExisting} onChange={e => setUseExisting(e.target.checked)} />
      Gắn link này làm bài đích đã đăng của {ownerCode}</label>}
    {instagram && !textOnly && !mediaReady && <p className="muted">Cần đủ ảnh, hoặc một tệp video. Album trộn ảnh và video cần tách thành các bài riêng.</p>}
    {!instagram && !ready && !(result.hasMedia && !textOnly) && <p className="muted">Cần caption đầy đủ hoặc UID chủ bài đã ghép để gắn bài đích.</p>}
    <div><button disabled={submit.pending || !sourceId || !ready}>{instagram ? 'Đưa vào kho và luồng đã chọn' : 'Lưu vào Kho bài viết'}</button></div>
    {submit.error && <p className="err" role="alert">{submit.error}</p>}
    {submit.done && <p className="okmsg" role="status">{submit.done} {postHref && <Link href={postHref}>Mở bài trong kho</Link>}</p>}
  </form>;
}

function InstagramBatch({ job, sources, destinations }: {
  job: Data['jobs'][number]; sources: Data['sources']; destinations: Data['destinations'];
}) {
  const batch = job.batch;
  const [destinationUid, setDestinationUid] = useState(batch?.destination?.uid ?? '');
  const defaultSource = sources.find(source => source.code === batch?.importSourceCode || (!batch?.importSourceCode && source.code === 'N22'));
  const [sourceId, setSourceId] = useState(defaultSource?.id ?? sources[0]?.id ?? '');
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [libraryHref, setLibraryHref] = useState('');
  const submit = useSubmit();
  const save = useSubmit();
  const prepare = () => submit.run(() => bff<{ total: number }>('POST', `research/${job.id}/read-posts`, { destinationUid: destinationUid || undefined }),
    data => `Đã xếp lô ${data?.total ?? 0} bài Instagram.`);
  const posts = new Map(batch?.posts.map(post => [post.url, post]));
  return <>
    <div className={styles.actions}>
      <label>Tài khoản Facebook đích<select value={destinationUid} onChange={event => setDestinationUid(event.target.value)}>
        <option value="">Chọn sau</option>
        {destinations.map(destination => <option key={destination.code} value={destination.uid}>{destination.code} · {destination.name}</option>)}
      </select></label>
      {(!batch || (destinationUid && destinationUid !== batch.destination?.uid)) && <button type="button" disabled={submit.pending} onClick={prepare}>
        {batch ? 'Lưu tài khoản đích' : 'Đọc caption và media cả lô'}
      </button>}
      {!!batch && batch.failed + batch.incomplete > 0 && <button type="button" disabled={submit.pending} onClick={prepare}>Đọc lại bài lỗi hoặc còn thiếu</button>}
    </div>
    {batch?.destination && <p className="muted">Đích đã chọn {batch.destination.code || batch.destination.uid} {batch.destination.name && `· ${batch.destination.name}`}</p>}
    {batch && <p className="muted">Đã đọc {batch.complete}/{batch.total} bài · {batch.ready} bài có đủ nội dung
      {batch.running > 0 && ` · ${batch.running} đang đọc`}{batch.queued > 0 && ` · ${batch.queued} chờ`}
      {batch.incomplete > 0 && ` · ${batch.incomplete} còn thiếu`}{batch.failed > 0 && ` · ${batch.failed} lượt lỗi`}</p>}
    {submit.error && <p className="err" role="alert">{submit.error}</p>}
    {submit.done && <p className="okmsg" role="status">{submit.done}</p>}
    {batch?.importSourceCode && <p className="muted">Tự lưu bài đọc đủ vào Kho bài viết · {batch.importSourceCode}</p>}
    {!!(batch?.destination && sources.length) && <form className={styles.importForm} onSubmit={event => {
      event.preventDefault();
      save.run(async () => {
        const response = await bff<{ saved: number; skipped: string[]; sourceCode: string }>('POST',
          `research/${job.id}/import-posts`, { sourceId, rightsConfirmed });
        if (response.ok) setLibraryHref('/library?' + new URLSearchParams({ profile: response.data.sourceCode }));
        return response;
      }, data => `Đã bật tự lưu. Kho đã nhận ${data?.saved ?? 0} bài.${data?.skipped.length ? ` ${data.skipped.length} bài vướng định dạng hoặc trạng thái trong kho.` : ''}`);
    }}>
      <label>Nguồn trong Kho bài viết<select value={sourceId} onChange={event => setSourceId(event.target.value)}>
        {sources.map(source => <option key={source.id} value={source.id}>{source.code} · {source.name}</option>)}
      </select></label>
      <label className={styles.check}><input type="checkbox" checked={rightsConfirmed} onChange={event => setRightsConfirmed(event.target.checked)} />
        Tôi có quyền sử dụng lại caption và media của lô này trên Facebook.</label>
      <div><button disabled={save.pending || !sourceId || !rightsConfirmed}>Lưu lô vào Kho bài viết</button></div>
      {save.error && <p className="err" role="alert">{save.error}</p>}
      {save.done && <p className="okmsg" role="status">{save.done} {libraryHref && <Link href={libraryHref}>Mở Kho bài viết</Link>}</p>}
    </form>}
    {batch && job.result?.kind === 'RESEARCH_PROFILE' && <details>
      <summary>Kết quả từng bài</summary>
      <ol className={styles.results}>{job.result.rows.map(row => {
        const post = posts.get(row.url);
        if (!post) return null;
        return <li key={row.url}>
          <a href={row.url} {...external}>{row.title || 'Mở bài Instagram'}</a>
          <span className="muted"> · {post.state === 'PARTIAL' ? 'Còn thiếu nội dung' : states[post.state]}
            {post.readerCode && ` · ${post.readerCode}`}
            {post.caption !== null && ` · ${post.images} ảnh · ${post.videos} video`}</span>
          {post.issue && <p className="muted">{researchIssueText[post.issue]}</p>}
          {post.caption && <details><summary>Xem caption</summary><p className={styles.caption}>{post.caption}</p></details>}
        </li>;
      })}</ol>
    </details>}
  </>;
}

function JobResult({ job, sources, destinations, canOperate }: {
  job: Data['jobs'][number]; sources: Data['sources']; destinations: Data['destinations']; canOperate: boolean;
}) {
  const submit = useSubmit();
  const { result } = job;
  if (!result) return null;
  const canReadBatch = job.state === 'COMPLETE' && result.kind === 'RESEARCH_PROFILE' && result.rows.length > 0
    && instagramSourceLink(job.url)?.type === 'profile';
  return <>
    <div className={styles.actions}><ExportResult result={result} id={job.id} />
      {result.kind === 'RESEARCH_PROFILE' && <span className="muted">Đã tìm thấy {result.rows.length} bài</span>}
      {result.kind === 'RESEARCH_POST' && result.partial && <span className="muted">Đã đọc một phần</span>}
    </div>
    {result.kind === 'RESEARCH_PROFILE' ? <>
      {canReadBatch && <InstagramBatch job={job} sources={sources} destinations={destinations} />}
      {result.stopReason && <p className="muted">{researchIssueText[result.stopReason]}</p>}
      {result.rows.length > 0 && !job.batch && <ol className={styles.results}>{result.rows.map((row, index) => <li key={row.url + index}>
        <a href={row.url} {...external}>{row.title || 'Mở bài gốc'}</a>
        {row.body && <p>{row.body}{row.captionPartial ? '…' : ''}</p>}
        <button type="button" disabled={submit.pending} onClick={() => submit.run(() => queue(row.url, 10), assigned)}>
          {instagramSourceLink(row.url) ? 'Đọc bài Instagram' : 'Đọc bài và bình luận'}
        </button>
      </li>)}</ol>}
      {!result.rows.length && <p className="muted">Chưa tìm được link bài trực tiếp trên trang này.</p>}
      {submit.error && <p className="err" role="alert">{submit.error}</p>}
      {submit.done && <p className="okmsg" role="status">{submit.done}</p>}
    </> : <>
      <p className="muted">{[result.author, result.location, result.sourceKind === 'reel' ? 'Reel' : result.sourceKind === 'video' ? 'Video' : ''].filter(Boolean).join(' · ')}</p>
      {result.body && <p className={styles.caption}>{result.body}</p>}
      {result.captionPartial && <p className="muted">Caption có thể còn thiếu.</p>}
      {result.mediaLinks.length > 0 && <details><summary>Liên kết ảnh và video ({result.mediaLinks.length})</summary>
        <ul>{result.mediaLinks.map((url, index) => <li key={url}><a href={url} {...external}>Mở tệp {index + 1}</a></li>)}</ul>
        {result.mediaPartial && <p className="muted">Các liên kết có thể chỉ bao gồm một phần ảnh và video.</p>}
      </details>}
      <details open={result.comments.length > 0}><summary>{result.comments.length} bình luận đọc được</summary>
        <ol className={styles.results}>{result.comments.map((comment, index) => <li key={index} style={{ marginInlineStart: `${Math.min(comment.depth, 5)}rem` }}>
          <strong>{comment.name}</strong><p>{comment.text}</p>
        </li>)}</ol>
      </details>
      <ImportResult result={result} id={job.id} sources={sources} ownerCode={job.ownerCode} canOperate={canOperate} />
    </>}
  </>;
}

export function ResearchWorkspace({ data, canOperate, initialUrl }: { data: Data; canOperate: boolean; initialUrl: string }) {
  const [url, setUrl] = useState(initialUrl);
  const [limit, setLimit] = useState('10');
  const [limitError, setLimitError] = useState('');
  const [targetCode, setTargetCode] = useState('');
  const [showProfiles, setShowProfiles] = useState(false);
  const submit = useSubmit();
  const instagram = instagramSourceLink(url.trim());
  const max = researchLimitFor(url.trim());
  const jobs = instagram ? data.jobs.filter(job => instagramSourceLink(job.url)) : data.jobs;
  const profileLookup = new Map(data.profiles.map(profile => [profile.code, profile]));
  const eligible = (profile: Data['profiles'][number]) => instagram?.type === 'profile' ? profile.canReadInstagramProfile
    : instagram ? profile.canReadInstagram : profile.canResearch;
  const selected = profileLookup.get(targetCode);
  const canSubmit = !targetCode || Boolean(selected && eligible(selected));

  return <div className={styles.workspace}>
    {(showProfiles || jobs.some(job => active.has(job.state) || !!(job.batch && job.batch.running + job.batch.queued))) && <AutoRefresh seconds={6} />}
    <form className={styles.enqueue} noValidate onSubmit={e => {
      e.preventDefault();
      const count = Number(limit);
      if (!Number.isInteger(count) || count < 1 || count > max) {
        setLimitError(`Nhập số nguyên từ 1 đến ${max}.`);
        return;
      }
      setLimitError('');
      if (canSubmit) submit.run(() => queue(url.trim(), count, targetCode || undefined), assigned);
    }}>
      <label>Liên kết Facebook hoặc Instagram<input type="text" placeholder="Link profile, bài viết hoặc Reel" value={url} maxLength={500}
        onChange={e => { setUrl(e.target.value); setLimitError(''); }} required /></label>
      <label>{instagram?.type === 'profile' ? 'Số bài cần tìm' : 'Giới hạn bài hoặc bình luận gốc'} (tối đa {max})
        <input type="number" min={1} max={max} value={limit} aria-invalid={!!limitError}
          onChange={e => { setLimit(e.target.value); setLimitError(''); }} required /></label>
      <div className={styles.profileControls}>
        <label>Tài khoản thực hiện<select value={targetCode} onChange={e => setTargetCode(e.target.value)}>
          <option value="">Tự chọn tài khoản đủ điều kiện</option>
          {data.profiles.map(profile => <option key={profile.code} value={profile.code} disabled={!eligible(profile)}>
            {profile.code} · {profile.name}{eligible(profile) ? '' : ' · chưa sẵn sàng'}
          </option>)}
        </select></label>
        <button type="button" onClick={() => setShowProfiles(value => !value)} aria-expanded={showProfiles} aria-controls="instagram-profiles">Tài khoản Instagram</button>
      </div>
      <button className="primary" disabled={submit.pending || !url.trim() || !canSubmit}>{instagram?.type === 'profile' ? 'Tìm bài Instagram' : 'Giao việc đọc'}</button>
      {!canSubmit && <p className="muted">Tài khoản đang chọn chưa sẵn sàng. Kiểm tra trạng thái hoặc chuyển sang Tự chọn.</p>}
      {(limitError || submit.error) && <p className="err" role="alert">{limitError || submit.error}</p>}
      {!limitError && submit.done && <p className="okmsg" role="status">{submit.done}</p>}
    </form>
    {showProfiles && <section className={styles.job} id="instagram-profiles" aria-label="Trạng thái tài khoản Instagram">
      {data.profiles.length ? <ul className={styles.profileList}>
        {data.profiles.map(profile => <li key={profile.code}>
          <strong>{profile.code} · {profile.name}</strong>
          <span>{instagramStatus(profile)}</span>
        </li>)}
      </ul> : <p className="muted">Chưa có Chrome profile nào được ghép.</p>}
    </section>}
    <section aria-label={instagram ? 'Lượt đọc Instagram' : 'Lượt Post Research'}>
      {jobs.length === 0 && <p className="muted">{instagram ? 'Chưa có lượt đọc Instagram.' : 'Chưa có lượt đọc.'}</p>}
      {jobs.map(job => <article className={styles.job} key={job.id}>
        <header className={styles.actions}>
          <h2>{job.kind === 'RESEARCH_PROFILE' ? 'Tìm bài trên profile' : 'Đọc bài và bình luận'}</h2>
          <Badge s={job.state} text={states[job.state] ?? job.state} />
          <small><strong>{job.targetCode}</strong>{profileLookup.get(job.targetCode) && ` · ${profileLookup.get(job.targetCode)?.name}`} · {fmtTime(job.createdAt)}</small>
          {job.continuous && active.has(job.state) && <ActionButton path={`research/${job.id}/stop`}>Dừng lượt đọc</ActionButton>}
        </header>
        <a className={styles.url} href={job.url} {...external}>{job.url}</a>
        {job.issue && <p className="err">{researchIssueText[job.issue]}</p>}
        <JobResult job={job} sources={data.sources} destinations={data.destinations} canOperate={canOperate} />
      </article>)}
    </section>
  </div>;
}
