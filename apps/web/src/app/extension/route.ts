import { API_URL } from '@/lib/api';

/** Only forwards the profile protocol, using the extension's scoped key. */
export async function POST(request: Request) {
  const authorization = request.headers.get('authorization') ?? '';
  if (!/^Bearer profile_[\w-]{43}$/.test(authorization)) {
    return Response.json({ message: 'Mã profile không hợp lệ.' }, { status: 401 });
  }
  const body = await request.text();
  if (body.length > 2048) return Response.json({ message: 'Yêu cầu quá lớn.' }, { status: 413 });
  try {
    const upstream = await fetch(`${API_URL}/api/extension`, {
      method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body, cache: 'no-store', signal: AbortSignal.timeout(12_000),
    });
    return new Response(upstream.body, {
      status: upstream.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch {
    return Response.json({ message: 'Không kết nối được API.' }, { status: 502 });
  }
}
