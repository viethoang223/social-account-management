import { BadRequestException, Body, ConflictException, Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ASSIGNMENT_CODES, ASSIGNMENT_TYPES, EXTENSION_CONNECTOR, EXTENSION_FRESH_MS,
  type AssignmentCode, type AssignmentWorkspaceData, type WorkAssignment } from '@seedingsys/contracts';
import { audit, tx, type Db, type Prisma } from '@seedingsys/db';
import { facebookPostLink, facebookSourceUrl, facebookUrl, instagramSourceLink, type Clock } from '@seedingsys/domain';
import { z } from 'zod';
import { Roles, type Principal } from './auth';
import { CLOCK, DB } from './tokens';
import { Actor, parse } from './util';

const urls = z.array(z.string().trim().min(1).max(500)).max(40);
const createInput = z.object({
  id: z.string().uuid(), code: z.enum(ASSIGNMENT_CODES), sourceId: z.string().uuid().optional(),
  sourcePostId: z.string().uuid().optional(), fromAssignmentId: z.string().uuid().optional(),
  urls: urls.default([]), brief: z.string().trim().max(4000).default(''),
  targetIds: z.array(z.string().uuid()).max(100),
});
const updateInput = z.object({ status: z.enum(['DONE', 'CANCELLED']), results: urls.default([]) });
const sourceFields = { id: true, code: true, name: true } as const;
const assignmentInclude = { source: { select: sourceFields }, targets: { select: { target: { select: sourceFields } } } } as const;
const recent = [{ createdAt: 'desc' }, { id: 'desc' }] as const;
const byCode = (a: { code: string }, b: { code: string }) => a.code.localeCompare(b.code, 'vi', { numeric: true });

function view(row: Prisma.WorkAssignmentGetPayload<{ include: typeof assignmentInclude }>): WorkAssignment {
  const { id, code, status, source, sourcePostId, fromAssignmentId, urls, brief, results, targets, createdAt } = row;
  return { id, code: code as AssignmentCode, status, source, sourcePostId, fromAssignmentId, urls, brief, results,
    targets: targets.map(link => link.target).sort(byCode), createdAt: createdAt.toISOString() };
}

function groupUrl(raw: string): string | null {
  const url = facebookUrl(raw);
  const name = url?.pathname.match(/^\/groups\/([\w.-]+)\/?$/i)?.[1];
  if (!name || /^(?:feed|discover|create|joins|search|your_groups)$/i.test(name)) return null;
  return 'https://www.facebook.com/groups/' + name;
}

function assignmentUrl(code: AssignmentCode, raw: string): string | null {
  const input = ASSIGNMENT_TYPES[code].input;
  if (input === 'group') return groupUrl(raw);
  if (input === 'profile') return facebookSourceUrl(raw)?.href ?? null;
  if (input === 'brief') return null;
  const url = facebookUrl(raw);
  if (!url) return null;
  url.hostname = 'www.facebook.com';
  if (input === 'group-post') {
    const groupPost = url.pathname.match(/^\/groups\/([\w.-]+)\/(?:posts|permalink)\/(\w+)\/?$/i);
    return groupPost ? `https://www.facebook.com/groups/${groupPost[1]}/posts/${groupPost[2]}` : null;
  }
  if (input === 'page-post' && url.pathname.startsWith('/groups/')) return null;
  const comment = input === 'page-post' ? url.searchParams.get('comment_id') : null;
  const reply = input === 'page-post' ? url.searchParams.get('reply_comment_id') : null;
  if (input === 'page-post') {
    url.searchParams.delete('comment_id');
    url.searchParams.delete('reply_comment_id');
  }
  const post = facebookPostLink(url.href);
  if (post && /^[\w]{1,200}$/.test(post.id)) {
    if (comment && /^[\w=+-]{1,200}$/.test(comment)) post.url.searchParams.set('comment_id', comment);
    if (reply && /^[\w=+-]{1,200}$/.test(reply)) post.url.searchParams.set('reply_comment_id', reply);
    return post.url.href;
  }
  if (input === 'page-post') return facebookSourceUrl(url.href)?.href ?? null;
  return null;
}

function normalizeLinks(input: string[], normalize: (raw: string) => string | null, invalid: string): string[] {
  const links = input.map(normalize);
  if (links.some(link => link === null)) throw new BadRequestException(invalid);
  return [...new Set(links.filter((link): link is string => link !== null))];
}

@Controller('assignments')
@Roles('operator')
export class AssignmentsController {
  constructor(@Inject(DB) private readonly db: Db, @Inject(CLOCK) private readonly clock: Clock) {}

  @Get()
  async workspace(): Promise<AssignmentWorkspaceData> {
    const [sources, targets, assignments, groupSearches] = await Promise.all([
      this.db.source.findMany({ where: { enabled: true }, select: { ...sourceFields,
        posts: { where: { archivedAt: null, permalink: { not: null } }, orderBy: [{ firstSeenAt: 'desc' }, { id: 'desc' }],
          take: 30, select: { id: true, permalink: true, latestRevisionId: true } } } }),
      this.db.targetAccount.findMany({ where: { code: { startsWith: 'B' } }, select: { ...sourceFields,
        connector: true, enabled: true, extension: { select: { installationId: true } },
        profile: { select: { workerNode: { select: { lastHeartbeatAt: true } } } } } }),
      this.db.workAssignment.findMany({ include: assignmentInclude, orderBy: [...recent], take: 40 }),
      this.db.workAssignment.findMany({ where: { code: 'Y1', status: 'DONE' },
        include: assignmentInclude, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: 20 }),
    ]);
    const revisionIds = sources.flatMap(source => source.posts.flatMap(post => post.latestRevisionId ?? []));
    const captions = new Map((await this.db.sourcePostRevision.findMany({
      where: { id: { in: revisionIds } }, select: { id: true, text: true },
    })).map(revision => [revision.id, revision.text]));
    const now = +this.clock.now();
    return {
      sources: sources.sort(byCode).map(({ posts, ...source }) => ({ ...source, posts: posts.flatMap(post => {
        if (!post.permalink) return [];
        const url = facebookUrl(post.permalink)?.href ?? instagramSourceLink(post.permalink)?.url;
        return url ? [{ id: post.id, url, caption: (captions.get(post.latestRevisionId ?? '') ?? '').slice(0, 110) }] : [];
      }) })),
      targets: targets.sort(byCode).map(({ id, code, name, connector, enabled, extension, profile }) => {
        const paired = connector === EXTENSION_CONNECTOR ? !!extension?.installationId : !!profile;
        const at = profile?.workerNode?.lastHeartbeatAt;
        return { id, code, name, enabled, paired, online: !!(paired && at && now - +at <= EXTENSION_FRESH_MS) };
      }),
      assignments: assignments.map(view),
      groupSearches: groupSearches.map(view),
    };
  }

  @Post()
  async create(@Body() body: unknown, @Actor() actor: Principal): Promise<WorkAssignment> {
    const input = parse(createInput, body);
    const { id, code, sourceId, sourcePostId, fromAssignmentId, brief } = input;
    const targetIds = [...new Set(input.targetIds)];
    const template = ASSIGNMENT_TYPES[code];
    if (code !== 'Y1' && targetIds.length === 0) throw new BadRequestException('Chọn ít nhất một tài khoản B.');
    if (template.brief && !brief) throw new BadRequestException('Điền yêu cầu cho AI Agent.');
    if (sourcePostId && !sourceId) throw new BadRequestException('Chọn nguồn N của bài.');
    if (fromAssignmentId && code !== 'X2') throw new BadRequestException('Kết quả Y1 được chuyển sang X2.');

    return tx(this.db, async t => {
      await t.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 4181))`;
      const existing = await t.workAssignment.findUnique({ where: { id }, include: assignmentInclude });
      if (existing) return view(existing);
      const [source, post, count, prior] = await Promise.all([
        sourceId ? t.source.findFirst({ where: { id: sourceId, enabled: true }, select: { id: true } }) : null,
        sourcePostId ? t.sourcePost.findFirst({ where: { id: sourcePostId, sourceId, archivedAt: null }, select: { permalink: true } }) : null,
        t.targetAccount.count({ where: { id: { in: targetIds }, code: { startsWith: 'B' } } }),
        fromAssignmentId ? t.workAssignment.findFirst({ where: { id: fromAssignmentId, code: 'Y1', status: 'DONE' }, select: { results: true } }) : null,
      ]);
      if ((sourceId && !source) || (sourcePostId && !post)) throw new ConflictException('Nguồn N hoặc bài đã chọn không còn khả dụng.');
      if (count !== targetIds.length) throw new ConflictException('Danh sách tài khoản B đã thay đổi.');
      if (fromAssignmentId && !prior) throw new ConflictException('Chọn kết quả Y1 đã hoàn tất.');
      const canUsePost = ['post', 'group-post', 'page-post'].includes(template.input);
      const raw = input.urls.length ? input.urls : post?.permalink && canUsePost ? [post.permalink] : [];
      const links = normalizeLinks(raw, url => assignmentUrl(code, url), 'Liên kết Facebook chưa đúng với đầu việc ' + code + '.');
      if (code !== 'Y1' && !links.length) throw new BadRequestException('Chọn bài phù hợp trong nguồn N hoặc nhập liên kết Facebook.');
      if (prior && links.some(link => !prior.results.includes(link))) throw new BadRequestException('Chọn nhóm có trong kết quả Y1 đã chọn.');
      const now = this.clock.now();
      const row = await t.workAssignment.create({ data: { id, code, sourceId, sourcePostId, fromAssignmentId, brief, urls: links,
        createdAt: now, targets: { createMany: { data: targetIds.map(targetId => ({ targetId })) } } }, include: assignmentInclude });
      await audit(t, { entityType: 'work_assignment', entityId: id, action: 'saved', to: 'PENDING', actor: actor.actor, at: now,
        data: { code, sourceId, sourcePostId, targetIds, fromAssignmentId } });
      return view(row);
    });
  }

  @Patch(':id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Actor() actor: Principal): Promise<WorkAssignment> {
    const input = parse(updateInput, body);
    const results = normalizeLinks(input.results, groupUrl, 'Kết quả Y1 cần liên kết trực tiếp đến nhóm Facebook.');
    return tx(this.db, async t => {
      const job = await t.workAssignment.findUnique({ where: { id }, include: assignmentInclude });
      if (!job) throw new NotFoundException('Không tìm thấy công việc.');
      if (job.status === input.status) return view(job);
      if (job.status !== 'PENDING') throw new ConflictException('Công việc đã kết thúc.');
      const searching = job.code === 'Y1' && input.status === 'DONE';
      if (searching && !results.length) throw new BadRequestException('Lưu ít nhất một nhóm cho kết quả Y1.');
      if (!searching && results.length) throw new BadRequestException('Chỉ Y1 có kết quả là danh sách nhóm.');
      const updated = await t.workAssignment.updateMany({ where: { id, status: 'PENDING' }, data: { status: input.status, results } });
      if (!updated.count) throw new ConflictException('Công việc vừa được cập nhật. Tải lại danh sách.');
      await audit(t, { entityType: 'work_assignment', entityId: id, action: 'status_changed',
        from: 'PENDING', to: input.status, actor: actor.actor, at: this.clock.now() });
      return view(await t.workAssignment.findUniqueOrThrow({ where: { id }, include: assignmentInclude }));
    });
  }
}
