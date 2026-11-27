'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { API_URL, COOKIE } from '@/lib/api';

export async function login(_prev: { error?: string } | undefined, form: FormData): Promise<{ error?: string }> {
  const token = String(form.get('token') ?? '').trim();
  if (!token) return { error: 'Nhập mã truy cập.' };
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/me`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
  } catch {
    return { error: 'Không kết nối được API. Kiểm tra dịch vụ api đã chạy chưa.' };
  }
  if (res.status === 401) return { error: 'Mã truy cập không đúng.' };
  if (!res.ok) return { error: `API trả lỗi ${res.status}.` };
  const forwardedProtocol = (await headers()).get('x-forwarded-proto')?.split(',')[0]?.trim();
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    // Set WEB_INSECURE_COOKIE=1 only for plain-HTTP internal testing.
    secure: forwardedProtocol === 'https' || (process.env.NODE_ENV === 'production' && process.env.WEB_INSECURE_COOKIE !== '1'),
    path: '/',
    maxAge: 60 * 60 * 12,
  });
  redirect('/');
}

export async function logout() {
  (await cookies()).delete(COOKIE);
  redirect('/login');
}
