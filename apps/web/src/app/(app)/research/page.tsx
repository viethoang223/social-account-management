import { redirect } from 'next/navigation';
import type { ResearchWorkspace as Data } from '@seedingsys/contracts';
import { Head } from '@/components/ui';
import { apiGet, can, getSession } from '@/lib/api';
import { ResearchWorkspace } from './ResearchWorkspace';

export default async function ResearchPage() {
  const session = await getSession();
  if (!can.operate(session.role) && !can.review(session.role)) redirect('/');
  const data = await apiGet<Data>('/research', session.token);
  return <>
    <Head title="Post Research" sub="Giao việc đọc bài và bình luận cho Chrome profile đã ghép." />
    <ResearchWorkspace data={data} canOperate={can.operate(session.role)} />
  </>;
}
