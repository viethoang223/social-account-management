import { redirect } from 'next/navigation';
import type { ComposeAccount } from '@seedingsys/contracts';
import { apiGet, can, getSession } from '@/lib/api';
import { Composer } from './Composer';

export default async function ComposePage() {
  const session = await getSession();
  if (!can.operate(session.role)) redirect('/library');
  const accounts = await apiGet<ComposeAccount[]>('/compose/accounts', session.token);
  return <Composer accounts={accounts} canManage={can.admin(session.role)} />;
}
