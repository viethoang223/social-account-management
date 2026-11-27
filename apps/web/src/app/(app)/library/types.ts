export interface Profile {
  id: string;
  code: string;
  name: string;
  enabled: boolean;
}

export interface Profiles {
  sources: Array<Profile & { connector: string; lastSuccessAt: string | null; lastError: string | null; lastIncomplete: string[]; _count: { posts: number } }>;
  targets: Array<Profile & { _count: { publications: number } }>;
}

export interface Listing {
  profile: Profile;
  kind: 'source' | 'target';
  page: number;
  hasMore: boolean;
  posts: Array<{ id: string; sourceCode: string; date: string; snippet: string; contentType: string; mediaStatus: string;
    status: string; commentCount: number; scanStatus: string | null; archivedAt: string | null }>;
}

export interface Revision {
  id: string;
  text: string;
  albumTitle: string | null;
  incomplete: string[];
  mediaStatus: string;
  sharedPermalink: string | null;
  assets: Array<{ position: number; asset: { id: string; kind: string; status: string; mime: string | null } }>;
}

export interface Destination {
  target: Profile & { audience: string };
  publication: { id: string; status: string; permalink: string | null; directLink: boolean; verifiedAt: string | null; lastReason: string | null;
    commentAccessConfirmed: boolean; extensionTarget: boolean } | null;
  variant: { id: string; caption: string | null; contentType: string; status: string; expiresAt: string | null; reviewReasons: string[];
    audience: string; snapshotHash: string | null; revision: Revision } | null;
}

export interface CommentReplay {
  id: string;
  destinationId: string;
  authorTargetId: string | null;
  personaApprovalId: string | null;
  author: { code: string } | null;
  status: 'DRAFT' | 'APPROVED' | 'QUEUED' | 'SENDING' | 'FAILED' | 'UNKNOWN' | 'POSTED' | 'OMITTED';
  sendDetail: string | null;
  text: string;
  permalink: string | null;
}

export interface SourceComment {
  id: string;
  externalId: string;
  parentExternalId: string | null;
  authorName: string | null;
  text: string;
  permalink: string | null;
  postedAt: string | null;
  replays: CommentReplay[];
}

export interface PostDetail {
  post: { id: string; permalink: string | null; contentType: string; postedAt: string | null; firstSeenAt: string; archivedAt: string | null };
  source: Profile & { connector: string };
  revision: Revision;
  scan: { status: 'QUEUED' | 'RUNNING' | 'COMPLETE' | 'PARTIAL' | 'FAILED'; readCount: number; expectedCount: number | null; detail: string | null } | null;
  instagramComments?: { state: 'UNREAD' | 'QUEUED' | 'RUNNING' | 'READ' | 'EMPTY' | 'UNAVAILABLE' | 'FAILED';
    url: string; canScan: boolean; targetCode: string | null; issue: string | null } | null;
  canScan: boolean;
  comments: SourceComment[];
  composedComments: CommentReplay[];
  authors: Array<Profile & { connector: string }>;
  approvedRoles: Array<{ id: string; speakerId: string; listenerId: string; label: string }>;
  destinations: Destination[];
}

export interface ProfileSyncOption {
  target: Profile;
  latest: {
    id: string;
    phase: 'DISCOVERING' | 'PREPARING' | 'PREPARED' | 'FAILED';
    history: boolean;
    historyDone: boolean;
    detail: string | null;
    updatedAt: string;
    stats: {
      posts: number; toReview: number; approved: number; posted: number; changed: number; missingMedia: number;
      comments: number; commentsDrafted: number; commentsPosted: number; scansPending: number; scansPartial: number; scansComplete: number; scansUnrequested: number;
    } | null;
  } | null;
}
