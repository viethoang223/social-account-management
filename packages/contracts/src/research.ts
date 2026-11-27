import { z } from 'zod';

export const RESEARCH_KINDS = ['RESEARCH_PROFILE', 'RESEARCH_POST'] as const;
export const RESEARCH_LIMIT = 20;
export const INSTAGRAM_PROFILE_RESEARCH_LIMIT = 40;
export const INSTAGRAM_POST_MEDIA_LIMIT = 20;
export const INSTAGRAM_ORIGIN = 'https://www.instagram.com';
export const INSTAGRAM_PROFILE_PROTOCOL = 5;
export const InstagramResearchProtocolSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(INSTAGRAM_PROFILE_PROTOCOL)]);
export const InstagramBatchPlanSchema = z.object({ batchDestinationUid: z.string().optional(),
  batchImport: z.object({ sourceId: z.string().uuid(), actor: z.string() }).optional() });
export type InstagramResearchProtocol = z.infer<typeof InstagramResearchProtocolSchema>;

export function instagramSourceLink(raw: string) {
  try {
    const input = new URL(raw);
    if (input.protocol !== 'https:' || input.username || input.password || input.port
      || !['instagram.com', 'www.instagram.com'].includes(input.hostname)) return null;
    const path = input.pathname.replace(/\/+$/, '');
    const post = /^\/(?:[a-zA-Z0-9_.]{1,30}\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]{1,32})$/.exec(path);
    if (post) {
      const [, surface, id] = post;
      const kind = surface === 'reel' || surface === 'reels' ? 'reel' : surface === 'tv' ? 'video' : 'post';
      return { type: 'post' as const, id, kind,
        url: INSTAGRAM_ORIGIN + '/' + (surface === 'reels' ? 'reel' : surface) + '/' + id + '/' };
    }
    const user = /^\/([A-Za-z0-9_.]{1,30})$/.exec(path)?.[1]?.toLowerCase();
    if (!user || !/[a-z0-9]/.test(user)
      || /^(accounts|api|about|challenge|developer|direct|explore|legal|oauth|p|reel|reels|stories|tv)$/.test(user)) return null;
    return { type: 'profile' as const, id: user, url: INSTAGRAM_ORIGIN + '/' + user + '/' };
  } catch {
    return null;
  }
}

export function researchLimitFor(url: string) {
  return instagramSourceLink(url)?.type === 'profile' ? INSTAGRAM_PROFILE_RESEARCH_LIMIT : RESEARCH_LIMIT;
}

export const ResearchIssueSchema = z.enum(['IG_PERMISSION', 'IG_UID_CHANGED', 'IG_BROWSER', 'IG_NAVIGATION', 'IG_LOAD_TIMEOUT',
  'IG_CHALLENGE', 'IG_LOGIN', 'IG_PRIVATE', 'IG_NO_POSTS', 'IG_UNAVAILABLE', 'IG_NO_GRID', 'IG_NO_MAIN', 'IG_NO_MORE']);
export type ResearchIssue = z.infer<typeof ResearchIssueSchema>;
export const researchIssueText: Record<ResearchIssue, string> = {
  IG_PERMISSION: 'Extension chưa có quyền đọc Instagram trong Chrome profile này.',
  IG_UID_CHANGED: 'UID Facebook của Chrome profile thay đổi trong lúc đọc.',
  IG_BROWSER: 'Chrome không mở được tab hoặc không chạy được trình đọc Instagram.',
  IG_NAVIGATION: 'Instagram đã chuyển sang một trang khác với liên kết được giao.',
  IG_LOAD_TIMEOUT: 'Chrome tải trang Instagram quá thời hạn.',
  IG_CHALLENGE: 'Instagram đang yêu cầu xác minh tài khoản trong Chrome profile này.',
  IG_LOGIN: 'Instagram yêu cầu đăng nhập trong Chrome profile này để xem bài.',
  IG_PRIVATE: 'Tài khoản Instagram đang ở chế độ riêng tư và phiên này chưa xem được bài.',
  IG_NO_POSTS: 'Instagram báo trang cá nhân chưa có bài viết.',
  IG_UNAVAILABLE: 'Instagram báo liên kết này hiện không khả dụng.',
  IG_NO_GRID: 'Instagram đã mở trang nhưng chưa hiển thị danh sách hoặc nội dung bài.',
  IG_NO_MAIN: 'Chrome tải được trang Instagram nhưng chưa thấy vùng nội dung chính.',
  IG_NO_MORE: 'Instagram chưa hiển thị thêm bài trong phiên đọc này.',
};

const link = z.string().url().max(500);
const report = { url: link, partial: z.boolean() };
export const InstagramCommentStatus = z.enum(['READ', 'EMPTY', 'UNAVAILABLE']);
export const ResearchReportSchema = z.discriminatedUnion('kind', [
  z.object({ ...report, kind: z.literal('RESEARCH_PROFILE'), stopReason: ResearchIssueSchema.optional(),
    scrollSteps: z.number().int().nonnegative().safe().optional(), rows: z.array(z.object({
    url: link, title: z.string().max(280), body: z.string().max(700), captionPartial: z.boolean(),
  })).max(INSTAGRAM_PROFILE_RESEARCH_LIMIT) }),
  z.object({ ...report, kind: z.literal('RESEARCH_POST'),
    body: z.string().max(16_000), captionPartial: z.boolean(),
    author: z.string().max(320), authorUrl: link.nullable(), location: z.string().max(320),
    mediaLinks: z.array(z.string().url().max(2048)).max(INSTAGRAM_POST_MEDIA_LIMIT), hasMedia: z.boolean(), mediaPartial: z.boolean(),
    instagramMedia: z.array(z.object({ kind: z.enum(['image', 'video']), url: z.string().url().max(2048) })).max(INSTAGRAM_POST_MEDIA_LIMIT).optional(),
    expectedMediaCount: z.number().int().min(1).max(INSTAGRAM_POST_MEDIA_LIMIT).optional(),
    instagramCommentStatus: InstagramCommentStatus.optional(),
    instagramThreadCheck: z.object({
      check: z.enum(['READ', 'NO_ROWS', 'NAVIGATION', 'SESSION_REQUIRED', 'RATE_LIMITED', 'HTTP_ERROR', 'NON_JSON', 'INVALID_DATA', 'REQUEST_FAILED']),
      expected: z.number().int().nonnegative().safe(), httpStatus: z.number().int().min(300).max(599).optional(),
      windowMinimized: z.boolean().optional(),
      stats: z.object({ firstPage: z.number().int().min(0).max(40), pages: z.number().int().min(0).max(5),
        replyRequests: z.number().int().min(0).max(12), roots: z.number().int().min(0).max(40).optional(),
        advertisedReplies: z.number().int().nonnegative().safe().optional(), withoutText: z.number().int().nonnegative().safe().optional(),
        reported: z.number().int().nonnegative().safe().optional() }).optional(),
    }).optional(),
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
    state: string; result: ResearchReport | null; ownerCode: string | null; issue: ResearchIssue | null; continuous: boolean;
    batch?: { total: number; queued: number; running: number; complete: number; ready: number; failed: number; incomplete: number;
      destination: { code: string; name: string; uid: string } | null;
      importSourceCode: string | null;
      posts: Array<{ url: string; state: string; readerCode: string | null; issue: ResearchIssue | null;
        caption: string | null; images: number; videos: number }> } }>;
  sources: Array<{ id: string; code: string; name: string }>;
  destinations: Array<{ code: string; name: string; uid: string }>;
  profiles: Array<{ code: string; name: string; enabled: boolean; online: boolean; canResearch: boolean; instagramPermission: boolean;
    instagramLoggedIn: boolean | null; canReadInstagram: boolean; canReadInstagramProfile: boolean }>;
}
