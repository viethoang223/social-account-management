import { z } from 'zod';

/**
 * Queue contracts. A job only carries reference IDs — never API keys, cookies or content.
 * Handlers must be idempotent: the queue delivers at least once.
 */
export const Q = {
  SourcePoll: 'source.poll',
  ProfileSync: 'profile.sync',
  CommentScan: 'comment.scan',
  CommentPublish: 'comment.publish',
  AssetFetch: 'asset.fetch',
  InstagramBatchImport: 'research.instagram-import',
  InstagramBatchPublish: 'research.instagram-publish',
  ContentRewrite: 'content.rewrite',
  ContentValidate: 'content.validate',
  MediaPrepare: 'media.prepare',
  PublishStandard: 'publish.standard',
  PublishAlbum: 'publish.album',
  PublishVideo: 'publish.video',
  PublishVerify: 'publish.verify',
  PublishReconcile: 'publish.reconcile',
  AgentRecover: 'agent.recover',
  SchedulerTick: 'scheduler.tick',
} as const;
export type QueueName = (typeof Q)[keyof typeof Q];

const id = z.string().uuid();

export const JobSchemas = {
  [Q.SourcePoll]: z.object({ sourceId: id, collectComments: z.boolean().optional() }),
  [Q.ProfileSync]: z.object({ syncId: id, step: z.number().int().min(0) }),
  [Q.CommentScan]: z.object({ scanId: id, readTargetId: id.optional(), manual: z.boolean().optional() }),
  [Q.CommentPublish]: z.object({ replayId: id, sendVersion: z.number().int().min(1) }),
  [Q.AssetFetch]: z.object({ assetId: id }),
  [Q.InstagramBatchImport]: z.object({ batchId: id, researchId: id }),
  [Q.InstagramBatchPublish]: z.object({ batchId: id, index: z.number().int().min(0).max(39) }),
  [Q.ContentRewrite]: z.object({ variantId: id, useAi: z.boolean().optional() }),
  [Q.ContentValidate]: z.object({ variantId: id }),
  [Q.MediaPrepare]: z.object({ assetId: id, preset: z.string() }),
  [Q.PublishStandard]: z.object({ publicationId: id, jobVersion: z.number().int() }),
  [Q.PublishAlbum]: z.object({ publicationId: id, jobVersion: z.number().int() }),
  [Q.PublishVideo]: z.object({ publicationId: id, jobVersion: z.number().int() }),
  [Q.PublishVerify]: z.object({ publicationId: id }),
  [Q.PublishReconcile]: z.object({ publicationId: id }),
  [Q.AgentRecover]: z.object({ publicationId: id, attemptId: id, reason: z.string() }),
  [Q.SchedulerTick]: z.object({}).passthrough(),
} satisfies Record<QueueName, z.ZodTypeAny>;

export type JobPayload<Q extends QueueName> = z.infer<(typeof JobSchemas)[Q]>;

export function parseJob<N extends QueueName>(queue: N, data: unknown): JobPayload<N> {
  return JobSchemas[queue].parse(data) as JobPayload<N>;
}

export const PUBLISH_QUEUE_BY_WORKFLOW = {
  STANDARD: Q.PublishStandard,
  ALBUM: Q.PublishAlbum,
  VIDEO: Q.PublishVideo,
} as const;
