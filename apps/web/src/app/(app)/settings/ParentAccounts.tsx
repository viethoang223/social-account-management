'use client';

import { useState, type ClipboardEvent } from 'react';
import { bff, useSubmit } from '@/components/client';
import { Badge } from '@/components/ui';
import { Panel } from './SettingsForms';
import styles from './settings.module.css';

export type ParentAccount = { slot: number; uid: string | null };

export function ParentAccounts({ initialAccounts }: { initialAccounts: ParentAccount[] }) {
  const [accounts, setAccounts] = useState(initialAccounts);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [pasteError, setPasteError] = useState('');
  const save = useSubmit();
  const changes = accounts.flatMap(({ slot, uid: previousUid }) => {
    const uid = (drafts[slot] ?? previousUid ?? '').trim() || null;
    return uid === previousUid ? [] : [{ slot, uid, previousUid }];
  });

  function paste(event: ClipboardEvent<HTMLInputElement>, index: number) {
    const lines = event.clipboardData.getData('text/plain').trim().split(/\r?\n/);
    if (lines.length < 2) return;
    event.preventDefault();
    const uids = lines.map(line => line.trim());
    if (uids.some(uid => !/^\d{1,32}$/.test(uid)) || index + uids.length > accounts.length) {
      setPasteError('Dán một UID số trên mỗi dòng và kiểm tra số ô trống bên dưới.');
      return;
    }
    setPasteError('');
    setDrafts(current => ({ ...current, ...Object.fromEntries(uids.map((uid, offset) => [accounts[index + offset].slot, uid])) }));
  }

  return <Panel title="Danh bạ tài khoản mẹ" description="Gán UID Facebook cho các tài khoản A dùng để clone sang B."
    right={<span className="muted">{accounts.filter(account => account.uid).length}/{accounts.length} đã gán UID</span>}>
    <form onSubmit={event => {
      event.preventDefault();
      if (!changes.length || save.pending) return;
      setPasteError('');
      save.run(async () => {
        const result = await bff<ParentAccount[]>('PATCH', 'parent-accounts', { changes });
        if (result.ok) {
          setAccounts(result.data);
          setDrafts({});
        }
        return result;
      }, 'Đã lưu UID Facebook');
    }}>
      <p id="parent-uid-hint" className={styles.hint}>Để nhập nhiều UID, dán danh sách mỗi dòng một UID vào ô đầu tiên cần điền.</p>
      <div className={`tw ${styles.parentUidTable}`}>
        <table aria-describedby="parent-uid-hint">
          <thead><tr><th scope="col">Mã A</th><th scope="col">UID Facebook</th><th scope="col">Trạng thái lưu</th></tr></thead>
          <tbody>{accounts.map(({ slot, uid }, index) => <tr key={slot}>
            <th scope="row">A{slot}</th>
            <td><input aria-label={`UID Facebook A${slot}`} inputMode="numeric" pattern="[0-9]{1,32}" maxLength={32}
              value={drafts[slot] ?? uid ?? ''} disabled={save.pending} onPaste={event => paste(event, index)}
              onChange={event => {
                const next = event.target.value;
                setPasteError('');
                setDrafts(current => ({ ...current, [slot]: next }));
              }} /></td>
            <td><Badge s={uid ? 'DONE' : 'PLANNED'} text={uid ? 'Đã gán UID' : 'Chưa gán'} /></td>
          </tr>)}</tbody>
        </table>
      </div>
      <div className={styles.formActions}>
        <button className="primary" type="submit" disabled={!changes.length || save.pending}>{save.pending ? 'Đang lưu…' : 'Lưu UID'}</button>
        {(pasteError || save.error) && <span className="err" role="alert">{pasteError || save.error}</span>}
        {save.done && !changes.length && <span className="okmsg" role="status">{save.done}</span>}
      </div>
    </form>
  </Panel>;
}
