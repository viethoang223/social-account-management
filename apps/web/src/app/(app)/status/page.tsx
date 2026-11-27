import Link from 'next/link';
import { AutoRefresh } from '@/components/client';
import { Badge, Empty, Head, Kpi } from '@/components/ui';
import { apiGet } from '@/lib/api';
import { ago, fmtTime, label, pct, reasonText } from '@/lib/format';

interface Dash {
  at: string;
  sources: Array<{ code: string; enabled: boolean; lastSuccessAt: string | null; lagSec: number | null; stale: boolean; lastError: string | null; lastErrorAt: string | null; incomplete: string[] | null; paused: boolean }>;
  targets: Array<{ code: string; enabled: boolean; audience: string; ready: number; oldestReadyAgeMin: number | null; paused: string | null }>;
  slots24h: Record<string, number>;
  publications24hByFormat: Record<string, { verified: number; operatorConfirmed: number; failed: number; unknown: number; total: number }>;
  openTasks: Record<string, number>;
  llmToday: { usd: number; inputTokens: number; outputTokens: number };
  killSwitches: Array<{ scope: string; scopeKey: string; reason: string | null }>;
  workers: Array<{ name: string; kind: string; lastHeartbeatAt: string | null }>;
}

export default async function SystemStatus() {
  const d = await apiGet<Dash>('/dashboard');
  const now = new Date(d.at).getTime();
  const staleSources = d.sources.filter((s) => s.enabled && s.stale);
  const erroredSources = d.sources.filter((s) => s.enabled && s.lastError && (!s.lastSuccessAt || (s.lastErrorAt ?? '') > s.lastSuccessAt));
  const pausedTargets = d.targets.filter((t) => t.paused !== null);
  const deadWorkers = d.workers.filter((w) => !w.lastHeartbeatAt || now - new Date(w.lastHeartbeatAt).getTime() > 2 * 60_000);
  const tasks = (d.openTasks.REVIEW_CONTENT ?? 0) + (d.openTasks.TAKEOVER_ACCOUNT ?? 0) + (d.openTasks.CONFIRM_RESULT ?? 0);
  const unknown = Object.values(d.publications24hByFormat).reduce((n, f) => n + f.unknown, 0);
  const ready = d.targets.reduce((n, t) => n + t.ready, 0);
  const okSources = d.sources.filter((s) => s.enabled && !s.stale).length;
  const enabledSources = d.sources.filter((s) => s.enabled).length;
  const global = d.killSwitches.find((k) => k.scope === 'GLOBAL');

  const alerts: Array<{ kind: 'bad' | 'warn'; text: string; href?: string }> = [];
  if (global) alerts.push({ kind: 'bad', text: `Toàn hệ thống đang TẠM DỪNG${global.reason ? `: ${global.reason}` : ''}`, href: '/controls' });
  for (const t of pausedTargets) alerts.push({ kind: 'bad', text: `${t.code} đang dừng — ${reasonText(t.paused ?? '')}`, href: '/tasks' });
  for (const w of deadWorkers) alerts.push({ kind: 'bad', text: `Máy ${w.name} mất heartbeat (${ago(w.lastHeartbeatAt, now)})` });
  for (const s of staleSources) alerts.push({ kind: 'warn', text: `${s.code} chưa đọc thành công trong 10 phút (${s.lastSuccessAt ? ago(s.lastSuccessAt, now) : 'chưa lần nào'})${s.lastError ? ` — ${s.lastError}` : ''}` });
  if (d.openTasks.CONFIRM_RESULT) alerts.push({ kind: 'bad', text: `${d.openTasks.CONFIRM_RESULT} bài chưa rõ kết quả cần xác nhận`, href: '/tasks' });
  if (d.openTasks.REVIEW_CONTENT) alerts.push({ kind: 'warn', text: `${d.openTasks.REVIEW_CONTENT} bài chờ duyệt`, href: '/review' });

  return (
    <>
      <AutoRefresh seconds={15} />
      <Head title="Tổng quan" sub="Tình trạng 5–10 phút gần nhất. Trang tự làm mới mỗi 15 giây." right={<div className="meta">Cập nhật {fmtTime(d.at, false)}</div>} />

      {alerts.length === 0 ? (
        <div className="alerts"><div className="alert ok">Mọi thứ đang bình thường.</div></div>
      ) : (
        <div className="alerts" role="status">
          {alerts.map((a, i) => (
            <div key={i} className={`alert ${a.kind}`}>{a.href ? <Link href={a.href}>{a.text}</Link> : a.text}</div>
          ))}
        </div>
      )}

      <div className="grid">
        <Kpi value={`${okSources}/${enabledSources}`} label="Nguồn đọc ổn" kind={okSources === enabledSources ? 'ok' : 'warn'} />
        <Kpi value={ready} label="Bài sẵn sàng trong backlog" />
        <Kpi value={tasks} label="Việc đang chờ người" kind={tasks ? 'warn' : undefined} />
        <Kpi value={unknown} label="Chưa rõ kết quả (24h)" kind={unknown ? 'bad' : undefined} />
        <Kpi value={pausedTargets.length} label="Tài khoản đang dừng" kind={pausedTargets.length ? 'bad' : undefined} />
        <Kpi value={`$${d.llmToday.usd.toFixed(2)}`} label="Chi phí LLM hôm nay" />
      </div>

      <div className="two">
        <section className="card">
          <h2>Nguồn (A)</h2>
          <div className="tw">
            <table>
              <thead><tr><th>Nguồn</th><th>Lần đọc thành công cuối</th><th>Trạng thái</th></tr></thead>
              <tbody>
                {d.sources.map((s) => (
                  <tr key={s.code}>
                    <td><strong>{s.code}</strong></td>
                    <td>{s.lastSuccessAt ? `${fmtTime(s.lastSuccessAt)} · ${ago(s.lastSuccessAt, now)}` : '—'}</td>
                    <td>
                      {!s.enabled ? <Badge s="x" text="Tắt" /> : s.paused ? <Badge s="DEFERRED" text="Tạm dừng" /> : s.stale ? <Badge s="MISSED" text="Chậm/lỗi" /> : <Badge s="DONE" text="Đọc tốt" />}
                      {s.incomplete && s.incomplete.length > 0 && <span className="muted"> · thiếu dữ liệu: {s.incomplete.join(', ')}</span>}
                      {s.lastError && s.stale && <div className="muted mono">{s.lastError}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card">
          <h2>Tài khoản đích (B)</h2>
          <div className="tw">
            <table>
              <thead><tr><th>Tài khoản</th><th className="num">Sẵn sàng</th><th>Bài cũ nhất</th><th>Trạng thái</th></tr></thead>
              <tbody>
                {d.targets.map((t) => (
                  <tr key={t.code}>
                    <td><strong>{t.code}</strong> <span className="muted">· {t.audience === 'ONLY_ME' ? 'Chỉ mình tôi' : t.audience}</span></td>
                    <td className="num">{t.ready}</td>
                    <td>{t.oldestReadyAgeMin === null ? '—' : `${t.oldestReadyAgeMin} phút`}</td>
                    <td>{!t.enabled ? <Badge s="x" text="Tắt" /> : t.paused !== null ? <Badge s="NEEDS_OPERATOR" text="Đang dừng" /> : <Badge s="DONE" text="Hoạt động" />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <div className="two">
        <section className="card">
          <h2>Lượt đăng 24 giờ qua</h2>
          {Object.keys(d.slots24h).length === 0 ? <Empty>Chưa có lượt nào.</Empty> : (
            <div className="chips">
              {Object.entries(d.slots24h).map(([k, v]) => (
                <span key={k}><Badge s={k} /> <strong>{v}</strong></span>
              ))}
            </div>
          )}
        </section>

        <section className="card">
          <h2>Kết quả theo định dạng (24h)</h2>
          {Object.keys(d.publications24hByFormat).length === 0 ? <Empty>Chưa có bài đăng.</Empty> : (
            <div className="tw">
              <table>
                <thead><tr><th>Định dạng</th><th className="num">Thành công</th><th className="num">Thất bại</th><th className="num">Chưa rõ</th><th className="num">Tỷ lệ</th></tr></thead>
                <tbody>
                  {Object.entries(d.publications24hByFormat).map(([k, f]) => {
                    const ok = f.verified + f.operatorConfirmed;
                    return (
                      <tr key={k}>
                        <td>{label(k)}</td>
                        <td className="num">{ok}{f.operatorConfirmed > 0 && <span className="muted"> ({f.operatorConfirmed} do người)</span>}</td>
                        <td className="num">{f.failed}</td>
                        <td className="num">{f.unknown}</td>
                        <td className="num">{pct(ok, ok + f.failed + f.unknown)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="muted" style={{ margin: '8px 0 0' }}>“Chưa rõ” không bao giờ được tính là thành công.</p>
            </div>
          )}
        </section>
      </div>

      <section className="card">
        <h2>Máy chạy &amp; công tắc dừng</h2>
        <div className="tw">
          <table>
            <thead><tr><th>Máy</th><th>Loại</th><th>Heartbeat</th></tr></thead>
            <tbody>
              {d.workers.map((w) => (
                <tr key={w.name}>
                  <td className="mono">{w.name}</td>
                  <td>{w.kind}</td>
                  <td>{w.lastHeartbeatAt ? <>{ago(w.lastHeartbeatAt, now)} {now - new Date(w.lastHeartbeatAt).getTime() > 2 * 60_000 && <Badge s="MISSED" text="Mất tín hiệu" />}</> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ marginBottom: 0 }}>
          {d.killSwitches.length === 0 ? <span className="muted">Không có công tắc dừng nào đang bật.</span> : <>Đang bật {d.killSwitches.length} công tắc dừng — <Link href="/controls">xem</Link>.</>}
        </p>
      </section>
    </>
  );
}
