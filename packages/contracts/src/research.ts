import { z } from 'zod';

export const RESEARCH_KINDS = ['RESEARCH_PROFILE', 'RESEARCH_POST'] as const;
export const RESEARCH_LIMIT = 20;
const link = z.string().url().max(500);
const report = { url: link, partial: z.boolean() };
export const ResearchReportSchema = z.discriminatedUnion('kind', [
  z.object({ ...report, kind: z.literal('RESEARCH_PROFILE'), rows: z.array(z.object({
    url: link, title: z.string().max(280), body: z.string().max(700), captionPartial: z.boolean(),
  })).max(RESEARCH_LIMIT) }),
  z.object({ ...report, kind: z.literal('RESEARCH_POST'),
    body: z.string().max(16_000), captionPartial: z.boolean(),
    author: z.string().max(320), authorUrl: link.nullable(), location: z.string().max(320),
    mediaLinks: z.array(z.string().url().max(2048)).max(8), hasMedia: z.boolean(), mediaPartial: z.boolean(),
    sourceKind: z.enum(['post', 'video', 'reel']),
    comments: z.array(z.object({
      externalId: z.string().regex(/^[\w=+/-]{1,150}$/).nullable(),
      parentExternalId: z.string().regex(/^[\w=+/-]{1,150}$/).nullable().optional(), name: z.string().max(320),
      text: z.string().trim().min(1).max(8_000), depth: z.number().int().min(0).max(24),
    })).max(40),
  }),
]);
export type ResearchReport = z.infer<typeof ResearchReportSchema>;
export type ResearchKind = typeof RESEARCH_KINDS[number];

export interface ResearchWorkspace {
  jobs: Array<{ id: string; createdAt: string; targetCode: string; url: string; kind: ResearchKind;
    state: string; result: ResearchReport | null; ownerCode: string | null }>;
  sources: Array<{ id: string; code: string; name: string }>;
}
