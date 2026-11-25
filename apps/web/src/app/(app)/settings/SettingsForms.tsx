'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState, type ReactNode } from 'react';
import { AutoRefresh, bff, useSubmit } from '@/components/client';
import { Badge } from '@/components/ui';
import { fmtTime } from '@/lib/format';
import styles from './settings.module.css';

export interface SourceT {
  id: string; code: string; name: string; externalRef: string; connector: string; enabled: boolean;
  pollIntervalSec: number; overlapCount: number; collectComments: boolean; baselineDone: boolean;
  lastPollAt: string | null; lastSuccessAt: string | null; lastErrorAt: string | null; lastError: string | null;
  watermark?: { lastReadCount?: number } | null;
}

export interface TargetT {
  id: string; code: string; name: string; externalId: string; connector: string; audience: string;
  enabled: boolean; styleProfile: Record<string, unknown>;
  profile: { id: string; workerNode?: { lastHeartbeatAt: string | null } | null } | null;
  extension?: { installationId: string | null } | null;
}

export interface MappingT {
  id: string; sourceId: string; targetId: string;
  enabled: boolean; contentTtlHours: number; lateWindowMin: number; strictOrder: boolean;
  reviewMode: 'AUTO' | 'MANUAL'; maxPublishTries: number;
}

export interface Capabilities {
  checks: Array<{ id: string; contentType: string; connector: string; connectorVersion: string; passed: boolean; qualified: boolean; cases: number; failures: number; notes: string | null; checkedAt: string; target: { code: string } }>;
  releases: Array<{ connector: string; version: string; active: boolean }>;
}

export const sourceMethods: Record<string, string> = {
  'fb-public': 'Facebook công khai',
  'fb-session': 'Facebook qua tài khoản đích',
  'fb-web': 'Facebook có phiên đăng nhập',
  'fb-graph': 'Facebook Graph API',
  manual: 'Nhập bài',
  fake: 'Giả lập',
};

export const audiences: Record<string, string> = { ONLY_ME: 'Chỉ mình tôi', FRIENDS: 'Bạn bè', PUBLIC: 'Công khai' };

export function Panel({ title, description, right, children }: { title: string; description?: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className={styles.panel}>
      <header className={styles.panelHeader}>
        <div><h2>{title}</h2>{description && <p>{description}</p>}</div>
        {right}
      </header>
      {children}
    </section>
  );
}

function Feedback({ state }: { state: { error: string | null; done: string | null } }) {
  return <>{state.error && <p className="err" role="alert">{state.error}</p>}{state.done && <p className="okmsg" role="status">{state.done}</p>}</>;
}

function Enabled({ checked, onChange, children }: { checked: boolean; onChange: (value: boolean) => void; children: ReactNode }) {
  return <label className={styles.checkbox}><input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />{children}</label>;
}

function sourceDraft(s?: SourceT) {
  return {
    code: s?.code ?? '', name: s?.name ?? '', externalRef: s?.externalRef ?? '', connector: s?.connector ?? 'fb-public',
    pollIntervalSec: s?.pollIntervalSec ?? 300, overlapCount: s?.overlapCount ?? 5, enabled: s?.enabled ?? true, collectComments: s?.collectComments ?? false,
  };
}

export function sourceStatus(source: SourceT) {
  if (!source.enabled) return { tone: 'CANCELLED', label: 'Đã tắt' };
  if (source.connector === 'manual') return { tone: 'PLANNED', label: 'Nhập bài' };
  const success = source.lastSuccessAt ?? '';
  const failure = source.lastErrorAt ?? '';
  if ((source.lastPollAt ?? '') > success && (source.lastPollAt ?? '') > failure) {
    return { tone: 'QUEUED', label: 'Chờ kết quả quét' };
  }
  if (source.lastError && failure > success) return { tone: 'MISSED', label: 'Lỗi quét' };
  if (!source.baselineDone) return { tone: 'PLANNED', label: 'Chờ quét lần đầu' };
  return { tone: 'DONE', label: 'Đã quét' };
}

export function SourceForm({ source }: { source?: SourceT }) {
  const id = useId();
  const [form, setForm] = useState(() => sourceDraft(source));
  const save = useSubmit();
  const poll = useSubmit();
  const status = source ? sourceStatus(source) : undefined;
  const dirty = JSON.stringify(form) !== JSON.stringify(sourceDraft(source));
  const customPoll = form.connector !== 'manual';
  const isTimeline = form.connector === 'fb-public' || form.connector === 'fb-session';
  return (
    <Panel title={source ? 'Nguồn ' + source.code : 'Thêm nguồn quét'}
      description={form.connector === 'fb-session'
        ? 'Dùng phiên đăng nhập của đích Facebook đang bật trong luồng để đọc nguồn.'
        : isTimeline ? 'Quét trang cá nhân hoặc fanpage ở chế độ khách.' : undefined}
      right={status && <Badge s={status.tone} text={status.label} />}>
      <form onSubmit={e => {
        e.preventDefault();
        save.run(async () => {
          const result = await bff<SourceT>(source ? 'PATCH' : 'POST', source ? 'sources/' + source.id : 'sources', form);
          if (result.ok) setForm(sourceDraft(source ? result.data : undefined));
          return result;
        }, source ? 'Đã lưu nguồn' : 'Đã thêm nguồn');
      }}>
        <div className={styles.fields}>
          {!source && <div className="field"><label htmlFor={id + '-code'}>Mã nguồn</label><input id={id + '-code'} required pattern="A[0-9]+" placeholder="A6" value={form.code} onChange={e => setForm({ ...form, code: e.target.value.toUpperCase() })} /></div>}
          <div className="field"><label htmlFor={id + '-name'}>Tên nguồn</label><input id={id + '-name'} required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></div>
          <div className="field"><label htmlFor={id + '-method'}>Cách lấy bài</label><select id={id + '-method'} value={form.connector} onChange={e => setForm({ ...form, connector: e.target.value })}>
            {Object.entries(sourceMethods).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></div>
          <div className={styles.full}><label htmlFor={id + '-ref'}>{isTimeline ? 'URL Facebook của nguồn' : 'Địa chỉ hoặc ID nguồn'}</label><input id={id + '-ref'} required type="text" inputMode={isTimeline ? 'url' : 'text'} autoComplete="off" spellCheck={false} placeholder={isTimeline ? 'https://www.facebook.com/ten.trang' : undefined} value={form.externalRef} onChange={e => setForm({ ...form, externalRef: e.target.value })} /></div>
          {customPoll && <div className="field"><label htmlFor={id + '-interval'}>Chu kỳ quét (giây)</label><input id={id + '-interval'} type="number" min={60} required value={form.pollIntervalSec || ''} onChange={e => setForm({ ...form, pollIntervalSec: Number(e.target.value) })} /></div>}
          <Enabled checked={form.enabled} onChange={enabled => setForm({ ...form, enabled })}>Bật nguồn</Enabled>
        </div>
        {customPoll && <details className={styles.advanced}>
          <summary>Tùy chọn quét</summary>
          <label htmlFor={id + '-overlap'}>Số bài trong vùng đọc lại</label>
          <input id={id + '-overlap'} type="number" min={0} max={50} required value={form.overlapCount} onChange={e => setForm({ ...form, overlapCount: Number(e.target.value) })} />
          {(isTimeline || form.connector === 'fb-graph') && <Enabled checked={form.collectComments}
            onChange={collectComments => setForm({ ...form, collectComments })}>Tự quét bình luận khi phát hiện bài mới</Enabled>}
        </details>}
        <div className={styles.formActions}>
          <button className="primary" type="submit" disabled={save.pending || poll.pending || (!!source && !dirty)}>{save.pending ? 'Đang lưu…' : source ? 'Lưu nguồn' : 'Thêm nguồn'}</button>
          {source && source.connector !== 'manual' && <button type="button" disabled={!source.enabled || dirty || save.pending || poll.pending}
            onClick={() => poll.run(async () => {
              const result = await bff<{ queued: boolean }>('POST', 'sources/' + source.id + '/poll');
              if (result.ok && !result.data.queued) return { ok: false, error: 'Nguồn đã có lượt quét đang chờ hoặc vừa thay đổi. Kiểm tra trạng thái quét.' };
              return result;
            }, 'Đã gửi yêu cầu quét. Worker sẽ cập nhật kết quả.')}>
            {poll.pending ? 'Đang gửi…' : 'Quét ngay'}
          </button>}
          {source && source.connector === 'manual' && <Link href="/import">Mở trang nhập bài</Link>}
        </div>
        <Feedback state={save} />
        <Feedback state={poll} />
      </form>
      {source && source.connector !== 'manual' && (
        <div className={styles.scanStatus}>
          <dl>
            <div><dt>Lượt quét gần nhất</dt><dd>{fmtTime(source.lastPollAt)}</dd></div>
            <div><dt>Lần đọc thành công</dt><dd>{fmtTime(source.lastSuccessAt)}</dd></div>
            {source.watermark?.lastReadCount !== undefined && <div><dt>Số bài đọc được</dt><dd>{source.watermark.lastReadCount}</dd></div>}
          </dl>
          {source.lastError && (source.lastErrorAt ?? '') > (source.lastSuccessAt ?? '') && <p className="err">{source.lastError}</p>}
          {!source.baselineDone && <p>{['fb-public', 'fb-session'].includes(source.connector) ? 'Lần quét đầu đưa các bài tìm được vào luồng xử lý.' : 'Lần quét thành công đầu tiên lưu các bài hiện có làm mốc.'}</p>}
        </div>
      )}
    </Panel>
  );
}

function targetDraft(t?: TargetT) {
  return { code: t?.code ?? '', name: t?.name ?? '', externalId: t?.externalId ?? '', connector: t?.connector ?? 'fake', audience: t?.audience ?? 'ONLY_ME', enabled: t?.enabled ?? true };
}

function ExtensionPairing({ target }: { target: TargetT }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const last = target.profile?.workerNode?.lastHeartbeatAt;
  const online = Boolean(last && Date.now() - Date.parse(last) < 75_000);
  const request = async (action: 'key' | 'revoke') => {
    setBusy(true);
    setToken('');
    const result = await bff<{ token?: string }>('POST', `targets/${target.id}/extension/${action}`);
    if (result.ok) {
      setToken(result.data.token ?? '');
      setError('');
    } else {
      setError(result.error);
    }
    setBusy(false);
  };
  return (
    <div className={styles.scanStatus}>
      <AutoRefresh seconds={10} />
      <p>{online ? 'Profile đang kết nối' : target.extension?.installationId ? 'Profile chưa online hoặc sai UID' : 'Chờ kết nối profile'}</p>
      <button type="button" disabled={busy} onClick={() => void request('key')}>{target.extension ? 'Đổi mã profile' : 'Tạo mã profile'}</button>
      {target.extension && <button type="button" disabled={busy} onClick={() => void request('revoke')}>Thu hồi mã</button>}
      {token && <label>Mã dùng trong extension của đúng UID
        <input aria-label="Mã profile mới" type="text" className="mono" readOnly value={token} onFocus={event => event.currentTarget.select()} />
      </label>}
      {error && <p role="alert">{error}</p>}
      <p>Bản 1.0 hỗ trợ bài chữ ở chế độ Chỉ mình tôi. Xác nhận liên kết ở mục Cần xử lý sau khi đăng.</p>
    </div>
  );
}

export function ImportExtensionTargets() {
  const router = useRouter();
  const [uids, setUids] = useState('');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  return (
    <details className={styles.advanced}>
      <summary>Nhập danh sách UID</summary>
      <form onSubmit={async event => {
        event.preventDefault();
        setPending(true);
        const result = await bff<{ added: unknown[]; skipped: string[] }>('POST', 'targets/extension/import', {
          uids: uids.trim().split(/\s+/),
        });
        setPending(false);
        if (!result.ok) { setMessage(result.error); return; }
        setUids('');
        setMessage(`Đã thêm ${result.data.added.length} đích, bỏ qua ${result.data.skipped.length} UID đã có.`);
        router.refresh();
      }}>
        <label htmlFor="extension-uids">UID, mỗi dòng một số</label>
        <textarea id="extension-uids" value={uids} required maxLength={6600} onChange={event => setUids(event.target.value)} />
        <button type="submit" disabled={pending}>Nhập UID</button>
        <p>Đích mới ở trạng thái tắt. Sau khi ghép đúng profile, bật từng đích để giao việc.</p>
        {message && <p role="status">{message}</p>}
      </form>
    </details>
  );
}

export function TargetForm({ target, capabilities }: { target?: TargetT; capabilities: Capabilities }) {
  const id = useId();
  const [form, setForm] = useState(() => targetDraft(target));
  const savedStyle = JSON.stringify(target?.styleProfile ?? {}, null, 2);
  const [style, setStyle] = useState(savedStyle);
  const sub = useSubmit();
  const extension = form.connector === 'fb-extension';
  const real = form.connector === 'fb-web' || extension;
  const release = capabilities.releases.find(r => r.active && r.connector === target?.connector);
  const formats = target && release ? capabilities.checks.filter(check => check.target.code === target.code && check.qualified
    && check.connector === target.connector && release.version === check.connectorVersion) : [];
  const dirty = JSON.stringify(form) !== JSON.stringify(targetDraft(target)) || style !== savedStyle;
  return (
    <Panel title={target ? 'Đích ' + target.code : 'Thêm tài khoản đích'}
      description={extension ? 'Bài được gửi tới extension trong profile Chrome đã ghép.' : real ? 'Bài được đăng qua phiên Facebook đã thiết lập cho tài khoản này.' : 'Dùng để thử luồng bằng tài khoản giả lập.'}
      right={target && <Badge s={target.enabled ? 'DONE' : 'CANCELLED'} text={target.enabled ? 'Đang bật' : 'Đã tắt'} />}>
      <form onSubmit={e => {
        e.preventDefault();
        let styleProfile: unknown;
        try { styleProfile = JSON.parse(style); } catch { styleProfile = null; }
        if (!styleProfile || typeof styleProfile !== 'object' || Array.isArray(styleProfile)) {
          return sub.run(async () => ({ ok: false, error: 'Văn phong phải là một đối tượng JSON hợp lệ.' }));
        }
        if (real && form.audience !== 'ONLY_ME' && (!target || target.audience !== form.audience || target.connector !== form.connector)
          && !window.confirm('Đăng bằng đích này với đối tượng “' + audiences[form.audience] + '”?')) return;
        sub.run(async () => {
          const result = await bff<TargetT>(target ? 'PATCH' : 'POST', target ? 'targets/' + target.id : 'targets', { ...form, styleProfile });
          if (result.ok) {
            setForm(targetDraft(target ? result.data : undefined));
            setStyle(JSON.stringify(target ? result.data.styleProfile : {}, null, 2));
          }
          return result;
        }, target ? 'Đã lưu đích' : 'Đã thêm đích');
      }}>
        <div className={styles.fields}>
          {!target && <div className="field"><label htmlFor={id + '-code'}>Mã đích</label><input id={id + '-code'} required pattern="B[0-9]+" placeholder="B6" value={form.code} onChange={e => setForm({ ...form, code: e.target.value.toUpperCase() })} /></div>}
          <div className="field"><label htmlFor={id + '-name'}>Tên tài khoản</label><input id={id + '-name'} required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></div>
          <div className="field"><label htmlFor={id + '-connector'}>Cách đăng</label><select id={id + '-connector'} value={form.connector} onChange={e => setForm({ ...form, connector: e.target.value, audience: e.target.value === 'fb-extension' ? 'ONLY_ME' : form.audience })}><option value="fake">Giả lập</option><option value="fb-web">Facebook</option><option value="fb-extension">Facebook qua extension</option></select></div>
          <div className="field"><label htmlFor={id + '-external'}>{extension ? 'UID Facebook' : real ? 'ID hoặc tên người dùng Facebook' : 'ID tài khoản giả lập'}</label><input id={id + '-external'} autoComplete="off" required pattern={extension ? '[0-9]{1,32}' : undefined} value={form.externalId} onChange={e => setForm({ ...form, externalId: e.target.value })} /></div>
          <div className="field"><label htmlFor={id + '-audience'}>Đối tượng xem</label><select id={id + '-audience'} value={form.audience} disabled={extension} onChange={e => setForm({ ...form, audience: e.target.value })}>{Object.entries(audiences).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></div>
          <Enabled checked={form.enabled} onChange={enabled => setForm({ ...form, enabled })}>Bật tài khoản đích</Enabled>
        </div>
        <details className={styles.advanced}>
          <summary>Văn phong bài đăng</summary>
          <label htmlFor={id + '-style'}>Thiết lập văn phong (JSON)</label>
          <textarea id={id + '-style'} className="mono" value={style} onChange={e => setStyle(e.target.value)} />
        </details>
        <div className={styles.formActions}><button className="primary" type="submit" disabled={sub.pending || (!!target && !dirty)}>{sub.pending ? 'Đang lưu…' : target ? 'Lưu đích' : 'Thêm đích'}</button></div>
        <Feedback state={sub} />
      </form>
      {target?.connector === 'fb-web' && <div className={styles.scanStatus}>
        <p>{target.profile ? 'Đã gắn hồ sơ trình duyệt.' : 'Cần gắn hồ sơ trình duyệt trên máy worker.'}</p>
        <p>{formats.length ? formats.length + ' định dạng đã đạt kiểm thử với phiên bản hiện hành.' : 'Định dạng đăng theo cấu hình worker. Kiểm thử là tùy chọn.'}</p>
      </div>}
      {target?.connector === 'fb-extension' && <ExtensionPairing target={target} />}
    </Panel>
  );
}

export function MappingForm({ mapping, sources, targets, mappings, onCreated }: { mapping?: MappingT; sources: SourceT[]; targets: TargetT[]; mappings: MappingT[]; onCreated: (id: string) => void }) {
  const id = useId();
  const [form, setForm] = useState(() => ({
    sourceId: mapping?.sourceId ?? sources[0]?.id ?? '', targetId: mapping?.targetId ?? '',
    enabled: mapping?.enabled ?? true, contentTtlHours: mapping?.contentTtlHours ?? 72,
    lateWindowMin: mapping?.lateWindowMin ?? 15, strictOrder: mapping?.strictOrder ?? false,
    reviewMode: mapping?.reviewMode ?? 'AUTO', maxPublishTries: mapping?.maxPublishTries ?? 2,
  }));
  const sub = useSubmit();
  const availableTargets = targets.filter(t => !mappings.some(m => m.sourceId === form.sourceId && m.targetId === t.id));
  const targetId = mapping ? form.targetId : availableTargets.find(t => t.id === form.targetId)?.id ?? availableTargets[0]?.id;
  return (
    <Panel title={mapping ? 'Duyệt và lịch đăng' : 'Tạo luồng nguồn → đích'}
      description="Mỗi đích có tối đa một lượt đăng vào đầu mỗi giờ theo giờ Việt Nam."
      right={mapping && <Link href="/schedule">Xem lịch đăng ↗</Link>}>
      <form onSubmit={e => {
        e.preventDefault();
        if (!targetId) return;
        sub.run(async () => {
          const result = await bff<MappingT>(mapping ? 'PATCH' : 'POST', mapping ? 'mappings/' + mapping.id : 'mappings', { ...form, targetId });
          if (result.ok && !mapping) onCreated(result.data.id);
          return result;
        }, mapping ? 'Đã lưu luồng' : 'Đã tạo luồng');
      }}>
        <div className={styles.fields}>
          {!mapping && <>
            <div className="field"><label htmlFor={id + '-source'}>Nguồn</label><select id={id + '-source'} required value={form.sourceId} onChange={e => setForm({ ...form, sourceId: e.target.value })}><option value="" disabled>Chọn nguồn</option>{sources.map(s => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}</select></div>
            <div className="field"><label htmlFor={id + '-target'}>Đích</label><select id={id + '-target'} required value={targetId ?? ''} onChange={e => setForm({ ...form, targetId: e.target.value })}><option value="" disabled>{targets.length ? 'Không còn đích khả dụng' : 'Thêm tài khoản đích trước'}</option>{availableTargets.map(t => <option key={t.id} value={t.id}>{t.code} · {t.name}</option>)}</select></div>
          </>}
          <div className="field"><label htmlFor={id + '-review'}>Chế độ duyệt bài mới</label><select id={id + '-review'} value={form.reviewMode} onChange={e => setForm({ ...form, reviewMode: e.target.value as MappingT['reviewMode'] })}><option value="AUTO">Tự động nếu đạt kiểm tra</option><option value="MANUAL">Luôn duyệt tay</option></select></div>
          <div className="field"><label htmlFor={id + '-window'}>Thời gian cho phép đăng muộn (phút)</label><input id={id + '-window'} type="number" min={1} max={59} required value={form.lateWindowMin || ''} onChange={e => setForm({ ...form, lateWindowMin: Number(e.target.value) })} /></div>
          <Enabled checked={form.enabled} onChange={enabled => setForm({ ...form, enabled })}>Bật luồng A → B</Enabled>
        </div>
        <p className={styles.hint}>Ví dụ cửa sổ {form.lateWindowMin || 15} phút cho phép lượt 09:00 bắt đầu đến {form.lateWindowMin > 0 && form.lateWindowMin < 60 ? '09:' + String(form.lateWindowMin).padStart(2, '0') : 'khi hết cửa sổ'}.</p>
        <details className={styles.advanced}>
          <summary>Tùy chọn hàng chờ</summary>
          <div className={styles.fields}>
            <div className="field"><label htmlFor={id + '-ttl'}>Hiệu lực bài mới (giờ)</label><input id={id + '-ttl'} type="number" min={1} required value={form.contentTtlHours || ''} onChange={e => setForm({ ...form, contentTtlHours: Number(e.target.value) })} /></div>
            <div className="field"><label htmlFor={id + '-tries'}>Số lần thử đăng tối đa</label><input id={id + '-tries'} type="number" min={1} max={5} required value={form.maxPublishTries || ''} onChange={e => setForm({ ...form, maxPublishTries: Number(e.target.value) })} /></div>
            <Enabled checked={form.strictOrder} onChange={strictOrder => setForm({ ...form, strictOrder })}>Chờ bài cũ hơn trước khi đăng bài mới</Enabled>
          </div>
        </details>
        <div className={styles.formActions}><button className="primary" type="submit" disabled={sub.pending || !form.sourceId || !targetId}>{sub.pending ? 'Đang lưu…' : mapping ? 'Lưu luồng' : 'Tạo luồng'}</button></div>
        <Feedback state={sub} />
      </form>
    </Panel>
  );
}
