import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { EXTENSION_CONNECTOR, isExtensionPublishAudience, type PublishSnapshot } from '@seedingsys/contracts';
import { accountResource, acquireLease, audit, movePublication, releaseLease, type Tx } from '@seedingsys/db';
import { facebookPostLink, hashObject } from '@seedingsys/domain';

const action = 'publication-verify';
const actor = 'extension:publication-verify';
const runMs = 90_000;
const evidence = z.object({ uid: z.string().regex(/^\d{1,32}$/), caption: z.string().max(20_000),
  createdAt: z.number().int().nonnegative(), permalink: z.string().max(2000).url() });
export const PublicationVerifyReport = z.object({ candidates: z.array(evidence).max(2), reopened: z.boolean() });
const VerifyResult = z.object({ outcome: z.string(), candidates: z.number().optional() });

async function requestContext(t: Tx, id: string) {
  const pub = await t.publication.findUnique({ where: { id }, include: {
    target: { select: { connector: true, enabled: true, externalId: true } },
    variant: { select: { snapshot: true } },
    post: { select: { externalId: true, permalink: true } },
  } });
  if (!pub || pub.status !== 'NEEDS_OPERATOR' || pub.contentType !== 'TEXT' || !pub.committedAt || pub.permalink
    || pub.target.connector !== EXTENSION_CONNECTOR || !pub.target.enabled || !/^\d{1,32}$/.test(pub.target.externalId)) return null;
  const uid = pub.target.externalId;
  const snap = pub.variant.snapshot as unknown as PublishSnapshot | null;
  if (!snap?.caption.trim() || snap.contentType !== 'TEXT' || !isExtensionPublishAudience(snap.audience)
    || snap.media.length || hashObject(snap) !== pub.snapshotHash) return null;
  const submission = await t.publicationAttempt.findFirst({ where: { publicationId: id, kind: 'publish',
    connector: EXTENSION_CONNECTOR, committingAt: pub.committedAt }, orderBy: { attemptNo: 'desc' }, select: { evidence: true } });
  const recorded = submission?.evidence as { targetExternalId?: string; commitSignal?: { raw?: { submittedBy?: string } } } | null;
  if (recorded?.targetExternalId !== uid || recorded.commitSignal?.raw?.submittedBy !== EXTENSION_CONNECTOR) return null;

  const committed = pub.committedAt.getTime();
  return { pub, uid, caption: snap.caption, from: committed - 5_000, until: committed + 180_000 };
}

/** Called with the target row locked. Repeated requests share the same outstanding command. */
export async function queuePublicationVerify(t: Tx, publicationId: string, targetId: string, now: Date) {
  const context = await requestContext(t, publicationId);
  if (context?.pub.targetId !== targetId) return null;
  let command = await t.extensionCommand.findFirst({ where: { targetId, publicationId, action, expiresAt: { gt: now } },
    select: { id: true, expiresAt: true } });
  if (!command) command = await t.extensionCommand.create({ data: { targetId, publicationId, action, sessionId: randomUUID(),
    fencingToken: 0n, caption: '', expiresAt: new Date(now.getTime() + 30 * 60_000) }, select: { id: true, expiresAt: true } });
  return { commandId: command.id, expiresAt: command.expiresAt };
}

export async function claimPublicationVerify(t: Tx, targetId: string, uid: string, now: Date) {
  const command = await t.extensionCommand.findFirst({ where: { targetId, action, claimedAt: null, expiresAt: { gt: now } },
    orderBy: { expiresAt: 'asc' } });
  if (!command) return null;
  const context = await requestContext(t, command.publicationId);
  if (context?.pub.targetId !== targetId || context.uid !== uid) {
    await t.extensionCommand.update({ where: { id: command.id }, data: { expiresAt: now, result: { outcome: 'STALE' } } });
    return null;
  }
  const lease = await acquireLease(t, { resource: accountResource(targetId), holder: `${actor}:${command.id}`,
    ttlMs: runMs + 5_000, now, purpose: action });
  if (!lease) return null;
  await t.extensionCommand.update({ where: { id: command.id }, data: {
    claimedAt: now, expiresAt: new Date(now.getTime() + runMs), fencingToken: lease.token,
  } });
  return { id: command.id, action, lifetimeMs: runMs, caption: context.caption, from: context.from, until: context.until };
}

const normalize = (s: string) => s.replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').normalize('NFC').trim();

export async function finishPublicationVerify(t: Tx, input: { id: string; uid: string; targetId: string; now: Date;
  report: z.infer<typeof PublicationVerifyReport> | null }) {
  const { id, uid, targetId, now, report } = input;
  const command = await t.extensionCommand.findFirst({ where: { id, targetId, action, claimedAt: { not: null } } });
  if (!command) return { outcome: 'STALE' };
  if (command.result) return VerifyResult.parse(command.result);
  if (command.expiresAt <= now) return { outcome: 'EXPIRED' };

  const context = await requestContext(t, command.publicationId);
  const matches = report?.candidates ?? [];
  const row = matches[0];
  const link = facebookPostLink(row?.permalink);
  const path = link?.url.pathname.replace(/\/+$/, '');
  const story = path === '/permalink.php' || path === '/story.php';
  const owner = story ? link?.url.searchParams.get('id') : /^\/(\d+)\/posts\//.exec(path ?? '')?.[1];
  const direct = story || /^(?:\/[^/]+)?\/posts\/[\w]+$/.test(path ?? '');
  const lease = { resource: accountResource(targetId), holder: `${actor}:${id}`, token: command.fencingToken, expiresAt: command.expiresAt };
  let outcome = !context ? 'STALE' : !report ? 'UNREADABLE' : matches.length > 1 ? 'AMBIGUOUS' : !matches.length ? 'NOT_FOUND' : 'UNCONFIRMED';
  if (context?.pub.targetId === targetId && context.uid === uid && matches.length === 1 && report?.reopened && row.uid === uid
    && normalize(row.caption) === normalize(context.caption) && row.createdAt >= context.from && row.createdAt <= context.until
    && link && direct && (!owner || owner === uid) && /^\w{1,150}$/.test(link.id)
    && link.id !== context.pub.post.externalId && link.id !== facebookPostLink(context.pub.post.permalink)?.id
    && !await t.sourcePostAlias.findFirst({ where: { sourcePostId: context.pub.sourcePostId, externalId: link.id }, select: { externalId: true } })
    && !await t.publication.findFirst({ where: { targetId, id: { not: context.pub.id },
      OR: [{ externalPostId: link.id }, { permalink: link.url.href }] }, select: { id: true } })) {
    const permalink = link.url.href;
    if (await movePublication(t, { id: context.pub.id, from: 'NEEDS_OPERATOR', to: 'PUBLISHED_VERIFIED', actor, now, fence: lease,
      expectedJobVersion: context.pub.jobVersion, data: { permalink, externalPostId: link.id, verifiedAt: now, lastReason: null } })) {
      outcome = 'VERIFIED';
      await t.operatorTask.updateMany({ where: { publicationId: context.pub.id, kind: 'CONFIRM_RESULT', status: { in: ['OPEN', 'CLAIMED'] } },
        data: { status: 'DONE', resolvedBy: actor, resolution: { permalink, method: 'extension-reopened-post' }, closedAt: now } });
    } else outcome = 'STALE';
  }

  const result = { outcome, candidates: matches.length };
  await t.extensionCommand.update({ where: { id }, data: { expiresAt: now, result } });
  await audit(t, { entityType: 'publication', entityId: command.publicationId, action, actor, at: now, data: {
    ...result, ...(outcome === 'VERIFIED' && { uid, createdAt: row.createdAt, permalink: link?.url.href }),
  } });
  await releaseLease(t, lease, now);
  return result;
}
