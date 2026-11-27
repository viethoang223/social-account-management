import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EXTENSION_CONNECTOR, EXTENSION_FRESH_MS, Q } from '@seedingsys/contracts';
import type { Db } from '@seedingsys/db';
import type { BrowserCtx } from './ctx';

const lookAheadMs = 90_000;
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

function readProfiles(file: string) {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { profiles?: unknown } | null;
  if (!parsed?.profiles || typeof parsed.profiles !== 'object' || Array.isArray(parsed.profiles)) return null;
  const entries = Object.entries(parsed.profiles);
  if (!entries.every(([code, directory]) => /^B\d+$/.test(code) && typeof directory === 'string'
    && /^(?:Default|Profile [1-9]\d*)$/.test(directory))) return null;
  return Object.fromEntries(entries) as Record<string, string>;
}

async function dueTargets(db: Db, ids: string[], now: Date) {
  const soon = new Date(+now + lookAheadMs);
  const [publications, comments, jobs] = await Promise.all([
    db.publication.findMany({ where: { targetId: { in: ids }, status: 'QUEUED' }, select: { targetId: true }, distinct: ['targetId'] }),
    db.publicationComment.findMany({ where: { authorTargetId: { in: ids }, status: 'QUEUED' }, select: { authorTargetId: true }, distinct: ['authorTargetId'] }),
    db.outboxEvent.findMany({ where: { queue: Q.InstagramBatchPublish, startAfter: { gte: new Date(+now - lookAheadMs), lte: soon } },
      orderBy: { id: 'desc' }, take: 100, select: { payload: true } }),
  ]);
  const waiting = new Set([...publications.map(row => row.targetId), ...comments.flatMap(row => row.authorTargetId ? [row.authorTargetId] : [])]);
  const events = jobs.flatMap(job => {
    const row = job.payload as { batchId?: string; index?: number } | null;
    return row && typeof row.batchId === 'string' && uuid.test(row.batchId) && Number.isSafeInteger(row.index) ? [row as { batchId: string; index: number }] : [];
  });
  const plans = events.length ? await db.extensionRadarScan.findMany({ where: { id: { in: events.map(event => event.batchId) } }, select: { id: true, result: true } }) : [];
  for (const plan of plans) {
    const raw = plan.result as { batchPublication?: { state?: string; targetId?: string; next?: number } } | null;
    const current = raw?.batchPublication;
    if (current?.state === 'RUNNING' && current.targetId && ids.includes(current.targetId)
      && events.some(event => event.batchId === plan.id && event.index === current.next)) {
      waiting.add(current.targetId);
    }
  }
  return waiting;
}

export function startChromeLauncher(ctx: Pick<BrowserCtx, 'db' | 'clock' | 'log'>) {
  if (process.platform !== 'win32') return () => undefined;
  const file = resolve(process.env.SEEDINGSYS_CHROME_PROFILES ?? '.data/chrome-profiles.json');
  if (!existsSync(file)) return () => undefined;
  let profiles;
  try { profiles = readProfiles(file); } catch { /* Invalid file must not stop the browser worker. */ }
  if (!profiles) {
    ctx.log.warn('chrome profile mappings are invalid');
    return () => undefined;
  }
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA];
  const chrome = roots.filter((root): root is string => !!root).map(root => join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')).find(existsSync);
  const userData = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data');
  if (!chrome || !userData) return () => undefined;

  let running = false;
  const lastLaunch = new Map<string, number>();
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const now = ctx.clock.now();
      const accounts = await ctx.db.targetAccount.findMany({ where: { code: { in: Object.keys(profiles) }, connector: EXTENSION_CONNECTOR,
        enabled: true, extension: { is: { installationId: { not: null } } } },
        select: { id: true, code: true, externalId: true, extension: { select: { uid: true } },
          profile: { select: { workerNode: { select: { lastHeartbeatAt: true } } } } } });
      const offline = accounts.filter(account => account.extension?.uid === account.externalId
        && +now - +(account.profile?.workerNode?.lastHeartbeatAt ?? 0) > EXTENSION_FRESH_MS
        && +now - (lastLaunch.get(account.id) ?? 0) > 120_000 && existsSync(join(userData, profiles[account.code], 'Preferences')));
      if (!offline.length) return;
      const waiting = await dueTargets(ctx.db, offline.map(account => account.id), now);
      const controls = await ctx.db.control.findMany({ where: { scope: 'TARGET', scopeKey: { in: [...waiting] }, paused: true }, select: { scopeKey: true } });
      for (const account of offline) {
        if (!waiting.has(account.id) || controls.some(control => control.scopeKey === account.id)) continue;
        lastLaunch.set(account.id, +now);
        const child = spawn(chrome, ['--profile-directory=' + profiles[account.code], '--new-window', 'https://www.facebook.com/'],
          { detached: true, windowsHide: true, stdio: 'ignore' });
        child.once('error', err => ctx.log.warn({ err, code: account.code }, 'Chrome profile launch failed'));
        child.unref();
        ctx.log.info({ code: account.code }, 'Chrome profile requested for queued work');
      }
    } catch (err) {
      ctx.log.warn({ err }, 'Chrome profile wake check failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, 12_000);
  void tick();
  return () => clearInterval(timer);
}
