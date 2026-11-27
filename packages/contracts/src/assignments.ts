export const ASSIGNMENT_CODES = ['X1', 'X2', 'X3', 'X4', 'Y1', 'Y2'] as const;
export type AssignmentCode = typeof ASSIGNMENT_CODES[number];
export type AssignmentStatus = 'PENDING' | 'DONE' | 'CANCELLED';

export const ASSIGNMENT_TYPES = {
  X1: { title: 'Thích bài trên tường B2', input: 'post', brief: false },
  X2: { title: 'Xin vào nhóm Facebook', input: 'group', brief: false },
  X3: { title: 'Tương tác bài trong nhóm', input: 'group-post', brief: false },
  X4: { title: 'Tương tác trên fanpage', input: 'page-post', brief: false },
  Y1: { title: 'Tìm nhóm theo mẫu', input: 'brief', brief: true },
  Y2: { title: 'Chuẩn bị kết bạn và nhắn tin', input: 'profile', brief: true },
} as const satisfies Record<AssignmentCode, { title: string; input: string; brief: boolean }>;

export interface AssignmentTarget {
  id: string;
  code: string;
  name: string;
}

export interface WorkAssignment {
  id: string;
  code: AssignmentCode;
  status: AssignmentStatus;
  source: { id: string; code: string; name: string } | null;
  sourcePostId: string | null;
  fromAssignmentId: string | null;
  urls: string[];
  brief: string;
  results: string[];
  targets: AssignmentTarget[];
  createdAt: string;
}

export interface AssignmentWorkspaceData {
  sources: Array<{ id: string; code: string; name: string;
    posts: Array<{ id: string; url: string; caption: string }> }>;
  targets: Array<AssignmentTarget & { enabled: boolean; paired: boolean; online: boolean }>;
  assignments: WorkAssignment[];
  groupSearches: WorkAssignment[];
}
