import { redirect } from 'next/navigation';
import type { PersonaWorkspaceData } from '@seedingsys/contracts';
import { Head } from '@/components/ui';
import { apiGet, can, getSession } from '@/lib/api';
import { PersonaWorkspace } from './PersonaWorkspace';

export default async function PersonasPage() {
  const session = await getSession();
  if (!can.review(session.role)) redirect('/');
  const data = await apiGet<PersonaWorkspaceData>('/personas', session.token);
  return <>
    <Head title="Phân vai & Radar" />
    <PersonaWorkspace data={data} canManage={can.admin(session.role)} />
  </>;
}
