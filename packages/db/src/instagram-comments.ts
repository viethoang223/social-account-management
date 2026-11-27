import type { ResearchReport } from '@seedingsys/contracts';
import { hashObject } from '@seedingsys/domain';
import type { Tx } from './index';

type ThreadReport = Extract<ResearchReport, { kind: 'RESEARCH_POST' }>;

export async function storeInstagramComments(t: Tx, sourcePostId: string, report: ThreadReport, now: Date) {
  if (report.instagramCommentStatus !== 'READ' || !report.comments.length) return 0;
  const active = await t.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM source_posts WHERE id=${sourcePostId}::uuid AND archived_at IS NULL FOR NO KEY UPDATE`;
  if (!active.length) return 0;
  const nativeKeys = new Map<string, string>();
  const ordinals = new Map<string, number>();
  let saved = 0;
  for (const [position, item] of report.comments.entries()) {
    const parentExternalId = item.parentExternalId ? nativeKeys.get(item.parentExternalId) : null;
    if (item.parentExternalId && !parentExternalId) continue;
    const fingerprint = hashObject([parentExternalId, item.name, item.text]);
    const count = ordinals.get(fingerprint) ?? 0;
    ordinals.set(fingerprint, count + 1);
    const externalId = item.externalId ? `instagram:${item.externalId}` : `instagram:${fingerprint}:${count}`;
    if (item.externalId) nativeKeys.set(item.externalId, externalId);
    await t.sourceComment.upsert({ where: { sourcePostId_externalId: { sourcePostId, externalId } },
      create: { sourcePostId, externalId, parentExternalId, authorName: item.name, text: item.text, position, lastSeenAt: now },
      update: { lastSeenAt: now } });
    saved++;
  }
  return saved;
}
