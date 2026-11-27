import type { ReactNode } from 'react';
import Link from 'next/link';
import { logout } from '../login/actions';
import { NavLink } from '@/components/client';
import { can, getSession } from '@/lib/api';

const ROLE_VI: Record<string, string> = { admin: 'Quản trị', reviewer: 'Người duyệt', operator: 'Vận hành', viewer: 'Chỉ xem' };

export default async function AppLayout({ children }: { children: ReactNode }) {
  const s = await getSession();
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          SeedingSys
        </div>
        {can.operate(s.role) && <Link className="btn primary nav-compose" href="/compose">+ Đăng bài</Link>}
        <nav className="nav" aria-label="Điều hướng chính">
          <NavLink href="/">Trang chủ</NavLink>
          <NavLink href="/library">Kho bài viết</NavLink>
          {(can.review(s.role) || can.operate(s.role)) && <NavLink href="/research">Tìm bài</NavLink>}
          {can.operate(s.role) && <NavLink href="/assignments">Giao việc</NavLink>}
          {can.admin(s.role) && <NavLink href="/settings?view=targets">Tài khoản</NavLink>}
          <details className="nav-more">
            <summary>Công cụ khác</summary>
            <NavLink href="/review">Duyệt bài</NavLink>
            <NavLink href="/tasks">Cần xử lý</NavLink>
            <NavLink href="/schedule">Lịch đăng</NavLink>
            <NavLink href="/publications">Lịch sử đăng</NavLink>
            {(can.review(s.role) || can.operate(s.role)) && <NavLink href="/import">Nhập bài vào kho</NavLink>}
            {can.review(s.role) && <NavLink href="/personas">Phân vai &amp; Radar</NavLink>}
            {can.admin(s.role) && <NavLink href="/settings">Cấu hình luồng</NavLink>}
            <NavLink href="/status">Tình trạng hệ thống</NavLink>
            <NavLink href="/reports">Báo cáo</NavLink>
            <NavLink href="/controls">Công tắc dừng</NavLink>
            <form action={logout} className="nav-sign-out"><button type="submit" className="sm">Đăng xuất</button></form>
          </details>
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
