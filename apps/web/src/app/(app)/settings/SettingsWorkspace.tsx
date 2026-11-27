'use client';

import Link from 'next/link';
import { useState } from 'react';
import { AutoRefresh } from '@/components/client';
import { Badge, Empty } from '@/components/ui';
import { fmtTime, label } from '@/lib/format';
import { ImportExtensionTargets, MappingForm, Panel, SourceForm, TargetForm, sourceMethods, sourceStatus, type Capabilities, type MappingT, type SourceT, type TargetT } from './SettingsForms';
import { ParentAccounts, type ParentAccount } from './ParentAccounts';
import styles from './settings.module.css';

const views = { flows: 'Luồng đăng', sources: 'Nguồn nội dung', parents: 'Tài khoản A', targets: 'Tài khoản B' };
type View = keyof typeof views;

function Readiness({ capabilities }: { capabilities: Capabilities }) {
  return <details className={styles.capability}>
    <summary>Kết quả kiểm thử định dạng</summary>
    <p className="muted">Worker dùng định dạng Facebook đang bật trong cấu hình. Xem kết quả kiểm thử theo phiên bản tại đây.</p>
    {capabilities.checks.length ? <div className="tw">
      <table>
        <thead><tr><th>Đích</th><th>Định dạng</th><th>Phiên bản</th><th>Kết quả</th><th>Ca đạt</th><th>Lần kiểm thử</th></tr></thead>
        <tbody>{capabilities.checks.map(c => <tr key={c.id}>
          <td>{c.target.code}</td><td>{label(c.contentType)}</td><td className="mono">{c.connector}@{c.connectorVersion}</td>
          <td><Badge s={c.qualified ? 'DONE' : 'MISSED'} text={c.qualified ? 'Đạt' : c.passed ? 'Thiếu ca kiểm thử' : 'Chưa đạt'} />{c.notes && <div className="muted">{c.notes}</div>}</td>
          <td>{c.cases - c.failures}/{c.cases}</td><td>{fmtTime(c.checkedAt)}</td>
        </tr>)}</tbody>
      </table>
    </div> : <Empty>Chưa có kết quả kiểm thử định dạng.</Empty>}
  </details>;
}

export function SettingsWorkspace({ sources, targets, mappings, capabilities, parents, initialView: view, initialTarget }: {
  sources: SourceT[]; targets: TargetT[]; mappings: MappingT[]; capabilities: Capabilities; parents: ParentAccount[]; initialView: View; initialTarget?: string;
}) {
  const bySource = new Map(sources.map(s => [s.id, s]));
  const byTarget = new Map(targets.map(t => [t.id, t]));
  const viewsOfFlow = mappings.flatMap(m => {
    const source = bySource.get(m.sourceId);
    const target = byTarget.get(m.targetId);
    return source && target ? [{ mapping: m, source, target, name: source.code + ' → ' + target.code }] : [];
  }).sort((a, b) => a.name.localeCompare(b.name, 'vi', { numeric: true }));
  const [flowId, setFlowId] = useState(viewsOfFlow[0]?.mapping.id ?? 'new');
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? 'new');
  const [targetId, setTargetId] = useState(initialTarget ?? targets[0]?.id ?? 'new');
  const activeFlow = viewsOfFlow.find(f => f.mapping.id === flowId);

  return <div className={styles.workspace}>
    {view !== 'parents' && <AutoRefresh seconds={15} />}
    <header className={styles.heading}>
      <div>
        <h1>{view === 'flows' ? 'Cấu hình luồng đăng' : views[view]}</h1>
      </div>
      <Link className={styles.secondaryAction} href="/schedule">Mở lịch &amp; backlog <span aria-hidden>↗</span></Link>
    </header>
    <nav className={styles.tabs} aria-label="Mục quản trị">
      {(Object.entries(views) as Array<[View, string]>).map(([key, title]) =>
        <Link key={key} href={key === 'flows' ? '/settings' : `/settings?view=${key}`} aria-current={view === key ? 'page' : undefined}>{title}</Link>)}
    </nav>
    {view === 'flows' && <>
      <ol className={styles.stages} aria-label="Các bước xử lý bài">
        <li><span aria-hidden>1</span><div><strong>Quét nguồn</strong><small>Đọc bài mới theo chu kỳ</small></div></li>
        <li><span aria-hidden>2</span><div><strong>Lưu &amp; duyệt</strong><small>Lưu bài và media · Duyệt nếu cần</small></div></li>
        <li><span aria-hidden>3</span><div><strong>Đăng &amp; xác minh</strong><small>Theo lịch hoặc từ Backlog</small></div></li>
      </ol>
      <div className={styles.workArea}>
        <aside className={styles.flowList} aria-label="Danh sách luồng">
          <div className={styles.listHeading}><h2>Luồng đang cấu hình</h2><span>{viewsOfFlow.length}</span></div>
          <div className={styles.flowItems}>
            {viewsOfFlow.map(f => {
              const enabled = f.mapping.enabled && f.source.enabled && f.target.enabled;
              const status = sourceStatus(f.source);
              return <button className={styles.flowItem} key={f.mapping.id} aria-pressed={f.mapping.id === flowId} onClick={() => setFlowId(f.mapping.id)} type="button">
                <span><strong>{f.name}</strong><small>{sourceMethods[f.source.connector] ?? f.source.connector}</small></span>
                <Badge s={!enabled ? 'CANCELLED' : status.tone === 'MISSED' ? 'MISSED' : 'DONE'} text={!enabled ? 'Đã tắt' : status.tone === 'MISSED' ? 'Lỗi quét' : 'Đang bật'} />
              </button>;
            })}
          </div>
          <button className={styles.addFlow} aria-pressed={flowId === 'new'} type="button" onClick={() => setFlowId('new')}>+ Tạo luồng</button>
        </aside>
        <div className={styles.flowMain}>
          {activeFlow ? <>
            <div className={styles.flowTitle}>
              <div><h2>{activeFlow.name}</h2><p>{activeFlow.source.name} <span aria-hidden>→</span> {activeFlow.target.name}</p></div>
              <Link href="/review">Mở hàng duyệt ↗</Link>
            </div>
            <div className={styles.cards}>
              <SourceForm key={activeFlow.source.id} source={activeFlow.source} />
              <TargetForm key={activeFlow.target.id} target={activeFlow.target} capabilities={capabilities} />
            </div>
            <MappingForm key={activeFlow.mapping.id} {...{ sources, targets, mappings }} mapping={activeFlow.mapping} />
            {(mappings.filter(m => m.sourceId === activeFlow.source.id).length > 1 || mappings.filter(m => m.targetId === activeFlow.target.id).length > 1)
              && <p className={styles.hint}>Các luồng dùng chung nguồn hoặc đích sẽ dùng chung cấu hình của nguồn hoặc đích đó.</p>}
          </> : flowId === 'new' ? <>
            {(!sources.length || !targets.length) && <Panel title="Chuẩn bị nguồn và đích">
              <p className="muted">Tạo nguồn và tài khoản đích trước khi ghép thành luồng.</p>
              <div className="actions">
                {!sources.length && <Link className="btn" href="/settings?view=sources">Thêm nguồn</Link>}
                {!targets.length && <Link className="btn" href="/settings?view=targets">Thêm đích</Link>}
              </div>
            </Panel>}
            <MappingForm {...{ sources, targets, mappings }} />
          </> : <Empty>Đang tải luồng vừa tạo…</Empty>}
        </div>
      </div>
    </>}
    {view === 'sources' && <div className={styles.resource}>
      <div className={styles.resourcePicker}><label htmlFor="admin-source">Nguồn quét</label><select id="admin-source" value={sourceId} onChange={e => setSourceId(e.target.value)}>
        {sources.map(s => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}<option value="new">+ Thêm nguồn</option>
      </select></div>
      <SourceForm key={sourceId} source={bySource.get(sourceId)} />
    </div>}
    {view === 'parents' && <div className={styles.resource}><ParentAccounts initialAccounts={parents} /></div>}
    {view === 'targets' && <div className={styles.resource}>
      <ImportExtensionTargets />
      <div className={styles.resourcePicker}><label htmlFor="admin-target">Tài khoản đích</label><select id="admin-target" value={targetId} onChange={e => setTargetId(e.target.value)}>
        {targets.map(t => <option key={t.id} value={t.id}>{t.code} · {t.name}</option>)}<option value="new">+ Thêm đích</option>
      </select></div>
      <TargetForm key={targetId} target={byTarget.get(targetId)} capabilities={capabilities} />
      <Readiness capabilities={capabilities} />
    </div>}
  </div>;
}
