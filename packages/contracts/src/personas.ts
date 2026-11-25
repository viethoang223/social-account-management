import { z } from 'zod';

export const PERSONA_ROLES = {
  author: ['Tác giả / chủ nhóm', 'mình', 'bạn'],
  junior_male: ['Đàn em nam', 'em', 'anh/chị'],
  junior_female: ['Đàn em nữ', 'em', 'anh/chị'],
  junior: ['Đàn em · chưa đặt giới tính', 'em', 'anh/chị'],
  senior_male: ['Đàn anh', 'anh', 'em'],
  senior_female: ['Đàn chị', 'chị', 'em'],
  male_friend: ['Bạn nam', 'mình', 'bạn'],
  female_friend: ['Bạn nữ', 'mình', 'bạn'],
  mentor: ['Sư phụ', '', ''],
  elder_relative: ['Người lớn tuổi', '', ''],
  colleague: ['Đồng nghiệp', 'mình', 'bạn'],
  custom: ['Vai trò tự đặt', 'mình', 'bạn'],
} as const;

export const PERSONA_CONCEPTS = {
  ageGroup: ['Sinh viên', 'Đi làm', 'Trung niên'],
  incomeGroup: ['Xin việc', 'Dân VP', 'Thu nhập cao'],
  socialClass: ['Lao động', 'Bình thường', 'VIP'],
  traitGroup: ['Ngây thơ', 'Hiểu biết', 'Cá tính mạnh', 'Ngốc/Ngã cây'],
} as const;

export const RADAR_AXES = {
  demographic: [
    ['age', 'Tuổi'], ['income', 'Thu nhập'], ['class', 'Đẳng cấp'], ['education', 'Học vấn'],
    ['urban', 'Đô thị'], ['family', 'Giai đoạn gia đình'],
  ],
  personality: [
    ['naive', 'Ngây thơ'], ['knowledgeable', 'Hiểu biết'], ['assertive', 'Cá tính mạnh'], ['goofy', 'Ngốc/Ngã cây'],
    ['extravert', 'Hướng ngoại'], ['expressive', 'Bộc lộ cảm xúc'], ['driven', 'Cầu tiến'], ['family_care', 'Chăm lo gia đình'],
  ],
} as const;

type RoleName = keyof typeof PERSONA_ROLES;
const role = z.custom<RoleName>(value => typeof value === 'string' && Object.hasOwn(PERSONA_ROLES, value), 'Vai trò không hợp lệ.');
const text = (limit: number) => z.string().trim().max(limit).default('');
export const PersonaId = z.string().trim().regex(/^[\w-]{1,80}$/);
const uid = z.string().trim().regex(/^\d{5,25}$/);
const aliasedName = z.string().trim().min(1).max(80);

export const PersonaProfileSchema = z.object({
  id: PersonaId, alias: aliasedName, name: text(120), uid: uid.or(z.literal('')).default(''), role,
  gender: z.enum(['male', 'female', 'unspecified', '']).default('unspecified'),
  enabled: z.boolean().default(true), status: text(500), personality: text(1500), tone: text(1000),
  self: text(40), other: text(40), bio: text(3000), memory: text(6000), rules: text(2000), workArea: text(120),
  concept: z.object({
    ageGroup: z.array(z.enum(PERSONA_CONCEPTS.ageGroup)).max(3).default([]),
    incomeGroup: z.array(z.enum(PERSONA_CONCEPTS.incomeGroup)).max(3).default([]),
    socialClass: z.array(z.enum(PERSONA_CONCEPTS.socialClass)).max(3).default([]),
    traitGroup: z.array(z.enum(PERSONA_CONCEPTS.traitGroup)).max(4).default([]),
  }).default({}),
  source: z.object({ sheetName: text(100), originalName: text(120), row: z.number().int().nonnegative().optional() }).optional(),
});

export const PersonaRelationSchema = z.object({
  from: PersonaId, to: PersonaId, role, self: text(40), other: text(40), notes: text(2000),
});

export const PersonaRegistrySchema = z.object({
  schema: z.literal('desk.personas/1'), registryId: text(80), revision: z.number().int().nonnegative().default(0),
  profiles: z.array(PersonaProfileSchema).max(100), relations: z.array(PersonaRelationSchema).max(2000),
}).superRefine((registry, ctx) => {
  for (const field of ['id', 'alias', 'uid'] as const) {
    const values = registry.profiles.map(p => p[field]).filter(Boolean)
      .map(value => value.normalize('NFKC').toLocaleLowerCase('vi'));
    if (new Set(values).size !== values.length) {
      ctx.addIssue({ code: 'custom', path: ['profiles'], message: 'Trùng mã, tên nhân vật hoặc UID trong danh bạ.' });
      break;
    }
  }
  const profiles = new Map(registry.profiles.map(p => [p.id, p]));
  const pairs = new Set<string>();
  for (const relation of registry.relations) {
    const key = relation.from + ':' + relation.to;
    const from = profiles.get(relation.from);
    const to = profiles.get(relation.to);
    if (!from || !to || relation.from === relation.to || pairs.has(key)) {
      ctx.addIssue({ code: 'custom', path: ['relations'], message: 'Quan hệ phải nối hai nhân vật khác nhau và duy nhất theo từng chiều.' });
      continue;
    }
    pairs.add(key);
    const problem = personaRelationProblem(from, to, relation.role);
    if (problem) ctx.addIssue({ code: 'custom', path: ['relations', key], message: problem });
  }
});

export function personaRelationProblem(from: PersonaProfile, to: PersonaProfile, relationRole: RoleName): string | null {
  const fromSheet = (p: PersonaProfile) => p.source?.sheetName.normalize('NFC').toLocaleLowerCase('vi') === 'nhân cách';
  if (!fromSheet(from) && !fromSheet(to)) return null;
  const ageRank = (p: PersonaProfile) => p.concept.ageGroup.length === 1 ? PERSONA_CONCEPTS.ageGroup.indexOf(p.concept.ageGroup[0]) : -1;
  const junior = ['junior', 'junior_male', 'junior_female'].includes(relationRole);
  const senior = ['senior_male', 'senior_female', 'elder_relative'].includes(relationRole);
  const a = ageRank(from);
  const b = ageRank(to);
  if ((junior || senior) && (a < 0 || b < 0)) return 'Hồ sơ từ Sheet Nhân cách cần nhóm tuổi rõ ràng để gán vai trên hoặc dưới.';
  if (junior && a >= b) return 'Vai đàn em cần thuộc nhóm tuổi nhỏ hơn người nghe theo Sheet Nhân cách.';
  if (senior && a <= b) return 'Vai đàn anh, đàn chị hoặc người lớn tuổi cần thuộc nhóm tuổi lớn hơn người nghe theo Sheet Nhân cách.';
  const gender = relationRole.endsWith('_male') || relationRole === 'male_friend' ? 'male'
    : relationRole.endsWith('_female') || relationRole === 'female_friend' ? 'female' : null;
  if (gender && from.gender !== gender) return 'Giới tính của vai không khớp với hồ sơ trong Sheet Nhân cách.';
  return null;
}

export type PersonaProfile = z.infer<typeof PersonaProfileSchema>;
export type PersonaRelation = z.infer<typeof PersonaRelationSchema>;
export type PersonaRegistry = z.infer<typeof PersonaRegistrySchema>;

export interface RadarAxis {
  id: string;
  label: string;
  score: number | null;
  originalScore: number | null;
  manual: boolean;
  confidence: string;
  note: string;
  evidence: Array<{ text: string; why: string }>;
}

export interface RadarReport {
  demographic: RadarAxis[];
  personality: RadarAxis[];
  postsRead: number;
}

export interface RadarSummary {
  id: string;
  name: string;
  url: string;
  analyzedAt: string;
}

export interface RadarScanSummary {
  id: string;
  url: string;
  targetCode: string;
  state: 'QUEUED' | 'RUNNING' | 'COMPLETE' | 'FAILED' | 'EXPIRED';
  radarId: string | null;
  createdAt: string;
}

export interface PersonaTarget {
  id: string;
  code: string;
  uid: string;
  enabled: boolean;
  online: boolean;
}

export interface PersonaPreview {
  speaker: { alias: string; name: string; uid: string; code: string; tone: string; workArea: string };
  listener: { alias: string; name: string; uid: string; code: string };
  relationship: { role: RoleName; label: string; self: string; other: string; notes: string };
  topic: string;
  sample: string;
  radar: RadarSummary | null;
  radarReport: RadarReport | null;
  fingerprint: string;
}

export interface PersonaContextExport {
  schema: 'desk.persona-context/1';
  registryId: string;
  revision: number;
  speaker: PersonaProfile;
  target: Pick<PersonaProfile, 'id' | 'uid' | 'alias' | 'name' | 'status'>;
  relationship: PersonaRelation & { label: string };
  topic: string;
  longTermContext: string;
  rules: string;
  capabilities: { previewOnly: true; canSendComment: false };
  instruction: string;
}

export interface PersonaApproval {
  id: string;
  context: PersonaPreview;
  approvedBy: string;
  approvedAt: string;
}

export interface PersonaWorkspaceData {
  registry: PersonaRegistry;
  targets: PersonaTarget[];
  radars: RadarSummary[];
  scans: RadarScanSummary[];
  approvals: PersonaApproval[];
  roles: Array<{ id: RoleName; label: string; self: string; other: string }>;
}
