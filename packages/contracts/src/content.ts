export const CONTENT_TYPES = [
  'TEXT',
  'QUOTE_IMAGE',
  'SINGLE_PHOTO',
  'MULTI_PHOTO',
  'MEDIA_ALBUM',
  'NAMED_ALBUM',
  'VIDEO',
  'REEL',
  'UNSUPPORTED',
] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];
export const FB_WEB_PUBLISH_FORMATS: readonly ContentType[] = ['TEXT', 'QUOTE_IMAGE', 'SINGLE_PHOTO', 'MULTI_PHOTO', 'VIDEO', 'REEL'];
export const COMMENT_READERS: readonly string[] = ['fb-public', 'fb-session', 'fb-graph'];
export const COMMENT_STALL_MS = 5 * 60_000;
/** How long a queued comment may wait (behind its parent and other comments) before the send has to be repeated. */
export const COMMENT_QUEUE_MS = 20 * 60_000;
/** Retries, 30 s apart, while a queued comment waits for its parent or a busy profile: under COMMENT_QUEUE_MS. */
export const COMMENT_PUBLISH_RETRIES = 30;
export const FB_CAPABILITY_MIN_CASES = 20;

export type WorkflowKind = 'STANDARD' | 'ALBUM' | 'VIDEO';

export function workflowFor(t: ContentType): WorkflowKind | null {
  switch (t) {
    case 'TEXT':
    case 'QUOTE_IMAGE':
    case 'SINGLE_PHOTO':
      return 'STANDARD';
    case 'MULTI_PHOTO':
    case 'MEDIA_ALBUM':
    case 'NAMED_ALBUM':
      return 'ALBUM';
    case 'VIDEO':
    case 'REEL':
      return 'VIDEO';
    default:
      return null;
  }
}

/** Completeness flags reported by read connectors. Any of these blocks auto-READY. */
export const INCOMPLETE_FLAGS = [
  'CAPTION_TRUNCATED',
  'MEDIA_COUNT_UNKNOWN',
  'MEDIA_UNAVAILABLE',
  'TYPE_UNCERTAIN',
  'SOURCE_UNREADABLE',
  'PAGINATION_INCOMPLETE',
] as const;
export type IncompleteFlag = (typeof INCOMPLETE_FLAGS)[number];

/** Frozen publication snapshot. Its hash is checked again right before publishing. */
export interface PublishSnapshot {
  variantId: string;
  targetId: string;
  contentType: ContentType;
  caption: string;
  albumTitle?: string | null;
  audience: string;
  media: Array<{ position: number; assetId: string; checksum: string; objectKey: string; mime: string; kind: string }>;
}

export const REVIEW_REASONS = {
  MANUAL_MODE: 'MANUAL_REVIEW_MODE',
  INCOMPLETE: 'SOURCE_INCOMPLETE',
  MEDIA_FAILED: 'MEDIA_FETCH_FAILED',
  UNSUPPORTED: 'UNSUPPORTED_FORMAT',
  NAMED_ALBUM: 'NAMED_ALBUM_NOT_CERTIFIED',
  FACT_MISSING: 'FACT_MISSING',
  NEGATION_LOST: 'NEGATION_LOST',
  TOO_SIMILAR: 'NEAR_VERBATIM_COPY',
  EMPTY: 'EMPTY_CAPTION',
  TOO_LONG: 'CAPTION_TOO_LONG',
  LLM_FLAGGED: 'LLM_FLAGGED',
  LLM_FAILED: 'LLM_FAILED',
  BUDGET: 'LLM_BUDGET_EXHAUSTED',
  DUPLICATE: 'DUPLICATE_CONTENT',
} as const;
