'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import type { ComposeAccount, ComposeReceipt, ContentType } from '@seedingsys/contracts';
import styles from './compose.module.css';

const audiences: Record<string, string> = { PUBLIC: 'Công khai', ONLY_ME: 'Chỉ mình tôi', FRIENDS: 'Bạn bè' };
const maxLength = 5000;

export function Composer({ accounts, canManage }: { accounts: ComposeAccount[]; canManage: boolean }) {
  const ready = accounts.filter(account => !account.unavailable);
  const [targetId, setTargetId] = useState(() => ready.length === 1 ? ready[0].id : '');
  const [caption, setCaption] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<ComposeReceipt | null>(null);
  const request = useRef<{ signature: string; id: string } | null>(null);
  const selected = accounts.find(account => account.id === targetId);
  const formats = selected?.formats ?? [];
  const photos = formats.includes('SINGLE_PHOTO') || formats.includes('MULTI_PHOTO');
  const video = formats.includes('VIDEO');
  const format: ContentType = files.some(file => file.type.startsWith('video/') || (!file.type && /\.(?:mp4|mov)$/i.test(file.name))) ? 'VIDEO'
    : files.length > 1 ? 'MULTI_PHOTO' : files.length ? 'SINGLE_PHOTO' : 'TEXT';
  const valid = !!(selected && !selected.unavailable && formats.includes(format) && caption.trim());

  async function publish() {
    if (!selected || !valid || pending) return;
    setError('');
    setPending(true);
    const signature = JSON.stringify([targetId, selected.audience, caption, files.map(file => [file.name, file.size, file.lastModified])]);
    if (request.current?.signature !== signature) request.current = { signature, id: crypto.randomUUID() };
    const form = new FormData();
    form.set('id', request.current.id);
    form.set('targetId', targetId);
    form.set('text', caption);
    form.set('audience', selected.audience);
    for (const file of files) form.append('media', file);
    try {
      const response = await fetch('/bff/compose', { method: 'POST', headers: { 'x-requested-with': 'seedingsys' }, body: form });
      if (response.status === 401) {
        window.location.assign('/login?expired=1');
        return;
      }
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        const message = result?.message;
        setError(Array.isArray(message) ? message.join('. ') : message || 'Chưa gửi được bài. Thử lại sau.');
        return;
      }
      setReceipt(result as ComposeReceipt);
    } catch {
      setError('Mất kết nối khi gửi bài. Bấm đăng lại để kiểm tra cùng yêu cầu.');
    } finally {
      setPending(false);
    }
  }

  return <section className={styles.workspace}>
    <header className={styles.heading}><div><Link href="/library" className={styles.back}>← Kho bài viết</Link><h1>Đăng bài</h1></div></header>
    {receipt ? <div className={styles.receipt} role="status">
      <h2>Đã gửi bài để đăng lên {receipt.targetCode}</h2>
      <p>Trạng thái cập nhật khi hệ thống xác minh trên Facebook.</p>
      <Link className="btn primary" href={'/publications/' + receipt.publicationId}>Xem trạng thái</Link>
      <button type="button" onClick={() => { setReceipt(null); setCaption(''); setFiles([]); request.current = null; }}>Soạn bài khác</button>
    </div> : <form className={styles.editor} onSubmit={event => { event.preventDefault(); void publish(); }}>
      <div className={styles.target}>
        <label htmlFor="compose-account">Đăng bằng tài khoản</label>
        <select id="compose-account" value={targetId} onChange={event => { setTargetId(event.target.value); setFiles([]); }} required disabled={pending}>
          <option value="">Chọn tài khoản</option>
          {ready.map(account => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}
          {accounts.some(account => account.unavailable) && <optgroup label="Chưa sẵn sàng">{accounts.filter(account => account.unavailable)
            .map(account => <option disabled key={account.id} value={account.id}>{account.code} · {account.name} · {account.unavailable}</option>)}</optgroup>}
        </select>
        {selected && <p className={styles.audience}>Đối tượng xem <strong>{audiences[selected.audience] ?? selected.audience}</strong>
          {canManage && <Link href={'/settings?' + new URLSearchParams({ view: 'targets', target: selected.code })}>Cài đặt</Link>}</p>}
        {!ready.length && <p className="muted">Chưa có tài khoản sẵn sàng đăng.
          {canManage && <> <Link href="/settings?view=targets">Mở Tài khoản</Link></>}</p>}
      </div>
      <div className={styles.content}>
        <label htmlFor="compose-caption">Nội dung bài</label>
        <textarea id="compose-caption" placeholder="Bạn muốn đăng gì?" value={caption} onChange={event => setCaption(event.target.value)}
          rows={7} maxLength={maxLength} required disabled={pending} />
        <div className={styles.mediaLine}>
          {(photos || video) ? <label className={styles.upload}>Thêm ảnh hoặc video
            <input type="file" accept={[photos && 'image/jpeg,image/png,image/webp,image/gif', video && 'video/mp4,video/quicktime'].filter(Boolean).join(',')}
              multiple={formats.includes('MULTI_PHOTO')} disabled={pending} onChange={event => {
                setFiles(Array.from(event.target.files ?? []));
                event.currentTarget.value = '';
                request.current = null;
              }} />
          </label> : <span className="muted">{selected ? 'Tài khoản này đăng được bài chữ.' : ''}</span>}
          <small className="muted">{caption.length}/{maxLength}</small>
        </div>
        {files.length > 0 && <ul className={styles.files}>{files.map((file, index) => <li key={file.name + index}>
          {file.name} <button type="button" className="sm" disabled={pending}
            onClick={() => setFiles(current => current.filter((_, i) => i !== index))} aria-label={'Bỏ ' + file.name}>Bỏ</button>
        </li>)}</ul>}
        {!formats.includes(format) && files.length > 0 && <p className="err">Tài khoản này chưa đăng được định dạng tệp đã chọn.</p>}
      </div>
      <footer className={styles.footer}>
        {error && <p className="err" role="alert">{error}</p>}
        <button className="primary" disabled={!valid || pending}>{pending ? 'Đang gửi…' : selected ? 'Đăng ngay lên ' + selected.code : 'Đăng ngay'}</button>
      </footer>
    </form>}
  </section>;
}
