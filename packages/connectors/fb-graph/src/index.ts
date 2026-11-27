import {
  ConnectorError,
  type ReadConnector,
  type ReadComment,
  type ReadCommentsResult,
  type ReadMedia,
  type ReadPost,
  type ReadResult,
  type SourceRef,
} from '@seedingsys/connectors-core';
import { canonicalSourceCode, legacySourceCode, type ContentType, type IncompleteFlag } from '@seedingsys/contracts';

/**
 * Read connector for Facebook content the organisation OWNS, through the official Graph API:
 *  - a Page you administer  → externalRef = Page ID,   token = Page access token
 *  - your own profile       → externalRef = "me",      token = user access token with `user_posts`
 *    (works for the app's own admins/developers/testers while the Meta app is in development mode)
 *
 * Tokens are per source, never stored in the database: FB_GRAPH_TOKEN_<CODE> (e.g. FB_GRAPH_TOKEN_N1)
 * or FB_GRAPH_TOKENS='{"N1":"..."}'. Only worker hosts that poll sources / fetch media need them.
 */
export interface FbGraphOptions {
  /** e.g. "v23.0". Empty = unversioned URL (the app's default API version). */
  version?: string;
  tokens: Record<string, string>;
  /** Number of most recent posts read each poll (re-reading them catches edits). */
  pageSize?: number;
  fetch?: typeof fetch;
}

export function fbGraphOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): FbGraphOptions {
  const tokens: Record<string, string> = {};
  if (env.FB_GRAPH_TOKENS) {
    try {
      Object.assign(tokens, JSON.parse(env.FB_GRAPH_TOKENS) as Record<string, string>);
    } catch {
      throw new Error('FB_GRAPH_TOKENS must be JSON, e.g. {"N1":"EAAB..."}');
    }
  }
  for (const [k, v] of Object.entries(env)) {
    const m = k.match(/^FB_GRAPH_TOKEN_([A-Za-z0-9]+)$/);
    if (m && v) tokens[m[1].toUpperCase()] = v;
  }
  return { version: env.FB_GRAPH_VERSION || undefined, tokens, pageSize: Number(env.FB_GRAPH_PAGE_SIZE ?? 25) };
}

interface GraphMedia {
  image?: { src?: string; width?: number; height?: number };
  source?: string;
}
interface GraphAttachment {
  type?: string;
  media_type?: string;
  url?: string;
  media?: GraphMedia;
  target?: { id?: string; url?: string };
  subattachments?: { data?: GraphAttachment[]; paging?: { next?: string } };
}
interface GraphPost {
  id: string;
  message?: string;
  created_time?: string;
  updated_time?: string;
  permalink_url?: string;
  status_type?: string;
  attachments?: { data?: GraphAttachment[] };
}

interface GraphPostsPage {
  data?: GraphPost[];
  paging?: { next?: string; cursors?: { after?: string } };
}

const POST_FIELDS = [
  'id',
  'message',
  'created_time',
  'updated_time',
  'permalink_url',
  'status_type',
  'attachments{type,media_type,url,media,target,subattachments.limit(100){type,media_type,url,media,target}}',
].join(',');

const isVideo = (a: GraphAttachment) => /video/i.test(`${a.media_type ?? ''} ${a.type ?? ''}`);
const isPhoto = (a: GraphAttachment) => /photo/i.test(`${a.media_type ?? ''} ${a.type ?? ''}`) || (!!a.media?.image?.src && !isVideo(a));

export class FbGraphReadConnector implements ReadConnector {
  readonly key = 'fb-graph';
  readonly version = 'fb-graph-1';
  private readonly http: typeof fetch;

  constructor(private readonly opts: FbGraphOptions) {
    this.http = opts.fetch ?? fetch;
  }

  private base() {
    return `https://graph.facebook.com/${this.opts.version ? `${this.opts.version}/` : ''}`;
  }

  private token(sourceCode: string): string {
    const code = canonicalSourceCode(sourceCode.toUpperCase());
    const t = this.opts.tokens[code] ?? this.opts.tokens[legacySourceCode(code)];
    if (!t) throw new ConnectorError('SOURCE_UNREADABLE', `Chưa có token Graph API cho nguồn ${code} (đặt FB_GRAPH_TOKEN_${code})`);
    return t;
  }

  /** GET with the token in the Authorization header (never in logs or URLs we store). */
  private async get<T>(path: string, params: Record<string, string>, token: string, signal?: AbortSignal): Promise<T> {
    const url = new URL(path.startsWith('http') ? path : `${this.base()}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await this.http(url, { headers: { Authorization: `Bearer ${token}` }, signal, redirect: 'error' });
    } catch (e) {
      throw new ConnectorError('TRANSIENT', `Graph API không phản hồi: ${(e as Error).message}`);
    }
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number; error_subcode?: number } } & T;
    if (res.ok && !body.error) return body;
    const code = body.error?.code;
    const msg = body.error?.message ?? `HTTP ${res.status}`;
    if (code === 190) throw new ConnectorError('SOURCE_UNREADABLE', `Token Graph API hết hạn hoặc không hợp lệ: ${msg}`);
    if (code === 10 || code === 200 || (code !== undefined && code >= 200 && code < 300)) throw new ConnectorError('SOURCE_UNREADABLE', `Token thiếu quyền đọc bài: ${msg}`);
    if (code === 4 || code === 17 || code === 32 || code === 613 || res.status === 429) throw new ConnectorError('RATE_LIMITED', `Graph API giới hạn tần suất: ${msg}`);
    if (code === 100 || res.status === 404) {
      throw new ConnectorError('SOURCE_UNREADABLE', `Không đọc được nguồn (sai ID trang?): ${msg}`, false, { graphCode: code });
    }
    throw new ConnectorError(res.status >= 500 ? 'TRANSIENT' : 'PERMANENT', `Graph API lỗi: ${msg}`);
  }

  async readSince(source: SourceRef, watermark: Record<string, unknown> | null, overlap: number): Promise<ReadResult> {
    const token = this.token(source.code);
    const limit = source.history ? '50' : String(Math.min(100, Math.max(Math.floor(this.opts.pageSize || 25), overlap, 5)));
    const path = `${encodeURIComponent(source.externalRef)}/posts`;
    const signal = AbortSignal.timeout(45_000);
    const load = async (cursor?: string) => {
      const page = await this.get<GraphPostsPage>(path, { fields: POST_FIELDS, limit, ...(cursor && { after: cursor }) }, token, signal);
      if (!Array.isArray(page.data) || page.data.some(p => typeof p?.id !== 'string' || !p.id)) {
        throw new ConnectorError('TRANSIENT', 'Graph API trả dữ liệu bài viết không hợp lệ.');
      }
      return { posts: page.data.map(post => this.toPost(post, source.code)),
        more: !!page.paging?.next, next: page.paging?.next ? page.paging.cursors?.after : undefined };
    };
    if (source.history) {
      const page = await load(source.history.cursor);
      const nextCursor = page.next && page.next !== source.history.cursor ? page.next : undefined;
      return { posts: page.posts, nextWatermark: {}, incomplete: [],
        history: { complete: !page.more, nextCursor,
          detail: page.more && !nextCursor ? 'Graph API chưa trả con trỏ hợp lệ cho trang lịch sử tiếp theo.' : undefined } };
    }

    const previous = typeof watermark?.newest === 'number' ? watermark.newest : 0;
    let newest = typeof watermark?.pendingNewest === 'number' ? Math.max(previous, watermark.pendingNewest) : previous;
    let cursor = typeof watermark?.nextCursor === 'string' ? watermark.nextCursor : undefined;
    const seen = new Set<string>();
    const posts = new Map<string, ReadPost>();
    let overlapRead = typeof watermark?.pendingOverlapRead === 'number' ? watermark.pendingOverlapRead : 0;
    // Retain the previous watermark until a burst of posts is fully read across poll batches.
    for (let i = 0; i < 5; i++) {
      if (cursor) seen.add(cursor);
      const page = await load(cursor).catch(error => {
        if (i || !cursor || !(error instanceof ConnectorError) || error.evidence?.graphCode !== 100) throw error;
        // Graph can invalidate a cursor between polls. Restart from the previous settled watermark.
        cursor = undefined;
        newest = previous;
        overlapRead = 0;
        seen.clear();
        return load();
      });
      for (const post of page.posts) {
        const stamp = post.postedAt?.getTime();
        if (stamp) {
          newest = Math.max(newest, stamp);
          if (stamp <= previous && !posts.has(post.externalId)) overlapRead++;
        }
        posts.set(post.externalId, post);
      }
      if (!page.more || !watermark || overlapRead >= Math.max(overlap, 1)) {
        return { posts: [...posts.values()], nextWatermark: { newest }, incomplete: [] };
      }
      if (!page.next || seen.has(page.next)) {
        return { posts: [...posts.values()], nextWatermark: { newest: previous }, incomplete: ['PAGINATION_INCOMPLETE'] };
      }
      cursor = page.next;
    }
    return { posts: [...posts.values()],
      nextWatermark: { newest: previous, pendingNewest: newest, pendingOverlapRead: overlapRead, nextCursor: cursor },
      incomplete: ['PAGINATION_INCOMPLETE'] };
  }

  async readComments(source: SourceRef, post: { externalId: string },
    onProgress: (readCount: number, expectedCount?: number) => Promise<void>): Promise<ReadCommentsResult> {
    type GraphComment = { id: string; message?: string; from?: { name?: string }; permalink_url?: string; created_time?: string; comment_count?: number };
    type Edge = { data?: GraphComment[]; paging?: { next?: string; cursors?: { after?: string } } };
    const token = this.token(source.code);
    const signal = AbortSignal.timeout(70_000);
    const comments = new Map<string, ReadComment>();
    const edges = [{ node: post.externalId, parent: undefined as string | undefined }];
    let detail: string | undefined;
    try {
      for (const { node, parent } of edges) {
        const cursors = new Set<string>();
        let after: string | undefined;
        do {
          const page: Edge = await this.get(`${encodeURIComponent(node)}/comments`, {
            fields: 'id,message,from,permalink_url,created_time,comment_count', order: 'chronological', filter: 'toplevel', limit: '100',
            ...(after && { after }),
          }, token, signal);
          if (!Array.isArray(page.data) || page.data.some(raw => typeof raw?.id !== 'string' || !raw.id)) {
            throw new ConnectorError('TRANSIENT', 'Graph API trả dữ liệu bình luận không hợp lệ.');
          }
          for (const raw of page.data) {
            if (comments.has(raw.id)) continue;
            const postedAt = raw.created_time ? new Date(raw.created_time) : undefined;
            comments.set(raw.id, { externalId: raw.id, parentExternalId: parent, text: raw.message ?? '',
              authorName: raw.from?.name, permalink: raw.permalink_url, postedAt: postedAt && Number.isFinite(+postedAt) ? postedAt : undefined });
            if (typeof raw.comment_count === 'number' && raw.comment_count > 0) edges.push({ node: raw.id, parent: raw.id });
          }
          await onProgress(comments.size);
          if (comments.size >= 10_000) throw new Error('Đã đạt giới hạn lưu của một lượt quét.');
          after = page.paging?.next ? page.paging.cursors?.after : undefined;
          if (page.paging?.next && (!after || cursors.has(after))) throw new Error('Graph API chưa trả con trỏ để đọc phần bình luận còn lại.');
          if (after) cursors.add(after);
        } while (after);
      }
    } catch (err) {
      if (!comments.size) throw err;
      detail = signal.aborted ? 'Đã lưu phần đọc được trước khi lượt quét hết thời gian.' : 'Graph API chưa trả hết các trang bình luận.';
    }
    return { comments: [...comments.values()], complete: !detail, detail };
  }

  private toPost(p: GraphPost, sourceCode: string): ReadPost {
    const att = p.attachments?.data?.[0];
    const incomplete: IncompleteFlag[] = [];
    const media: ReadMedia[] = [];
    let contentType: ContentType = 'TEXT';
    const isShared = p.status_type === 'shared_story' || att?.type === 'share';

    if (att) {
      const subs = att.subattachments?.data ?? [];
      if (subs.length) {
        if (att.subattachments?.paging?.next) incomplete.push('MEDIA_COUNT_UNKNOWN');
        const photos = subs.filter(isPhoto);
        const videos = subs.filter(isVideo);
        if ((videos.length && photos.length) || videos.length > 1 || videos.length + photos.length !== subs.length) {
          contentType = 'UNSUPPORTED'; // mixed photo + video post: no publish flow for it
        } else if (videos.length === 1 && !photos.length) {
          contentType = 'VIDEO';
          media.push(this.videoRef(videos[0], sourceCode));
        } else if (photos.length) {
          contentType = photos.length === 1 ? 'SINGLE_PHOTO' : 'MULTI_PHOTO';
          for (const ph of photos) media.push(this.photoRef(ph));
        }
      } else if (isVideo(att)) {
        contentType = 'VIDEO';
        media.push(this.videoRef(att, sourceCode));
      } else if (isPhoto(att) && att.type !== 'share') {
        contentType = 'SINGLE_PHOTO';
        media.push(this.photoRef(att));
      } else if (att.type === 'share' || att.url) {
        contentType = 'TEXT'; // link share: the text is posted, the link preview is not reproduced
      } else {
        contentType = 'UNSUPPORTED';
        incomplete.push('TYPE_UNCERTAIN');
      }
    }
    if (media.some((m) => !m.sourceUrl && !m.ref.startsWith('fbgraph-video:'))) incomplete.push('MEDIA_UNAVAILABLE');

    const postedAt = p.created_time ? new Date(p.created_time) : undefined;
    return {
      externalId: p.id,
      identityConfidence: 'HIGH',
      permalink: p.permalink_url,
      postedAt: postedAt && Number.isFinite(postedAt.getTime()) ? postedAt : undefined,
      text: p.message ?? '',
      contentType,
      isPinned: false,
      isShared,
      media,
      incomplete: [...new Set(incomplete)],
      raw: { status_type: p.status_type, attachment_type: att?.type, updated_time: p.updated_time },
    };
  }

  private photoRef(a: GraphAttachment): ReadMedia {
    const src = a.media?.image?.src;
    return { kind: 'image', ref: `fbgraph-photo:${a.target?.id ?? src ?? 'unknown'}`, sourceUrl: src };
  }

  private videoRef(a: GraphAttachment, sourceCode: string): ReadMedia {
    // The playable file URL is looked up at fetch time with the source's token (CDN URLs expire).
    const id = a.target?.id;
    // Preserve the asset reference for videos already imported before source codes were renamed.
    const mediaKey = legacySourceCode(sourceCode.toUpperCase());
    return { kind: 'video', ref: id ? `fbgraph-video:${mediaKey}:${id}` : `fbgraph-video-url`, sourceUrl: a.media?.source };
  }

  async fetchMedia(media: { ref: string; sourceUrl?: string | null }): Promise<{ bytes: Buffer; mime: string }> {
    let url = media.sourceUrl ?? undefined;
    const vm = media.ref.match(/^fbgraph-video:([A-Za-z0-9]+):(\d+)$/);
    if (vm) {
      const v = await this.get<{ source?: string }>(vm[2], { fields: 'source' }, this.token(vm[1]));
      url = v.source ?? url;
    }
    if (!url) throw new ConnectorError('PERMANENT', `Không có đường dẫn tải cho ${media.ref}`);
    let res: Response;
    try {
      res = await this.http(url);
    } catch (e) {
      throw new ConnectorError('TRANSIENT', `Tải media lỗi: ${(e as Error).message}`);
    }
    if (!res.ok) throw new ConnectorError(res.status >= 500 ? 'TRANSIENT' : 'PERMANENT', `Tải media lỗi HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim() || (vm ? 'video/mp4' : 'image/jpeg');
    return { bytes, mime };
  }
}
