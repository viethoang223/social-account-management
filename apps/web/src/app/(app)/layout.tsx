import type { ReactNode } from 'react';
import { logout } from '../login/actions';
import { NavLink } from '@/components/client';
import { apiGet, can, getSession } from '@/lib/api';

interface Dash {
  openTasks: Record<string, number>;
}

const ROLE_VI: Record<string, string> = { admin: 'Quản trị', reviewer: 'Người duyệt', operator: 'Vận hành', viewer: 'Chỉ xem' };

export default async function AppLayout({ children }: { children: ReactNode }) {
  const s = await getSession();
  const dash = await apiGet<Dash>('/dashboard', s.token).catch(() => null);
  const t = dash?.openTasks ?? {};
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          SeedingSys<small>Bảng vận hành</small>
        </div>
        <nav className="nav" aria-label="Điều hướng chính">
          <NavLink href="/">Tổng quan</NavLink>
          <NavLink href="/library">Kho bài viết</NavLink>
          <NavLink href="/review" count={t.REVIEW_CONTENT} warn>Duyệt bài</NavLink>
          {can.review(s.role) && <NavLink href="/personas">Phân vai &amp; Radar</NavLink>}
          <NavLink href="/tasks" count={(t.TAKEOVER_ACCOUNT ?? 0) + (t.CONFIRM_RESULT ?? 0)}>Cần xử lý</NavLink>
          {(can.review(s.role) || can.operate(s.role)) && <NavLink href="/import">Nhập bài</NavLink>}
          <NavLink href="/publications">Bài đã đăng</NavLink>
          <NavLink href="/schedule">Lịch &amp; backlog</NavLink>
          <NavLink href="/controls">Công tắc dừng</NavLink>
          <NavLink href="/reports">Báo cáo</NavLink>
          {can.admin(s.role) && <NavLink href="/settings">Quản trị luồng đăng</NavLink>}
        </nav>
        <div className="who">
          <div>{ROLE_VI[s.role] ?? s.role}</div>
          <form action={logout}>
            <button type="submit" className="sm" style={{ marginTop: 6 }}>Đăng xuất</button>
          </form>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
