'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { ResearchReport, ResearchWorkspace as Data } from '@seedingsys/contracts';
import { AutoRefresh, bff, useSubmit } from '@/components/client';
import { Badge } from '@/components/ui';
import { fmtTime } from '@/lib/format';
import styles from './research.module.css';

const states: Record<string, string> = {
  QUEUED: 'Chờ profile', RUNNING: 'Đang đọc', COMPLETE: 'Hoàn tất', FAILED: 'Không đọc được', EXPIRED: 'Hết thời gian',
};
const external = { target: '_blank', rel: 'noreferrer' } as const;
const queue = (url: string, limit: number) => bff<{ targetCode: string }>('POST', 'research', { url, limit });
const assigned = (data?: { targetCode: string }) => `Đã giao cho ${data?.targetCode ?? 'profile đang online'}.`;

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
  const [postHref, setPostHref] = useState('');
  const submit = useSubmit();
  if (!sources.length) return <p className="muted">Thêm nguồn nhập tay đang bật để lưu vào Kho bài viết.</p>;
  const ready = !!(useExisting || (result.body && !result.captionPartial));
  return <form className={styles.importForm} onSubmit={event => {
    event.preventDefault();
    setPostHref('');
    submit.run(async () => {
      const response = await bff<{ postId: string; sourceCode: string; ownerCode: string | null; comments: number }>('POST',
        `research/${id}/import`, { sourceId, textOnly, useExisting });
      if (response.ok) {
        const { sourceCode, postId, ownerCode: owner } = response.data;
        setPostHref('/library?' + new URLSearchParams({ profile: sourceCode, post: postId, ...(owner && { to: owner }) }));
      }
      return response;
    }, data => `Đã lưu bài và ${data?.comments ?? 0} bình luận nguồn.`);
  }}>
    <label>Nguồn trong Kho bài viết<select value={sourceId} onChange={e => setSourceId(e.target.value)}>
      {sources.map(source => <option key={source.id} value={source.id}>{source.code} · {source.name}</option>)}
    </select></label>
    {result.hasMedia && <label className={styles.check}><input type="checkbox" checked={textOnly} onChange={e => setTextOnly(e.target.checked)} />
      Lưu caption và bình luận dạng chữ</label>}
    {canOperate && ownerCode && <label className={styles.check}><input type="checkbox" checked={useExisting} onChange={e => setUseExisting(e.target.checked)} />
      Gắn link này làm bài đích đã đăng của {ownerCode}</label>}
    {!ready && <p className="muted">Cần caption đầy đủ hoặc UID chủ bài đã ghép để gắn bài đích.</p>}
    <div><button disabled={submit.pending || !sourceId || !ready || (result.hasMedia && !textOnly)}>Lưu vào Kho bài viết</button></div>
    {submit.error && <p className="err" role="alert">{submit.error}</p>}
    {submit.done && <p className="okmsg" role="status">{submit.done} {postHref && <Link href={postHref}>Mở bài trong kho</Link>}</p>}
  </form>;
}

function JobResult({ job, sources, canOperate }: { job: Data['jobs'][number]; sources: Data['sources']; canOperate: boolean }) {
  const submit = useSubmit();
  const { result } = job;
  if (!result) return null;
  return <>
    <div className={styles.actions}><ExportResult result={result} id={job.id} />
      {result.partial && <span className="muted">Đã đọc một phần</span>}
    </div>
    {result.kind === 'RESEARCH_PROFILE' ? <>
      {result.rows.length ? <ol className={styles.results}>{result.rows.map((row, index) => <li key={row.url + index}>
        <a href={row.url} {...external}>{row.title || 'Mở bài trên Facebook'}</a>
        {row.body && <p>{row.body}{row.captionPartial ? '…' : ''}</p>}
        <button type="button" disabled={submit.pending} onClick={() => submit.run(() => queue(row.url, 10), assigned)}>Đọc bài và bình luận</button>
      </li>)}</ol> : <p className="muted">Chưa tìm được link bài trực tiếp trên trang này.</p>}
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

export function ResearchWorkspace({ data, canOperate }: { data: Data; canOperate: boolean }) {
  const [url, setUrl] = useState('');
  const [limit, setLimit] = useState(10);
  const submit = useSubmit();
  return <div className={styles.workspace}>
    {data.jobs.some(job => ['QUEUED', 'RUNNING'].includes(job.state)) && <AutoRefresh seconds={6} />}
    <form className={styles.enqueue} onSubmit={e => { e.preventDefault(); submit.run(() => queue(url.trim(), limit), assigned); }}>
      <label>Liên kết Facebook<input type="text" placeholder="Link profile hoặc link trực tiếp tới bài viết" value={url} maxLength={500}
        onChange={e => setUrl(e.target.value)} required /></label>
      <label>Giới hạn bài hoặc bình luận gốc<input type="number" min={1} max={20} value={limit || ''}
        onChange={e => setLimit(Number(e.target.value))} required /></label>
      <button className="primary" disabled={submit.pending || !url.trim()}>Giao việc đọc</button>
      {submit.error && <p className="err" role="alert">{submit.error}</p>}
      {submit.done && <p className="okmsg" role="status">{submit.done}</p>}
    </form>
    <section aria-label="Lượt Post Research">
      {data.jobs.length === 0 && <p className="muted">Chưa có lượt đọc.</p>}
      {data.jobs.map(job => <article className={styles.job} key={job.id}>
        <header className={styles.actions}>
          <h2>{job.kind === 'RESEARCH_PROFILE' ? 'Tìm bài trên profile' : 'Đọc bài và bình luận'}</h2>
          <Badge s={job.state} text={states[job.state] ?? job.state} />
          <small>{job.targetCode} · {fmtTime(job.createdAt)}</small>
        </header>
        <a className={styles.url} href={job.url} {...external}>{job.url}</a>
        <JobResult job={job} sources={data.sources} canOperate={canOperate} />
      </article>)}
    </section>
  </div>;
}
