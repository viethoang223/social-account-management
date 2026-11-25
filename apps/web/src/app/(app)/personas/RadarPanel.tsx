'use client';

import type { RadarAxis, RadarReport, RadarScanSummary, RadarSummary } from '@seedingsys/contracts';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { fmtTime } from '@/lib/format';
import { AutoRefresh, bff } from '@/components/client';
import styles from './personas.module.css';

function RadarChart({ axes, title }: { axes: RadarAxis[]; title: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context) return;
    const size = 320;
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    element.width = size * scale;
    element.height = size * scale;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    const center = size / 2;
    const radius = 108;
    const point = (index: number, fraction: number) => {
      const angle = Math.PI * 2 * index / axes.length - Math.PI / 2;
      return { x: center + radius * fraction * Math.cos(angle), y: center + radius * fraction * Math.sin(angle) };
    };
    for (const fraction of [.25, .5, .75, 1]) {
      context.beginPath();
      axes.forEach((_, index) => {
        const { x, y } = point(index, fraction);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.closePath();
      context.strokeStyle = '#cbd9df';
      context.stroke();
    }
    context.font = '600 13px system-ui';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    axes.forEach((axis, index) => {
      const outer = point(index, 1);
      const label = point(index, 1.22);
      context.beginPath();
      context.moveTo(center, center);
      context.lineTo(outer.x, outer.y);
      context.strokeStyle = '#cbd9df';
      context.stroke();
      context.fillStyle = axis.score === null ? '#6f7d89' : '#173c48';
      context.fillText(String(index + 1), label.x, label.y);
    });
    if (axes.every(axis => axis.score !== null)) {
      context.beginPath();
      axes.forEach((axis, index) => {
        const { x, y } = point(index, axis.score! / 100);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.closePath();
      context.fillStyle = '#21738728';
      context.fill();
      context.strokeStyle = '#217387';
      context.lineWidth = 2;
      context.stroke();
    }
    axes.forEach((axis, index) => {
      if (axis.score === null) return;
      const { x, y } = point(index, axis.score / 100);
      context.beginPath();
      context.arc(x, y, 4, 0, Math.PI * 2);
      context.fillStyle = axis.manual ? '#935409' : '#217387';
      context.fill();
    });
  }, [axes]);
  return <canvas ref={canvas} className={styles.radarChart} role="img" aria-label={`Biểu đồ ${title}. Bảng bên dưới ghi điểm từng trục.`} />;
}

type Group = 'demographic' | 'personality';

function ScoreEditor({ axis, onSave }: { axis: RadarAxis; onSave: (score: number | null) => Promise<string | null> }) {
  const [value, setValue] = useState(axis.score?.toString() ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const score = value === '' ? undefined : Number(value);
  const save = async (next: number | null) => {
    setBusy(true);
    setError(await onSave(next) ?? '');
    setBusy(false);
  };
  return <form className={styles.binding} onSubmit={event => {
    event.preventDefault();
    if (score !== undefined && Number.isInteger(score) && score >= 0 && score <= 100) void save(score);
  }}>
    <label>Điểm {axis.label}<input type="number" inputMode="numeric" min={0} max={100} step={1} required value={value}
      onChange={event => setValue(event.target.value)} /></label>
    <button type="submit" disabled={busy || score === undefined || score === axis.score}>Lưu điểm</button>
    {axis.manual && <button type="button" disabled={busy} onClick={() => void save(null)}>Về điểm gốc</button>}
    {error && <p className="err" role="alert">{error}</p>}
  </form>;
}

function RadarGroup({ title, group, axes, onScore }: {
  title: string; group: Group; axes: RadarAxis[];
  onScore?: (group: Group, id: string, score: number | null) => Promise<string | null>;
}) {
  return <section className={styles.radarGroup}>
    <h3>{title}</h3>
    <RadarChart axes={axes} title={title} />
    <ol className={styles.axes}>{axes.map(a => <li key={a.id}>
      <div className={styles.axisTitle}>
        <strong>{a.label}</strong><span>{a.score === null ? 'Chưa đủ dữ liệu' : `${a.score}/100`}</span>
      </div>
      <small className="muted">{[a.manual ? 'Chỉnh tay' : '', a.confidence && `Độ tin cậy: ${a.confidence}`].filter(Boolean).join(' · ')}</small>
      {onScore && <details><summary>Chỉnh điểm</summary>
        <ScoreEditor key={a.id + ':' + a.score + ':' + a.manual} axis={a} onSave={score => onScore(group, a.id, score)} />
      </details>}
      {(a.note || a.evidence.length > 0) && <details>
        <summary>Bằng chứng và ghi chú</summary>
        {a.note && <p>{a.note}</p>}
        {a.evidence.length > 0 && <ul>{a.evidence.map((entry, index) =>
          <li key={index}>{entry.text}{entry.why && <span className="muted"> · {entry.why}</span>}</li>)}</ul>}
      </details>}
    </li>)}</ol>
  </section>;
}

const scanLabel = { QUEUED: 'Chờ profile', RUNNING: 'Đang quét', COMPLETE: 'Hoàn tất', FAILED: 'Không đọc được', EXPIRED: 'Hết hạn' };

function RadarScanner() {
  const router = useRouter();
  const [url, setUrl] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean }>();
  return <form className={styles.form} onSubmit={async event => {
    event.preventDefault();
    setBusy(true);
    const result = await bff<{ targetCode: string }>('POST', 'personas/radar/scan', { url: url.trim(), publicConfirmed: confirmed });
    setBusy(false);
    if (result.ok) {
      setUrl('');
      setConfirmed(false);
      setMessage({ text: `Đã giao lượt Radar cho ${result.data.targetCode}.` });
      router.refresh();
    } else setMessage({ text: result.error, error: true });
  }}>
    <label>Trang Facebook cần đọc<input type="url" required maxLength={500} value={url} onChange={e => setUrl(e.target.value)} /></label>
    <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> Trang công khai của khách đã liên hệ</label>
    <button className="primary" disabled={!confirmed || busy}>Giao việc quét Radar</button>
    {message && <p role={message.error ? 'alert' : 'status'} className={message.error ? 'err' : 'okmsg'}>{message.text}</p>}
  </form>;
}

export function RadarPanel({ radars, scans, canManage, importForm }: {
  radars: RadarSummary[]; scans: RadarScanSummary[]; canManage: boolean; importForm: ReactNode;
}) {
  const [selected, select] = useState(radars[0]?.id ?? '');
  const [loaded, setLoaded] = useState<{ id: string; report: RadarReport } | null>(null);
  const [error, setError] = useState('');
  const radar = radars.find(r => r.id === selected) ?? radars[0];
  useEffect(() => {
    if (!radar) return;
    const controller = new AbortController();
    setLoaded(null);
    setError('');
    void fetch(`/bff/personas/radar/${radar.id}`, { signal: controller.signal, cache: 'no-store' })
      .then(async response => {
        if (!response.ok) throw new Error('Không tải được Radar.');
        const result: { id: string; report: RadarReport } = await response.json();
        if (!controller.signal.aborted) setLoaded(result);
      })
      .catch(() => { if (!controller.signal.aborted) setError('Không tải được Radar. Thử mở lại hồ sơ.'); });
    return () => controller.abort();
  }, [radar]);
  const onScore = canManage && radar ? async (group: Group, axisId: string, score: number | null) => {
    const result = await bff<{ id: string; report: RadarReport }>('POST', `personas/radar/${radar.id}/score`, { group, axisId, score });
    if (!result.ok) return result.error;
    setLoaded(result.data);
    return null;
  } : undefined;
  return <>
    {scans.some(scan => scan.state === 'RUNNING' || scan.state === 'QUEUED') && <AutoRefresh seconds={8} />}
    {canManage && <section className={styles.card}>
      <h2>Tạo hồ sơ Radar</h2>
      <RadarScanner />
      <details className={styles.relation}><summary>Nhập hồ sơ Radar từ JSON</summary>{importForm}</details>
    </section>}
    {scans.length > 0 && <section className={styles.card}>
      <h2>Lượt quét gần đây</h2>
      <ul className={styles.scanList}>
        {scans.map(scan => <li key={scan.id}>
          <span>{scan.targetCode} · {scanLabel[scan.state]} · {fmtTime(scan.createdAt)}</span>
          <span className="muted">{scan.url}</span>
          {scan.radarId && radars.some(r => r.id === scan.radarId) && <button type="button" onClick={() => select(scan.radarId!)}>Xem Radar</button>}
        </li>)}
      </ul>
    </section>}
    <section className={styles.card}>
      <h2>Radar khách hàng</h2>
      {radar ? <>
        <label>Hồ sơ<select value={radar.id} onChange={e => select(e.target.value)}>
          {radars.map(r => <option key={r.id} value={r.id}>{r.name || r.url}</option>)}
        </select></label>
        <p className="muted">{fmtTime(radar.analyzedAt)} · <a href={radar.url} target="_blank" rel="noreferrer">Mở trang tham chiếu</a></p>
        {loaded?.id === radar.id ? <div className={styles.twoColumns}>
          <RadarGroup title="Nhân khẩu" group="demographic" axes={loaded.report.demographic} onScore={onScore} />
          <RadarGroup title="Tính cách" group="personality" axes={loaded.report.personality} onScore={onScore} />
        </div> : <p role={error ? 'alert' : 'status'}>{error || 'Đang tải hồ sơ…'}</p>}
      </> : <p className="muted">Chưa có hồ sơ Radar.</p>}
    </section>
  </>;
}
