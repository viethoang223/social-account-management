import type { ContentType, IncompleteFlag, PublishSnapshot } from '@seedingsys/contracts';

// ─────────────────────────── Errors ───────────────────────────

export type ConnectorErrorKind =
  | 'TRANSIENT' // network/timeouts before any side effect — retry is safe
  | 'RATE_LIMITED'
  | 'SESSION_LOGGED_OUT'
  | 'CHECKPOINT' // identity verification / security check — human only
  | 'WRONG_IDENTITY'
  | 'UI_UNEXPECTED' // selector missing / unknown dialog — candidate for agent.recover
  | 'PREVIEW_MISMATCH'
  | 'AUDIENCE_MISMATCH'
  | 'UNSUPPORTED'
  | 'SOURCE_UNREADABLE'
  | 'PERMANENT';

export class ConnectorError extends Error {
  constructor(
    readonly kind: ConnectorErrorKind,
    message: string,
    /** True if the failing step may already have produced a visible effect on the platform. */
    readonly sideEffectPossible = false,
    readonly evidence?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ConnectorError';
  }
}

export function isConnectorError(e: unknown): e is ConnectorError {
  return e instanceof ConnectorError || (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'ConnectorError');
}

// ─────────────────────────── Read side ───────────────────────────

export interface SourceRef {
  id: string;
  code: string;
  externalRef: string;
  retryPermalinks?: string[];
  exactPermalinks?: string[];
  history?: { cursor?: string };
  readAccount?: Pick<TargetRef, 'code' | 'externalId' | 'profileDir'>;
}

export interface ReadMedia {
  kind: 'image' | 'video';
  /** Stable reference for fetching the bytes later (connector-specific). */
  ref: string;
  sourceUrl?: string;
  expectedChecksum?: string;
  mime?: string;
  renderedImage?: Uint8Array;
}

export interface ReadPost {
  externalId: string;
  identityConfidence: 'HIGH' | 'LOW';
  permalink?: string;
  postedAt?: Date;
  text: string;
  albumTitle?: string;
  contentType: ContentType;
  isPinned: boolean;
  isShared: boolean;
  media: ReadMedia[];
  incomplete: IncompleteFlag[];
  raw?: Record<string, unknown>;
}

export interface ReadResult {
  posts: ReadPost[];
  /** Cursor to store once (and only once) the posts are persisted. */
  nextWatermark: Record<string, unknown>;
  /** Read-level completeness problems (e.g. pagination stopped early). */
  incomplete: IncompleteFlag[];
  history?: { complete: boolean; nextCursor?: string; detail?: string };
}

export interface ReadComment {
  externalId: string;
  parentExternalId?: string;
  text: string;
  authorName?: string;
  permalink?: string;
  postedAt?: Date;
}

export interface ReadCommentsResult {
  comments: ReadComment[];
  complete: boolean;
  expectedCount?: number;
  detail?: string;
}

export interface ReadConnector {
  readonly key: string;
  readonly version: string;
  /** Read new posts plus a bounded overlap before the watermark. Throws ConnectorError when the source cannot be read. */
  readSince(source: SourceRef, watermark: Record<string, unknown> | null, overlap: number): Promise<ReadResult>;
  readComments?(source: SourceRef, post: { externalId: string; permalink?: string; aliases?: string[] },
    onProgress: (readCount: number, expectedCount?: number) => Promise<void>): Promise<ReadCommentsResult>;
  /** Fetch media bytes the organisation is permitted to store. */
  fetchMedia(media: { ref: string; sourceUrl?: string | null }): Promise<{ bytes: Buffer; mime: string }>;
}

// ─────────────────────────── Publish side ───────────────────────────

export interface TargetRef {
  id: string;
  code: string;
  externalId: string;
  audience: string;
  uiLocale: string;
  profileDir?: string;
  /** Publication and account lease for connectors that dispatch across process boundaries. */
  operation?: { publicationId: string; fencingToken: bigint; comment?: { replayId: string; sendVersion: number } };
}

export type CapabilitySet = Partial<Record<ContentType, boolean>>;

export interface MediaFile {
  position: number;
  checksum: string;
  mime: string;
  kind: string;
  /** Local path or URL the browser can upload from. */
  location: string;
}

export interface DraftHandle {
  id: string;
  [k: string]: unknown;
}

export interface PreviewExpectation {
  caption: string;
  mediaCount: number;
  mediaChecksums: string[];
  audience: string;
  albumTitle?: string | null;
}

export interface CommitSignal {
  /** Permalink or post id if the UI surfaced one right after posting. */
  permalink?: string;
  externalPostId?: string;
  raw?: Record<string, unknown>;
}

export interface VerifyHint {
  captionFingerprint: string;
  contentType?: ContentType;
  /** Full frozen caption — connectors that read real pages match on its text. */
  caption?: string;
  mediaCount: number;
  committedAt: Date;
  windowMs: number;
  commitSignal?: CommitSignal | null;
}

export type VerifyResult =
  | { kind: 'VERIFIED'; permalink: string; externalPostId?: string; evidence?: Record<string, unknown> }
  | { kind: 'NOT_FOUND'; conclusive: boolean; evidence?: Record<string, unknown> }
  | { kind: 'AMBIGUOUS'; matches: number; evidence?: Record<string, unknown> }
  | { kind: 'PROCESSING'; evidence?: Record<string, unknown> };

export interface PublishSession {
  sessionState(): Promise<'OK' | 'LOGGED_OUT' | 'CHECKPOINT'>;
  checkIdentity(expectedExternalId: string): Promise<{ ok: boolean; observed?: string }>;
  postComment?(input: { post: URL; parentId?: string; text: string }, beforeSubmit: () => Promise<void>): Promise<{ externalId: string; permalink: string } | null>;
  /** Build the draft. MUST NOT publish anything. */
  prepare(snapshot: PublishSnapshot, media: MediaFile[]): Promise<DraftHandle>;
  previewCheck(draft: DraftHandle, expected: PreviewExpectation): Promise<{ ok: boolean; problems: string[]; audienceOk: boolean }>;
  /** Press "Post". Only called after the DB says COMMITTING. */
  commit(draft: DraftHandle): Promise<CommitSignal>;
  /** Video: wait for platform processing. Resolves when done or when it is safe to move on to verify. */
  waitProcessing?(signal: CommitSignal, heartbeat: () => Promise<void>): Promise<void>;
  verify(hint: VerifyHint): Promise<VerifyResult>;
  discardDraft(draft: DraftHandle): Promise<void>;
  close(): Promise<void>;
}

export interface PublishConnector {
  readonly key: string;
  readonly version: string;
  capabilities(target: TargetRef): CapabilitySet;
  openSession(target: TargetRef): Promise<PublishSession>;
}

// ─────────────────────────── Registry ───────────────────────────

export class ConnectorRegistry {
  private readers = new Map<string, ReadConnector>();
  private publishers = new Map<string, PublishConnector>();

  addReader(c: ReadConnector) {
    this.readers.set(c.key, c);
    return this;
  }
  addPublisher(c: PublishConnector) {
    this.publishers.set(c.key, c);
    return this;
  }
  reader(key: string): ReadConnector {
    const c = this.readers.get(key);
    if (!c) throw new ConnectorError('PERMANENT', `No read connector "${key}" on this worker`);
    return c;
  }
  publisher(key: string): PublishConnector {
    const c = this.publishers.get(key);
    if (!c) throw new ConnectorError('PERMANENT', `No publish connector "${key}" on this worker`);
    return c;
  }
}
