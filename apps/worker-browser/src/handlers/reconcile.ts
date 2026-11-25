import type { PublishSnapshot } from '@seedingsys/contracts';
import type { CommitSignal } from '@seedingsys/connectors-core';
import { EXTENSION_CONNECTOR, Q } from '@seedingsys/contracts';
import { accountResource, acquireLease, enqueue, heartbeatLease, movePublication, openOperatorTask, releaseLease, tx } from '@seedingsys/db';
import { FencedOutError, RetryLaterError, captionFingerprint, hashObject } from '@seedingsys/domain';
import type { BrowserCtx } from '../ctx';
import { withTimeout } from '../runtime/timeout';
import { applyVerifyResult, type VerifyOutcome } from './verify-result';

/**
 * publish.reconcile (and publish.verify) — settle an UNKNOWN publication by looking at the target's
 * timeline. Never posts. Repeats a bounded number of times, then hands over to a person.
 */
export async function handleReconcile(ctx: BrowserCtx, p: { publicationId: string }, finalDelivery = false): Promise<VerifyOutcome | 'STALE'> {
  const pub = await ctx.db.publication.findUnique({ where: { id: p.publicationId }, include: { target: { include: { profile: true } }, variant: true } });
  if (!pub || pub.status !== 'UNKNOWN') return 'STALE';
  const now0 = ctx.clock.now();
  const expected = { expectedJobVersion: pub.jobVersion, expectedReconcileTries: pub.reconcileTries };
  const reportUnstarted = async (reason: string): Promise<VerifyOutcome | 'STALE'> => {
    return tx(ctx.db, async (t) => {
      const now = ctx.clock.now();
      if (!await movePublication(t, { id: pub.id, from: 'UNKNOWN', to: 'NEEDS_OPERATOR', actor: ctx.actor, now, reason, ...expected })) return 'STALE';
      await openOperatorTask(t, { kind: 'CONFIRM_RESULT', reason, targetId: pub.targetId, publicationId: pub.id, now });
      return 'NEEDS_OPERATOR';
    });
  };
  if (pub.reconcileTries >= ctx.reconcileMaxTries) return reportUnstarted('RECONCILE_EXHAUSTED');

  const ttlMs = ctx.leaseTtlMs.RECONCILE;
  const lease = await acquireLease(ctx.db, {
    resource: accountResource(pub.targetId),
    holder: `${ctx.workerId}:reconcile:${pub.id}`,
    ttlMs,
    now: now0,
    purpose: 'reconcile',
  });
  if (!lease) {
    if (finalDelivery) return reportUnstarted('RECONCILE_ACCOUNT_BUSY');
    throw new RetryLaterError('account busy');
  }

  const heartbeat = async () => {
    if (!await heartbeatLease(ctx.db, lease, ttlMs, ctx.clock.now())) throw new FencedOutError(lease.resource, lease.token);
  };
  let attemptId: string | null = null;
  try {
    let connector;
    try {
      connector = ctx.registry.publisher(pub.target.connector);
    } catch {
      return await reportUnstarted('RECONCILE_CONNECTOR_UNAVAILABLE');
    }
    const started = await tx(ctx.db, async (t) => {
      const ok = await movePublication(t, {
        id: pub.id,
        from: 'UNKNOWN',
        to: 'RECONCILING',
        actor: ctx.actor,
        now: now0,
        fence: lease,
        data: { reconcileTries: { increment: 1 } },
        ...expected,
      });
      if (!ok) return null;
      const n = await t.publicationAttempt.count({ where: { publicationId: pub.id } });
      const a = await t.publicationAttempt.create({
        data: {
          publicationId: pub.id,
          attemptNo: n + 1,
          kind: 'reconcile',
          connector: connector.key,
          connectorVersion: connector.version,
          workerId: ctx.workerId,
          fencingToken: lease.token,
          startedAt: now0,
          stage: 'RECONCILE',
        },
      });
      return a.id;
    });
    if (!started) return 'STALE';
    attemptId = started;

    const needOperator = (reason: string): Promise<VerifyOutcome> => tx(ctx.db, async (t) => {
      const now = ctx.clock.now();
      if (!await movePublication(t, { id: pub.id, from: 'RECONCILING', to: 'NEEDS_OPERATOR', actor: ctx.actor, now, fence: lease, reason })) return 'FENCED';
      await t.publicationAttempt.update({ where: { id: started }, data: { outcome: 'NEEDS_OPERATOR', finishedAt: now, errorClass: reason } });
      await openOperatorTask(t, { kind: 'CONFIRM_RESULT', reason, targetId: pub.targetId, publicationId: pub.id, now });
      return 'NEEDS_OPERATOR';
    });
    if (pub.target.connector === EXTENSION_CONNECTOR) return await needOperator('EXTENSION_MANUAL_VERIFICATION');
    const snapshot = pub.variant.snapshot as unknown as PublishSnapshot | null;
    if (!snapshot || hashObject(snapshot) !== pub.snapshotHash) return await needOperator('SNAPSHOT_MISMATCH');
    const previous = pub.committedAt ? await ctx.db.publicationAttempt.findFirst({
      where: { publicationId: pub.id, kind: 'publish', committingAt: pub.committedAt },
      orderBy: { attemptNo: 'desc' }, select: { connector: true, evidence: true },
    }) : null;
    const receipt = previous?.evidence as { commitSignal?: CommitSignal; targetExternalId?: string } | null | undefined;
    if (previous && (previous.connector !== pub.target.connector || (receipt?.targetExternalId && receipt.targetExternalId !== pub.target.externalId))) {
      return await needOperator('TARGET_CONFIG_CHANGED');
    }
    const session = await withTimeout(
      connector.openSession({ id: pub.target.id, code: pub.target.code, externalId: pub.target.externalId, audience: pub.target.audience, uiLocale: pub.target.uiLocale, profileDir: pub.target.profile?.profileDir }),
      ctx.timeouts.stepMs,
      'openSession',
      late => late.close(),
    );
    try {
      await heartbeat();
      const state = await withTimeout(session.sessionState(), ctx.timeouts.stepMs, 'sessionState');
      if (state !== 'OK') return await needOperator(`SESSION_${state}`);
      await heartbeat();
      const identity = await withTimeout(session.checkIdentity(pub.target.externalId), ctx.timeouts.stepMs, 'checkIdentity');
      if (!identity.ok) return await needOperator('WRONG_IDENTITY');
      await heartbeat();
      const result = await withTimeout(
        session.verify({
          captionFingerprint: captionFingerprint(snapshot.caption),
          contentType: snapshot.contentType,
          commitSignal: receipt?.commitSignal,
          caption: snapshot.caption,
          mediaCount: snapshot.media.length,
          committedAt: pub.committedAt ?? pub.updatedAt,
          windowMs: ctx.verifyWindowMs,
        }),
        ctx.timeouts.commitMs,
        'verify',
      );
      return await applyVerifyResult(ctx, {
        publicationId: pub.id,
        from: 'RECONCILING',
        attemptId,
        result,
        committedAt: pub.committedAt ?? pub.updatedAt,
        fence: lease,
        reconcileTries: pub.reconcileTries + 1,
      });
    } finally {
      await withTimeout(session.close(), ctx.timeouts.stepMs, 'closeSession').catch(() => undefined);
    }
  } catch (err) {
    if (err instanceof FencedOutError) return 'FENCED';
    if (!attemptId) throw err;
    // Could not look: stay unresolved and try again later (bounded by reconcileMaxTries).
    const message = err instanceof Error ? err.message : String(err);
    const outcome = await tx(ctx.db, async (t) => {
      const now = ctx.clock.now();
      const giveUp = pub.reconcileTries + 1 >= ctx.reconcileMaxTries;
      const moved = await movePublication(t, { id: pub.id, from: 'RECONCILING', to: giveUp ? 'NEEDS_OPERATOR' : 'UNKNOWN', actor: ctx.actor, now, fence: lease, reason: 'RECONCILE_ERROR' });
      if (!moved) return 'FENCED';
      await t.publicationAttempt.update({ where: { id: attemptId! }, data: { outcome: giveUp ? 'NEEDS_OPERATOR' : 'UNKNOWN', finishedAt: now, errorMessage: message.slice(0, 500) } });
      if (giveUp) await openOperatorTask(t, { kind: 'CONFIRM_RESULT', reason: 'RECONCILE_ERROR', targetId: pub.targetId, publicationId: pub.id, now });
      else await enqueue(t, Q.PublishReconcile, { publicationId: pub.id }, { startAfter: new Date(now.getTime() + ctx.reconcileDelaySec * 1000) });
      return giveUp ? 'NEEDS_OPERATOR' : 'UNKNOWN';
    });
    ctx.log.warn({ publication_id: pub.id, err: message, outcome }, 'reconcile failed');
    return outcome;
  } finally {
    await releaseLease(ctx.db, lease, ctx.clock.now());
  }
}
