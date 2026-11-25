import { z } from 'zod';
import { RADAR_AXES, type RadarAxis, type RadarReport } from '@seedingsys/contracts';
import { facebookSourceUrl } from '@seedingsys/domain';
import { json, type Tx } from '@seedingsys/db';

const entry = z.object({
  score: z.number().min(0).max(100).nullable(),
  confidence: z.string().max(80).default(''),
  note: z.string().max(500).default(''),
  evidence: z.array(z.object({ text: z.string().max(500), why: z.string().max(500).default('') })).max(10).default([]),
});
const axisId = Object.values(RADAR_AXES).flat().map(([id]) => id);

const source = z.object({
  schema: z.literal('desk.customer-profile/2'),
  url: z.string().max(500),
  name: z.string().trim().max(120).default(''),
  analyzedAt: z.string().datetime({ offset: true }),
  postsRead: z.number().int().nonnegative().default(0),
  demographic: z.record(z.unknown()).default({}),
  personality: z.record(z.unknown()).default({}),
  manual: z.record(z.unknown()).default({}),
});

// The legacy export may carry extra groups. Only the original demographic and personality axes are retained.
export function radarUrl(raw: string) {
  const canonical = facebookSourceUrl(raw);
  if (!canonical) return null;
  const numeric = /^\/people\/[^/]+\/(\d+)$/.exec(canonical.pathname)?.[1];
  if (numeric) {
    canonical.pathname = '/profile.php';
    canonical.searchParams.set('id', numeric);
  } else {
    canonical.pathname = canonical.pathname.toLowerCase();
  }
  return canonical.href;
}

export const RadarImport = source.transform((source, ctx) => {
  const canonical = radarUrl(source.url);
  if (!canonical) {
    ctx.addIssue({ code: 'custom', path: ['url'], message: 'Cần liên kết trang cá nhân Facebook hợp lệ.' });
    return z.NEVER;
  }
  const manual = new Map<string, number>();
  for (const id of axisId) {
    if (!Object.hasOwn(source.manual, id)) continue;
    const parsed = z.object({ score: z.number().min(0).max(100) }).safeParse(source.manual[id]);
    if (!parsed.success) {
      ctx.addIssue({ code: 'custom', path: ['manual', id], message: 'Điểm chỉnh tay phải từ 0 đến 100.' });
    } else manual.set(id, parsed.data.score);
  }
  function axes(group: 'demographic' | 'personality'): RadarAxis[] {
    return RADAR_AXES[group].map(([id, label]) => {
      const raw = source[group][id];
      const parsed = raw === undefined ? null : entry.safeParse(raw);
      if (parsed && !parsed.success) {
        ctx.addIssue({ code: 'custom', path: [group, id], message: 'Điểm, độ tin cậy hoặc bằng chứng của trục không hợp lệ.' });
      }
      const data = parsed?.success ? parsed.data : undefined;
      return {
        id, label, score: manual.get(id) ?? data?.score ?? null, originalScore: data?.score ?? null, manual: manual.has(id),
        confidence: data?.confidence ?? '', note: data?.note ?? '',
        evidence: data?.evidence.map(({ text, why }) => ({
          text: text.replace(/https?:\/\/\S+/gi, '[liên kết]'),
          why: why.replace(/https?:\/\/\S+/gi, '[liên kết]'),
        })) ?? [],
      };
    });
  }
  const report: RadarReport = { demographic: axes('demographic'), personality: axes('personality'), postsRead: source.postsRead };
  return { url: canonical, name: source.name, analyzedAt: new Date(source.analyzedAt), report };
});

/** Serialize writes per URL and retain dashboard edits when refreshing the original scores. */
export async function lockRadar(t: Tx, url: string) {
  await t.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${url}, 0))::text`;
}

export async function saveRadar(t: Tx, incoming: z.infer<typeof RadarImport>, keepManual = false) {
  await lockRadar(t, incoming.url);
  const previous = await t.customerRadar.findUnique({ where: { url: incoming.url } });
  if (previous && previous.analyzedAt > incoming.analyzedAt) return { id: previous.id, saved: false };
  const report = incoming.report;
  if (keepManual && previous) {
    const old = previous.report as unknown as RadarReport;
    for (const group of ['demographic', 'personality'] as const) {
      for (const axis of report[group]) {
        const overridden = old[group].find(a => a.id === axis.id && a.manual);
        if (overridden) {
          axis.manual = true;
          axis.score = overridden.score;
        }
      }
    }
  }
  const data = { name: incoming.name || previous?.name || '', analyzedAt: incoming.analyzedAt, report: json(report) };
  const row = await t.customerRadar.upsert({ where: { url: incoming.url }, create: { url: incoming.url, ...data }, update: data });
  return { id: row.id, saved: true };
}
