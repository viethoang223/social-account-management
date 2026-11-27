import Link from 'next/link';
import { can, getSession } from '@/lib/api';
import styles from './home.module.css';

export default async function Home() {
  const { role } = await getSession();
  const operator = can.operate(role);
  const research = operator || can.review(role);
  return <section className={styles.home}>
    <h1>Trang chủ</h1>
    {operator && <div className={styles.lead}>
      <div><h2>Đăng bài mới</h2><p>Chọn tài khoản Facebook, viết nội dung và đăng.</p></div>
      <Link href="/compose" className="btn primary">Đăng bài</Link>
    </div>}
    <div className={styles.shortcuts}>
      <Link href="/library"><strong>Kho bài viết</strong><span>Tìm nội dung và xem trạng thái đăng</span></Link>
      {research && <Link href="/research"><strong>Tìm bài</strong><span>Đọc bài từ Facebook hoặc Instagram</span></Link>}
      {operator && <Link href="/assignments"><strong>Giao việc</strong><span>Chọn đầu việc và tài khoản thực hiện</span></Link>}
      {can.admin(role) && <Link href="/settings?view=targets"><strong>Tài khoản</strong><span>Kết nối và kiểm tra các tài khoản Facebook</span></Link>}
    </div>
  </section>;
}
