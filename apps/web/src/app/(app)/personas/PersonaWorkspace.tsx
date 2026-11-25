'use client';

import type { PersonaApproval, PersonaPreview, PersonaProfile, PersonaRelation, PersonaWorkspaceData } from '@seedingsys/contracts';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { bff } from '@/components/client';
import { fmtTime } from '@/lib/format';
import { RadarPanel } from './RadarPanel';
import styles from './personas.module.css';

const tabs = { preview: 'Xem trước & duyệt', directory: 'Danh bạ nhân vật', radar: 'Radar khách hàng' } as const;
type Tab = keyof typeof tabs;
type OperatingProps = { data: PersonaWorkspaceData; canManage: boolean };
type Notice = { text: string; error?: boolean };

function Feedback({ notice }: { notice: Notice | null }) {
  return notice && <p className={notice.error ? 'err' : 'okmsg'} role={notice.error ? 'alert' : 'status'}>{notice.text}</p>;
}

async function readJson(file: File): Promise<unknown> {
  if (file.size > 1024 * 1024) throw new Error('Tệp JSON tối đa 1 MB.');
  return JSON.parse((await file.text()).replace(/^\uFEFF/, '')) as unknown;
}

export function ImportFile({ kind, revision }: { kind: 'directory' | 'radar'; revision?: number }) {
  const router = useRouter();
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!file) return;
    const form = event.currentTarget;
    setBusy(true);
    setNotice(null);
    try {
      const data = await readJson(file);
      if (kind === 'directory') {
        const result = await bff<{ added: number; updated: number; relations: number }>('POST', 'personas/import', { revision, registry: data });
        if (!result.ok) throw new Error(result.error);
        const { added, updated, relations } = result.data;
        setNotice({ text: `Đã thêm ${added}, cập nhật ${updated} nhân vật và nhập ${relations} chiều quan hệ.` });
      } else {
        const result = await bff<{ saved: number; skipped: number }>('POST', 'personas/radar/import', { reports: Array.isArray(data) ? data : [data] });
        if (!result.ok) throw new Error(result.error);
        setNotice({ text: `Đã lưu ${result.data.saved} hồ sơ, bỏ qua ${result.data.skipped} bản cũ hoặc trùng.` });
      }
      setFile(undefined);
      form.reset();
      router.refresh();
    } catch (error) {
      setNotice({ error: true, text: error instanceof SyntaxError ? 'Tệp JSON không đọc được.' : (error as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return <form className={styles.importForm} onSubmit={submit}>
    <label>{kind === 'directory' ? 'JSON do FB Desk xuất từ Danh bạ nhân vật' : 'JSON hồ sơ khách hàng'}
      <input type="file" accept=".json,application/json" disabled={busy} onChange={e => setFile(e.target.files?.[0])} />
    </label>
    {file && <span className="muted">{file.name}</span>}
    <button type="submit" disabled={!file || busy}>{busy ? 'Đang nhập…' : 'Nhập JSON'}</button>
    <Feedback notice={notice} />
  </form>;
}

export function PersonaWorkspace(props: OperatingProps) {
  const [tab, setTab] = useState<Tab>('preview');
  return <div className={styles.workspace}>
    <nav className={styles.tabs} aria-label="Phân vai và Radar">
      {(Object.entries(tabs) as Array<[Tab, string]>).map(([id, label]) =>
        <button key={id} type="button" aria-pressed={id === tab} onClick={() => setTab(id)}>{label}</button>)}
    </nav>
    {tab === 'preview' && <PreviewPanel {...props} />}
    {tab === 'directory' && <DirectoryPanel {...props} />}
    {tab === 'radar' && <RadarPanel radars={props.data.radars} scans={props.data.scans} canManage={props.canManage} importForm={<ImportFile kind="radar" />} />}
  </div>;
}

function DirectoryPanel({ data, canManage }: OperatingProps) {
  return <>
    {canManage && <section className={styles.card} aria-label="Nhập danh bạ">
      <ImportFile kind="directory" revision={data.registry.revision} />
      <ProfileEditor data={data} />
    </section>}
    <section className={styles.card}>
      <h2>Danh bạ nhân vật</h2>
      {data.registry.profiles.length === 0 ? <p className="muted">Chưa có nhân vật trong danh bạ.</p> :
        <div className={styles.personGrid}>{data.registry.profiles.map(person => <PersonCard
          key={person.id + ':' + person.uid} data={data} person={person} canManage={canManage} />)}</div>}
    </section>
  </>;
}

function PersonCard({ data, person, canManage }: OperatingProps & { person: PersonaWorkspaceData['registry']['profiles'][number] }) {
  const router = useRouter();
  const paired = data.targets.find(target => target.uid === person.uid);
  const [targetId, setTargetId] = useState(paired?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const targetsInUse = new Set(data.registry.profiles.filter(p => p.id !== person.id).map(p => p.uid));
  const role = data.roles.find(value => value.id === person.role);
  const bind = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    const result = await bff('POST', 'personas/bind', { revision: data.registry.revision, personaId: person.id, targetId });
    setBusy(false);
    setNotice(result.ok ? { text: 'Đã gắn UID.' } : { text: result.error, error: true });
    if (result.ok) router.refresh();
  };
  return <article className={styles.person}>
    <header>
      <h3>{person.alias}</h3>
      <span className={styles.tag}>{role?.label}</span>
    </header>
    <p>{[person.name, person.workArea].filter(Boolean).join(' · ')}</p>
    <p>{paired ? `${paired.code} · ${paired.uid} · ${paired.online ? 'Online' : 'Offline'}` :
      person.uid ? `UID ${person.uid} chưa ghép Chrome` : 'Chưa gắn UID'}
      {!person.enabled && ' · Nhân vật đang tạm dừng'}</p>
    {(person.personality || person.tone || person.bio) && <details>
      <summary>Xem hồ sơ</summary>
      {[person.personality, person.tone, person.bio].filter(Boolean).map((text, index) => <p key={index}>{text}</p>)}
    </details>}
    {canManage && <form className={styles.binding} onSubmit={bind}>
      <label>Đích đã ghép<select value={targetId} onChange={e => setTargetId(e.target.value)}>
        <option value="">Chọn đích</option>
        {data.targets.filter(t => !targetsInUse.has(t.uid)).map(t => <option value={t.id} key={t.id}>{t.code} · {t.uid}</option>)}
      </select></label>
      <button type="submit" disabled={busy || !targetId || targetId === paired?.id}>Gắn UID</button>
    </form>}
    {canManage && <ProfileEditor data={data} person={person} />}
    <Feedback notice={notice} />
  </article>;
}

function ProfileEditor({ data, person }: { data: PersonaWorkspaceData; person?: PersonaProfile }) {
  const router = useRouter();
  const defaults = () => ({
    alias: person?.alias ?? '', name: person?.name ?? '', role: person?.role ?? ('custom' as const),
    enabled: person?.enabled ?? true, personality: person?.personality ?? '', tone: person?.tone ?? '',
    bio: person?.bio ?? '', workArea: person?.workArea ?? '',
  });
  const [profile, setProfile] = useState(defaults);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const update = (field: keyof typeof profile, value: string | boolean) => setProfile(p => ({ ...p, [field]: value }));
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    const result = await bff('POST', 'personas/profile', { revision: data.registry.revision, personaId: person?.id, profile });
    setBusy(false);
    setNotice(result.ok ? { text: 'Đã lưu nhân vật.' } : { error: true, text: result.error });
    if (result.ok) {
      if (!person) setProfile(defaults());
      router.refresh();
    }
  };
  return <details className={styles.relation}>
    <summary>{person ? 'Sửa hồ sơ nhân vật' : 'Thêm nhân vật'}</summary>
    <form onSubmit={save}>
      <fieldset className={styles.form} disabled={busy}>
        <div className={styles.twoColumns}>
          <label>Tên gọi trong danh bạ<input required maxLength={80} value={profile.alias} onChange={e => update('alias', e.target.value)} /></label>
          <label>Tên hiển thị<input maxLength={120} value={profile.name} onChange={e => update('name', e.target.value)} /></label>
          <label>Vai trò mặc định<select value={profile.role} onChange={e => update('role', e.target.value)}>
            {data.roles.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select></label>
          <label>Ngăn công việc<input maxLength={120} value={profile.workArea} onChange={e => update('workArea', e.target.value)} /></label>
        </div>
        <label>Tính cách<textarea rows={2} maxLength={1500} value={profile.personality} onChange={e => update('personality', e.target.value)} /></label>
        <label>Văn phong<textarea rows={2} maxLength={1000} value={profile.tone} onChange={e => update('tone', e.target.value)} /></label>
        <label>Bối cảnh nhân vật<textarea rows={2} maxLength={3000} value={profile.bio} onChange={e => update('bio', e.target.value)} /></label>
        <label><input type="checkbox" checked={profile.enabled} onChange={e => update('enabled', e.target.checked)} /> Bật nhân vật</label>
        <button>Lưu nhân vật</button>
        <Feedback notice={notice} />
      </fieldset>
    </form>
  </details>;
}

function PreviewPanel({ data, canManage }: OperatingProps) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [topic, setTopic] = useState('');
  const [radarId, setRadarId] = useState('');
  const [preview, setPreview] = useState<PersonaPreview | null>(null);
  const [approval, setApproval] = useState<PersonaApproval | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const targets = new Map(data.targets.map(t => [t.uid, t]));
  const relation = data.registry.relations.find(r => r.from === from && r.to === to);
  const choices = data.registry.profiles.filter(p => p.enabled);
  const paired = (id: string) => targets.has(choices.find(p => p.id === id)?.uid ?? '');
  const payload = { from, to, topic, radarId: radarId || null };
  const clear = () => { setPreview(null); setApproval(null); setNotice(null); };
  const previewRole = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    clear();
    setBusy(true);
    const result = await bff<PersonaPreview>('POST', 'personas/preview', payload);
    setBusy(false);
    if (result.ok) setPreview(result.data);
    else setNotice({ text: result.error, error: true });
  };
  const approve = async () => {
    if (!preview) return;
    setBusy(true);
    const result = await bff<PersonaApproval>('POST', 'personas/approve', { ...payload, fingerprint: preview.fingerprint });
    setBusy(false);
    if (result.ok) { setApproval(result.data); setNotice(null); }
    else { setPreview(null); setNotice({ text: result.error, error: true }); }
  };
  const history = approval ? [approval, ...data.approvals.filter(a => a.id !== approval.id)] : data.approvals;
  return <>
    <section className={styles.card}>
      <h2>Chiều hội thoại</h2>
      <form onSubmit={previewRole}>
        <fieldset disabled={busy} className={styles.form}>
          <div className={styles.twoColumns}>
            <label>Người nói<select required value={from} onChange={e => { clear(); setFrom(e.target.value); if (e.target.value === to) setTo(''); }}>
              <option value="">Chọn nhân vật</option>
              {choices.map(p => <option key={p.id} value={p.id}>{p.alias} · {targets.get(p.uid)?.code ?? 'chưa ghép'}</option>)}
            </select></label>
            <label>Người nghe<select required value={to} onChange={e => { clear(); setTo(e.target.value); }}>
              <option value="">Chọn nhân vật</option>
              {choices.filter(p => p.id !== from).map(p => <option key={p.id} value={p.id}>{p.alias} · {targets.get(p.uid)?.code ?? 'chưa ghép'}</option>)}
            </select></label>
          </div>
          <label>Chủ đề<textarea rows={2} value={topic} maxLength={3000} onChange={e => { clear(); setTopic(e.target.value); }} /></label>
          <label>Radar tham chiếu<select value={radarId} onChange={e => { clear(); setRadarId(e.target.value); }}>
            <option value="">Không chọn hồ sơ</option>
            {data.radars.map(radar => <option value={radar.id} key={radar.id}>{radar.name || radar.url}</option>)}
          </select></label>
          {from && to && (!paired(from) || !paired(to)) && <p className="muted">Gắn hai nhân vật với đích đã ghép trong Danh bạ trước khi xem trước.</p>}
          {from && to && !relation && <p className="muted">Chưa có quan hệ theo chiều người nói → người nghe.</p>}
          <button className="primary" disabled={!from || !to || !paired(from) || !paired(to) || !relation}>Xem trước vai và xưng hô</button>
        </fieldset>
      </form>
      {canManage && from && to && <RelationEditor key={`${from}:${to}:${data.registry.revision}`} data={data} from={from} to={to}
        relation={relation} onSave={clear} />}
      <Feedback notice={notice} />
    </section>
    {preview && <section className={styles.card} aria-label="Bản xem trước">
      <Context context={preview} />
      <button type="button" className="primary" onClick={() => void approve()} disabled={busy || !!approval}>
        {approval ? 'Đã duyệt' : busy ? 'Đang lưu…' : 'Duyệt phân vai'}
      </button>
    </section>}
    {history.length > 0 && <section className={styles.card}>
      <h2>Phân vai đã duyệt gần đây</h2>
      {history.map(row => <details key={row.id} className={styles.history}>
        <summary>{row.context.speaker.alias} → {row.context.listener.alias} · {row.context.relationship.label} · {fmtTime(row.approvedAt)}</summary>
        <p className="muted">{row.approvedBy}</p>
        <Context context={row.context} />
        <a href={`/bff/personas/approvals/${row.id}/context`} download={`phan-vai-${row.id}.json`}>Tải context JSON đã duyệt</a>
      </details>)}
    </section>}
  </>;
}

function Context({ context }: { context: PersonaPreview }) {
  return <div className={styles.context}>
    <h3>{context.speaker.alias} → {context.listener.alias}</h3>
    <p className="muted">{context.speaker.code} · {context.speaker.uid} → {context.listener.code} · {context.listener.uid}</p>
    <dl>
      <div><dt>Vai theo chiều này</dt><dd>{context.relationship.label}</dd></div>
      <div><dt>Tự xưng</dt><dd>{context.relationship.self}</dd></div>
      <div><dt>Gọi người nghe</dt><dd>{context.relationship.other}</dd></div>
      {context.speaker.tone && <div><dt>Văn phong</dt><dd>{context.speaker.tone}</dd></div>}
      {context.relationship.notes && <div><dt>Lưu ý quan hệ</dt><dd>{context.relationship.notes}</dd></div>}
      {context.topic && <div><dt>Chủ đề</dt><dd>{context.topic}</dd></div>}
      {context.radar && <div><dt>Radar tham chiếu</dt><dd>{context.radar.name || context.radar.url}</dd></div>}
    </dl>
    <p className={styles.sample}>“{context.sample}”</p>
    {context.radarReport && <details>
      <summary>Xem điểm Radar của lần duyệt này</summary>
      {(['demographic', 'personality'] as const).map(group => <div key={group}>
        <h4>{group === 'demographic' ? 'Nhân khẩu' : 'Tính cách'}</h4>
        <ul>{context.radarReport![group].map(a => <li key={a.id}>
          {a.label} · {a.score === null ? 'Chưa đủ dữ liệu' : `${a.score}/100`}{a.manual ? ' · Chỉnh tay' : a.confidence ? ' · ' + a.confidence : ''}
        </li>)}</ul>
      </div>)}
    </details>}
  </div>;
}

function RelationEditor({ data, from, to, relation, onSave }: {
  data: PersonaWorkspaceData; from: string; to: string; relation?: PersonaRelation; onSave: () => void;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<PersonaRelation>(relation ?? { from, to, role: 'custom', self: '', other: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [open, setOpen] = useState(!relation);
  const preset = data.roles.find(r => r.id === draft.role);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    const result = await bff('POST', 'personas/relation', { revision: data.registry.revision, relation: draft });
    setBusy(false);
    if (!result.ok) { setNotice({ text: result.error, error: true }); return; }
    onSave();
    setOpen(false);
    router.refresh();
  };
  return <details open={open} onToggle={e => setOpen(e.currentTarget.open)} className={styles.relation}>
    <summary>{relation ? 'Sửa vai và xưng hô theo chiều này' : 'Thêm vai và xưng hô theo chiều này'}</summary>
    <form onSubmit={submit}>
      <fieldset className={styles.form} disabled={busy}>
        <label>Vai của người nói<select value={draft.role} onChange={e => setDraft({ ...draft, role: e.target.value as PersonaRelation['role'] })}>
          {data.roles.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select></label>
        <div className={styles.twoColumns}>
          <label>Tự xưng<input maxLength={40} value={draft.self} placeholder={preset?.self} onChange={e => setDraft({ ...draft, self: e.target.value })} /></label>
          <label>Gọi người nghe<input maxLength={40} value={draft.other} placeholder={preset?.other} onChange={e => setDraft({ ...draft, other: e.target.value })} /></label>
        </div>
        <label>Lưu ý quan hệ<textarea rows={2} maxLength={2000} value={draft.notes} onChange={e => setDraft({ ...draft, notes: e.target.value })} /></label>
        <button disabled={busy}>Lưu chiều quan hệ</button>
        <Feedback notice={notice} />
      </fieldset>
    </form>
  </details>;
}
