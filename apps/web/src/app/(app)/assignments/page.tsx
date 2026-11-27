import { redirect } from 'next/navigation';
import type { AssignmentWorkspaceData } from '@seedingsys/contracts';
import { Head } from '@/components/ui';
import { apiGet, can, getSession } from '@/lib/api';
import { AssignmentWorkspace } from './AssignmentWorkspace';

export default async function AssignmentPage() {
  const session = await getSession();
  if (!can.operate(session.role)) redirect('/');
  const data = await apiGet<AssignmentWorkspaceData>('/assignments', session.token);
  return <>
    <Head title="Giao việc X và Y" />
    <AssignmentWorkspace data={data} />
  </>;
}
