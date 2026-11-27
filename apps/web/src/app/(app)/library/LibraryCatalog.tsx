import Link from 'next/link';
import { ACTIVE, LIBRARY_FILTERS, SUCCESS, UNRESOLVED, type LibraryCatalog as Data, type LibraryFilter } from '@seedingsys/contracts';
import { AutoRefresh } from '@/components/client';
import { Badge } from '@/components/ui';
import { fmtTime, label } from '@/lib/format';
import type { Profiles } from './types';
import styles from './catalog.module.css';

interface Filters { filter: LibraryFilter; target: string; source: string; q: string; page: number }
const tabs: Record<LibraryFilter, string> = { all: 'Tất cả', waiting: 'Chờ đăng', published: 'Đã đăng', attention: 'Cần xử lý' };

function status(value: string) {
  if ((SUCCESS as readonly string[]).includes(value)) return 'Đã đăng';
  if ((UNRESOLVED as readonly string[]).includes(value)) return 'Cần xác minh';
  if ((ACTIVE as readonly string[]).includes(value)) return 'Đang đăng';
  if (value === 'NEEDS_REVIEW') return 'Chờ duyệt';
  if (value === 'READY' || value === 'QUEUED') return 'Chờ đăng';
  if (['FETCHING_MEDIA', 'REWRITING', 'VALIDATING'].includes(value)) return 'Đang chuẩn bị';
  if (value === 'FAILED_CONFIRMED') return 'Đăng lỗi';
  return label(value);
}

function link(filters: Filters) {
  const { filter, target, source, q, page } = filters;
  const params = new URLSearchParams({ ...(filter !== 'all' && { filter }), ...(target && { target }),
    ...(source && { source }), ...(q && { q }), ...(page > 1 && { page: String(page) }) });
  return params.size ? '/library?' + params : '/library';
}

export function LibraryCatalog({ data, profiles, filters, canOperate, canResearch }: {
  data: Data; profiles: Profiles; filters: Filters; canOperate: boolean; canResearch: boolean;
}) {
  const { filter, target, source, q, page } = filters;
  return <section className={styles.catalog}>
    {data.posts.some(post => post.accounts.some(account => status(account.status) === 'Đang đăng' || account.status === 'QUEUED')) && <AutoRefresh seconds={6} />}
    <header className={styles.heading}>
      <h1>Kho bài viết</h1>
      <div className={styles.actions}>
        {canResearch && <Link className="btn" href="/research">Tìm bài</Link>}
        {canOperate && <Link className="btn primary" href="/compose">Đăng bài</Link>}
      </div>
    </header>
    <div className={styles.panel}>
      <nav className={styles.tabs} aria-label="Trạng thái bài viết">
        {LIBRARY_FILTERS.map(tab => <Link key={tab} href={link({ ...filters, filter: tab, page: 1 })}
          aria-current={tab === filter ? 'page' : undefined}>{tabs[tab]}</Link>)}
      </nav>
      <form method="get" action="/library" className={styles.filters}>
        {filter !== 'all' && <input type="hidden" name="filter" value={filter} />}
        <input name="q" defaultValue={q} aria-label="Tìm nội dung bài" placeholder="Tìm theo nội dung bài…" maxLength={120} />
        <select name="target" defaultValue={target} aria-label="Tài khoản đăng">
          <option value="">Mọi tài khoản</option>
          {profiles.targets.map(account => <option key={account.id} value={account.code}>{account.code} · {account.name}</option>)}
        </select>
        <select name="source" defaultValue={source} aria-label="Nguồn nội dung">
          <option value="">Mọi nguồn</option>
          {profiles.sources.map(item => <option key={item.id} value={item.code}>{item.name}</option>)}
        </select>
        <button type="submit">Lọc</button>
      </form>
      {source && <div className={styles.sourceActions}><Link href={'/library?profile=' + encodeURIComponent(source)}>Quản lý nguồn này</Link>
        <Link href={'/library?profile=' + encodeURIComponent(source) + '&trash=1'}>Thùng rác của nguồn</Link></div>}
      {data.posts.length ? <div className={styles.table}>
        <table>
          <thead><tr><th>Bài viết</th><th>Tài khoản</th><th>Trạng thái</th><th>Thời gian</th></tr></thead>
          <tbody>
            {data.posts.map(post => {
              const details = '/library?' + new URLSearchParams({ profile: post.sourceCode, post: post.id, ...(target && { to: target }) });
              const states = [...new Map(post.accounts.map(account => [status(account.status), account])).entries()];
              return <tr key={post.id}>
                <td><Link className={styles.snippet} href={details}>{post.snippet || 'Bài ' + label(post.contentType).toLowerCase()}</Link>
                  <small>{post.written ? 'Tự soạn' : post.sourceName} · {label(post.contentType)}</small></td>
                <td>{post.accounts.length ? post.accounts.slice(0, 3).map(account =>
                  <div key={account.code} title={account.name}>{account.publicationId
                    ? <Link href={'/publications/' + account.publicationId}>{account.code}</Link> : account.code}
                    {' · '}{account.name}</div>) : <span className="muted">Chưa giao</span>}
                  {post.accounts.length > 3 && <Link href={details}>+{post.accounts.length - 3} tài khoản</Link>}</td>
                <td><div className={styles.badges}>{states.length ? states.map(([text, account]) =>
                  <Badge key={text} s={account.status} text={text} />) : <Badge s="COLLECTED" text="Trong kho" />}</div></td>
                <td className={styles.date}>{fmtTime(post.date)}</td>
              </tr>;
            })}
          </tbody>
        </table>
      </div> : <p className={styles.empty}>{q || target || source || filter !== 'all' ? 'Không có bài khớp bộ lọc.' : 'Kho chưa có bài viết.'}</p>}
      <footer className={styles.bottom}>
        <span>{data.total} bài</span>
        {page > 1 && <Link href={link({ ...filters, page: page - 1 })}>Trang trước</Link>}
        {data.total > page * 25 && <Link href={link({ ...filters, page: page + 1 })}>Trang sau</Link>}
      </footer>
    </div>
  </section>;
}
