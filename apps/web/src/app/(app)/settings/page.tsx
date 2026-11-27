import { redirect } from 'next/navigation';
import { apiGet, can, getSession } from '@/lib/api';
import { SettingsWorkspace } from './SettingsWorkspace';
import type { Capabilities, MappingT, SourceT, TargetT } from './SettingsForms';
import type { ParentAccount } from './ParentAccounts';

export default async function Settings({ searchParams }: { searchParams: Promise<{ view?: string; target?: string }> }) {
  const session = await getSession();
  if (!can.admin(session.role)) redirect('/');
  const params = await searchParams;
  const initialView = params.view === 'targets' || params.view === 'parents' || params.view === 'sources' ? params.view : 'flows';
  const [sources, targets, mappings, capabilities, parents] = await Promise.all([
    apiGet<SourceT[]>('/sources', session.token),
    apiGet<TargetT[]>('/targets', session.token),
    apiGet<MappingT[]>('/mappings', session.token),
    apiGet<Capabilities>('/capabilities', session.token),
    initialView === 'parents' ? apiGet<ParentAccount[]>('/parent-accounts', session.token) : Promise.resolve([]),
  ]);
  const initialTarget = targets.find(item => item.code === params.target)?.id;
  return <SettingsWorkspace key={initialView + ':' + (initialTarget ?? '')} {...{ sources, targets, mappings, capabilities, parents, initialView, initialTarget }} />;
}
