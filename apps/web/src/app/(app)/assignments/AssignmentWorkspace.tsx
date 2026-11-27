'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { ASSIGNMENT_CODES, ASSIGNMENT_TYPES, type AssignmentCode, type AssignmentWorkspaceData, type WorkAssignment } from '@seedingsys/contracts';
import { ActionButton, bff, useSubmit } from '@/components/client';
import { Badge, Empty } from '@/components/ui';
import { fmtTime } from '@/lib/format';
import styles from './assignments.module.css';

type Group = 'X' | 'Y';
const external = { target: '_blank', rel: 'noopener noreferrer' } as const;
const splitLinks = (text: string) => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
const postInputs = new Set(['post', 'group-post', 'page-post']);
const inputLabels = {
  post: 'Link bài Facebook trên tường B2',
  group: 'Link nhóm Facebook',
  'group-post': 'Link bài viết trong nhóm',
  'page-post': 'Link fanpage, bài viết hoặc bình luận',
  profile: 'Link trang cá nhân khách hàng',
  brief: '',
} as const;

function Feedback({ state }: { state: ReturnType<typeof useSubmit> }) {
  return <>
    {state.error && <p className="err" role="alert">{state.error}</p>}
    {state.done && <p className="okmsg" role="status">{state.done}</p>}
  </>;
}

function AssignmentForm({ code, data, initialSearch }: { code: AssignmentCode; data: AssignmentWorkspaceData; initialSearch: WorkAssignment | null }) {
  const kind = ASSIGNMENT_TYPES[code];
  const [sourceId, setSourceId] = useState(initialSearch?.source?.id ?? '');
  const [postId, setPostId] = useState('');
  const [searchId, setSearchId] = useState(initialSearch?.id ?? '');
  const [pickedGroups, setPickedGroups] = useState<string[]>([]);
  const [linkText, setLinkText] = useState('');
  const [brief, setBrief] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [targetSearch, setTargetSearch] = useState('');
  const request = useRef<{ input: string; id: string } | null>(null);
  const submit = useSubmit();

  const source = data.sources.find(item => item.id === sourceId);
  const post = source?.posts.find(item => item.id === postId);
  const search = data.groupSearches.find(item => item.id === searchId);
  const showLinks = kind.input !== 'brief' && !search;
  const links = search ? pickedGroups : splitLinks(linkText);
  const canUsePost = postInputs.has(kind.input);
  const hasInput = code === 'Y1' || links.length > 0 || (canUsePost && !!post);
  const query = targetSearch.trim().toLocaleLowerCase('vi');
  const shownTargets = data.targets.filter(target => (target.code + ' ' + target.name).toLocaleLowerCase('vi').includes(query));

  return <form className={styles.form} onSubmit={event => {
    event.preventDefault();
    const payload = { code, sourceId: source?.id, sourcePostId: post?.id, fromAssignmentId: search?.id, urls: links, brief, targetIds: selected };
    const serialized = JSON.stringify(payload);
    if (request.current?.input !== serialized) request.current = { input: serialized, id: crypto.randomUUID() };
    const id = request.current.id;
    submit.run(async () => {
      const result = await bff<WorkAssignment>('POST', 'assignments', { id, ...payload });
      if (result.ok) {
        request.current = null;
        setSelected([]);
        setLinkText('');
        setBrief('');
        setPostId('');
        setPickedGroups([]);
      }
      return result;
    }, 'Đã lưu công việc vào danh sách chờ.');
  }}>
    <fieldset className={styles.section}>
      <legend>Nguồn N và dữ liệu đầu vào</legend>
      <label className={styles.field}>Nguồn nội dung
        <select value={sourceId} onChange={event => { setSourceId(event.target.value); setPostId(''); }}>
          <option value="">Chọn nguồn nếu có</option>
          {data.sources.map(item => <option value={item.id} key={item.id}>{item.code} · {item.name}</option>)}
        </select>
      </label>
      {source && canUsePost && <label className={styles.field}>Bài trong nguồn {source.code}
        <select value={postId} onChange={event => setPostId(event.target.value)} disabled={!source.posts.length}>
          <option value="">{source.posts.length ? 'Chọn bài nếu có' : 'Nguồn chưa có bài có liên kết'}</option>
          {source.posts.map(item => <option key={item.id} value={item.id}>{item.caption || item.url}</option>)}
        </select>
      </label>}
      {code === 'X2' && data.groupSearches.length > 0 && <label className={styles.field}>Kết quả Y1
        <select value={searchId} onChange={event => { setSearchId(event.target.value); setPickedGroups([]); }}>
          <option value="">Nhập link nhóm trực tiếp</option>
          {data.groupSearches.map(item => <option key={item.id} value={item.id}>{item.brief.slice(0, 64)} · {item.results.length} nhóm</option>)}
        </select>
      </label>}
      {search && <div className={styles.targets} role="group" aria-label="Nhóm từ kết quả Y1">
        {search.results.map(url => <label key={url} className={styles.option}>
          <input type="checkbox" checked={pickedGroups.includes(url)} onChange={event => setPickedGroups(current =>
            event.target.checked ? [...current, url] : current.filter(item => item !== url))} />
          <span>{new URL(url).pathname}</span>
        </label>)}
      </div>}
      {showLinks && <label className={styles.field}>{inputLabels[kind.input]}
        <textarea rows={2} value={linkText} onChange={event => setLinkText(event.target.value)}
          placeholder={post ? 'Có thể dùng link của bài đã chọn' : 'Mỗi dòng một liên kết'} spellCheck={false} />
      </label>}
      <label className={styles.field}>{code === 'Y1' ? 'Mẫu nhóm cần tìm' : code === 'Y2' ? 'Sản phẩm và nội dung cần chuẩn bị' : 'Ghi chú cho công việc'}
        <textarea rows={2} value={brief} onChange={event => setBrief(event.target.value)} maxLength={4000} required={kind.brief} />
      </label>
    </fieldset>
    <fieldset className={styles.section}>
      <legend>{code === 'Y1' ? 'B dùng ở bước sau nếu cần' : 'Chọn tài khoản B'}</legend>
      <label className={styles.field}>Tìm theo mã hoặc tên
        <input type="search" value={targetSearch} onChange={event => setTargetSearch(event.target.value)} />
      </label>
      <div className={styles.targets}>
        {shownTargets.map(target => <label key={target.id} className={styles.option}>
          <input type="checkbox" checked={selected.includes(target.id)} onChange={event => setSelected(current =>
            event.target.checked ? [...current, target.id] : current.filter(id => id !== target.id))} />
          <span><strong>{target.code}</strong> · {target.name}<small>
            {!target.paired ? 'Chưa ghép Chrome' : !target.enabled ? 'Đang tắt' : target.online ? 'Đang kết nối' : 'Ngoại tuyến'}
          </small></span>
        </label>)}
        {!shownTargets.length && <p className="muted">Không tìm thấy tài khoản.</p>}
      </div>
      <p className="muted" aria-live="polite">Đã chọn {selected.length} tài khoản.</p>
    </fieldset>
    <div className={styles.actions}>
      <button className="primary" type="submit" disabled={submit.pending || !hasInput ||
        (code !== 'Y1' && !selected.length) || (kind.brief && !brief.trim())}>{submit.pending ? 'Đang lưu…' : 'Lưu công việc'}</button>
      <Feedback state={submit} />
    </div>
  </form>;
}

function AssignmentCard({ job, onHandoff }: { job: WorkAssignment; onHandoff: (job: WorkAssignment) => void }) {
  const [resultText, setResultText] = useState('');
  const save = useSubmit();
  const waiting = job.status === 'PENDING';
  const search = job.code === 'Y1';
  const researchLink = (job.code === 'X3' || job.code === 'X4') && job.urls[0] ? new URL(job.urls[0]) : null;
  researchLink?.searchParams.delete('comment_id');
  researchLink?.searchParams.delete('reply_comment_id');
  return <article className={styles.assignment}>
    <header className={styles.actions}>
      <strong>{job.code} · {ASSIGNMENT_TYPES[job.code].title}</strong>
      <Badge s={job.status === 'PENDING' ? 'PLANNED' : job.status} text={
        job.status === 'PENDING' ? 'Chờ xử lý' : job.status === 'DONE' ? 'Đã xác nhận xong' : 'Đã hủy'} />
      <small className="muted">{fmtTime(job.createdAt)}</small>
    </header>
    <div className="muted">{[job.source && (job.source.code + ' · ' + job.source.name), job.targets.map(t => t.code + ' ' + t.name).join(', ')]
      .filter(Boolean).join(' · ')}</div>
    {job.brief && <p className={styles.brief}>{job.brief}</p>}
    {!!job.urls.length && <ul className={styles.links}>{job.urls.map(url => <li key={url}><a href={url} {...external}>{url}</a></li>)}</ul>}
    {!!job.results.length && <p>{job.results.length} nhóm đã lưu</p>}
    {waiting && search && <form className={styles.results} onSubmit={event => {
      event.preventDefault();
      save.run(() => bff('PATCH', 'assignments/' + job.id, { status: 'DONE', results: splitLinks(resultText) }), 'Đã lưu kết quả Y1.');
    }}>
      <label className={styles.field}>Nhóm tìm được
        <textarea rows={2} placeholder="Mỗi dòng một link nhóm" value={resultText} onChange={event => setResultText(event.target.value)} required />
      </label>
      <div className={styles.actions}>
        <button type="submit" disabled={save.pending || !resultText.trim()}>Lưu kết quả Y1</button>
        <a href={'https://www.facebook.com/search/groups/?' + new URLSearchParams({ q: job.brief.slice(0, 180) })} {...external}>Mở tìm nhóm trên Facebook</a>
      </div>
      <Feedback state={save} />
    </form>}
    <div className={styles.actions}>
      {job.source && job.sourcePostId && <Link href={'/library?' + new URLSearchParams({ profile: job.source.code, post: job.sourcePostId })}>Mở bài trong kho</Link>}
      {waiting && researchLink && <Link href={'/research?' + new URLSearchParams({ url: researchLink.href })}>Đọc ngữ cảnh bằng Post Research</Link>}
      {search && job.status === 'DONE' && <button type="button" onClick={() => onHandoff(job)}>Dùng kết quả cho X2</button>}
      {waiting && !search && <ActionButton method="PATCH" path={'assignments/' + job.id} body={{ status: 'DONE' }}
        confirm="Xác nhận công việc này đã xong?">Xác nhận đã xong</ActionButton>}
      {waiting && <ActionButton method="PATCH" path={'assignments/' + job.id} body={{ status: 'CANCELLED' }}
        confirm="Hủy công việc này?">Hủy việc</ActionButton>}
    </div>
  </article>;
}

export function AssignmentWorkspace({ data }: { data: AssignmentWorkspaceData }) {
  const [group, setGroup] = useState<Group | null>(null);
  const [code, setCode] = useState<AssignmentCode | null>(null);
  const [initialSearch, setInitialSearch] = useState<WorkAssignment | null>(null);

  return <>
    <section className="card" id="phan-cong">
      <div className={styles.choices} role="group" aria-label="Nhóm đầu việc">
        <button type="button" aria-pressed={group === 'X'} onClick={() => { setGroup('X'); setCode(null); }}>X · Việc của tài khoản B</button>
        <button type="button" aria-pressed={group === 'Y'} onClick={() => { setGroup('Y'); setCode(null); }}>Y · Việc của AI Agent</button>
      </div>
      {group && <div className={styles.templates} role="group" aria-label="Chọn đầu việc">
        {ASSIGNMENT_CODES.filter(item => item.startsWith(group)).map(item => <button type="button" key={item}
          aria-pressed={item === code} onClick={() => { setCode(item); setInitialSearch(null); }}>
          <strong>{item}</strong> {ASSIGNMENT_TYPES[item].title}
        </button>)}
      </div>}
      {code && <AssignmentForm key={code + ':' + (initialSearch?.id ?? '')} code={code} data={data} initialSearch={initialSearch} />}
    </section>
    <section className="card" aria-label="Công việc đã lưu">
      <h2>Công việc đã lưu</h2>
      {data.assignments.length ? data.assignments.map(job => <AssignmentCard key={job.id} job={job} onHandoff={origin => {
        setGroup('X');
        setCode('X2');
        setInitialSearch(origin);
        document.getElementById('phan-cong')?.scrollIntoView();
      }} />) : <Empty>Chưa có công việc.</Empty>}
    </section>
  </>;
}
