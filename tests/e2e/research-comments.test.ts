import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { EXTENSION_CONNECTOR, INSTAGRAM_PROFILE_PROTOCOL, Q, type JobPayload } from '@seedingsys/contracts';
import { saveApprovedInstagramBatchPost } from '@seedingsys/db';
import { ExtensionController } from '../../apps/api/src/extension.controller';
import { LibraryController } from '../../apps/api/src/library.controller';
import { PersonasController } from '../../apps/api/src/personas.controller';
import { ResearchController } from '../../apps/api/src/research.controller';
import { handleCommentPublish } from '../../apps/worker-browser/src/handlers/comment-publish';
import { ExtensionPublishConnector } from '../../apps/worker-browser/src/runtime/extension';
import directory from '../fixtures/personas/directory.json';
import { createHarness, type Harness } from '../helpers/harness';

const admin = { role: 'admin', actor: 'integration-admin' } as const;
const profile = 'https://www.facebook.com/profile.php?id=' + directory.profiles[1].uid;
const postUrl = 'https://www.facebook.com/' + directory.profiles[1].uid + '/posts/440';
const commentProtocol = { commentProtocol: 1 as const, researchProtocol: 1 as const };
const instagramProtocol = { ...commentProtocol, instagramResearch: INSTAGRAM_PROFILE_PROTOCOL, instagramLoggedIn: true };
let h: Harness;
let extension: ExtensionController;
let research: ResearchController;
let library: LibraryController;

beforeEach(async () => {
  h = await createHarness({ codes: [1, 2] });
  extension = new ExtensionController(h.db, h.clock);
  research = new ResearchController(h.db, h.clock);
  library = new LibraryController(h.db, h.clock);
});
afterEach(async () => { await h.close(); });

async function pair(code: string, uid: string, capabilities: object = commentProtocol) {
  await h.db.targetAccount.update({ where: { id: h.ids.targets[code] }, data: { externalId: uid, connector: EXTENSION_CONNECTOR } });
  const { token } = await extension.issue(h.ids.targets[code], admin);
  const installed = randomUUID();
  const call = (input: object) => extension.message('Bearer ' + token, {
    installationId: installed, uid, ...input,
  });
  await call({ action: 'poll', ...capabilities });
  return { call, poll: (overrides = {}) => call({ action: 'poll', ...capabilities, ...overrides }) };
}

it('routes Instagram only to a capable profile and imports an authorized album in order without duplicating the post', async () => {
  await pair('B1', directory.profiles[0].uid);
  const profile = await pair('B2', directory.profiles[1].uid, instagramProtocol);
  const sourceId = h.ids.sources.A1;
  await h.db.source.update({ where: { id: sourceId }, data: { connector: 'manual' } });
  const post = 'https://www.instagram.com/p/Example123/';
  const task = await research.enqueue({ url: 'https://www.instagram.com/test/p/Example123/?igsh=sample', limit: 10 }, admin);
  expect(task.targetCode).toBe('B2');
  await expect(profile.poll({ instagramResearch: undefined })).resolves.toMatchObject({ command: null });
  const restored = await profile.poll();
  expect(restored).toMatchObject({ command: { id: task.id, kind: 'RESEARCH_POST', url: post } });
  const urls = ['https://scontent.cdninstagram.com/a.jpg', 'https://scontent.cdninstagram.com/b.jpg'];
  const report = { kind: 'RESEARCH_POST', url: post, body: 'Bài mẫu từ Instagram', captionPartial: false, author: 'test',
    authorUrl: 'https://www.instagram.com/test/', location: '', mediaLinks: urls, hasMedia: true, mediaPartial: false,
    instagramMedia: urls.map(url => ({ kind: 'image', url })), expectedMediaCount: 2, sourceKind: 'post', comments: [], partial: false };
  await expect(profile.call({ action: 'research-complete', commandId: task.id,
    report: { ...report, mediaLinks: ['https://localhost/test.jpg', urls[1]] } })).rejects.toThrow();
  await profile.call({ action: 'research-complete', commandId: task.id, report });
  await expect(research.importPost(task.id, { sourceId }, admin)).rejects.toThrow('quyền sử dụng');
  const imported = await research.importPost(task.id, { sourceId, rightsConfirmed: true }, admin);
  expect(imported).toMatchObject({ contentType: 'MULTI_PHOTO', comments: 0 });
  const again = await research.importPost(task.id, { sourceId, rightsConfirmed: true }, admin);
  expect(again.postId).toBe(imported.postId);
  const saved = await h.db.sourcePost.findUniqueOrThrow({ where: { id: imported.postId } });
  const assets = await h.db.postAsset.findMany({ where: { revisionId: saved.latestRevisionId! },
    orderBy: { position: 'asc' }, include: { asset: true } });
  expect(saved).toMatchObject({ externalId: 'instagram:Example123', permalink: post, contentType: 'MULTI_PHOTO' });
  expect(assets.map(row => row.asset.sourceUrl)).toEqual(urls);

  const thread = { url: post, limit: 20, saveCommentsTo: saved.id };
  await expect(research.enqueue(thread, admin)).rejects.toThrow('1.2.15');
  await profile.poll({ instagramCommentsProtocol: 1 });
  const waitAction = 'wait-instagram-thread';
  await expect(profile.call({ action: waitAction, installationId: randomUUID() })).rejects.toThrow('Phiên ghép profile');
  const waiting = profile.call({ action: waitAction });
  const queued = await research.enqueue(thread, admin);
  await expect(waiting).resolves.toMatchObject({ ready: true, code: 'B2', command: null });
  await expect(profile.call({ action: waitAction })).resolves.toMatchObject({ ready: true, command: null });
  await expect(research.enqueue(thread, admin)).resolves.toEqual(queued);
  await expect(profile.poll()).resolves.toMatchObject({ command: null });
  await expect(profile.poll({ instagramCommentsProtocol: 1 })).resolves.toMatchObject({
    command: { id: queued.id, instagramCommentsOnly: true, url: post },
  });
  const comments = [
    { externalId: '9191', name: 'alice', text: 'Bình luận nguồn', depth: 0 },
    { externalId: '9192', parentExternalId: '9191', name: 'bob', text: 'Phản hồi nguồn', depth: 1 },
  ];
  await profile.call({ action: 'research-complete', commandId: queued.id, report: {
    ...report, mediaLinks: [], instagramMedia: [], body: '', captionPartial: true, mediaPartial: true, partial: true,
    comments, instagramCommentStatus: 'READ',
  } });
  expect(await h.db.sourceComment.findMany({ where: { sourcePostId: saved.id }, orderBy: { position: 'asc' },
    select: { externalId: true, parentExternalId: true, text: true } })).toEqual([
    { externalId: 'instagram:9191', parentExternalId: null, text: 'Bình luận nguồn' },
    { externalId: 'instagram:9192', parentExternalId: 'instagram:9191', text: 'Phản hồi nguồn' },
  ]);
  expect(await h.db.sourcePost.findUniqueOrThrow({ where: { id: saved.id } })).toMatchObject({ latestRevisionId: saved.latestRevisionId });
  expect(await h.db.publicationComment.count({ where: { sourcePostId: saved.id } })).toBe(0);
  expect(await h.db.publication.count({ where: { sourcePostId: saved.id } })).toBe(0);
});

it('reads a forty-post Instagram batch without giving publish work to either the reader or its saved destination', async () => {
  const reader = await pair('B2', directory.profiles[1].uid, { ...instagramProtocol, instagramCommentsProtocol: 1 });
  const destinationUid = directory.profiles[0].uid;
  await h.db.targetAccount.update({ where: { id: h.ids.targets.B1 }, data: { externalId: destinationUid, enabled: false } });
  const url = 'https://www.instagram.com/example_creator/';
  const { id } = await research.enqueue({ url, limit: 40 }, admin);
  const scan = await reader.poll();
  const lease = 'command' in scan && scan.command && 'lease' in scan.command ? scan.command.lease : undefined;
  expect(lease).toBeTypeOf('string');
  const links = Array.from({ length: 40 }, (_, index) => ({
    url: `https://www.instagram.com/${index === 39 ? 'reel' : 'p'}/Example_${index}/`, title: 'Bài Instagram', body: '', captionPartial: true,
  }));
  await reader.call({ action: 'research-complete', commandId: id, lease, report: {
    kind: 'RESEARCH_PROFILE', url, rows: links, partial: false,
  } });
  const binding = await h.db.extensionBinding.findUniqueOrThrow({ where: { targetId: h.ids.targets.B2 } });
  const olderWork = await h.db.extensionRadarScan.create({ data: {
    url: 'https://www.instagram.com/p/OlderWork/', kind: 'RESEARCH_POST', limit: 10, state: 'QUEUED', targetId: binding.targetId,
    installationId: binding.installationId!, createdAt: new Date(+h.clock.now() - 1000), expiresAt: h.clock.now(),
    result: { batch: true, batchProfileId: randomUUID() },
  } });
  await expect(research.readPosts(id, { destinationUid, readerCode: 'B2', includeComments: true }, admin)).resolves.toEqual({ total: 40 });
  await expect(research.readPosts(id, {}, admin)).resolves.toEqual({ total: 40 });
  await expect(reader.poll({ instagramLoggedIn: false })).resolves.toMatchObject({ command: null });
  const result = await reader.poll();
  const selected = 'command' in result ? result.command : null;
  if (!selected || !('url' in selected) || !('kind' in selected)) throw new Error('No research job was dispatched');
  expect(selected.kind).toBe('RESEARCH_POST');
  expect(selected.id).not.toBe(olderWork.id);
  const image = 'https://scontent.cdninstagram.com/example.jpg';
  const caption = '  Dòng một\n\nDòng hai  ';
  await expect(reader.call({ action: 'research-complete', commandId: selected.id, report: {
    kind: 'RESEARCH_POST', url: selected.url, body: caption, captionPartial: false, author: 'example_creator', authorUrl: url,
    location: '', mediaLinks: [image], hasMedia: true, mediaPartial: false, instagramMedia: [{ kind: 'image', url: image }], expectedMediaCount: 1,
    sourceKind: 'post', comments: [], partial: false,
  } })).resolves.toMatchObject({ nextResearchPollMs: 6000 });
  await expect(reader.poll()).resolves.toMatchObject({ command: { id: selected.id, instagramCommentsOnly: true } });
  await reader.call({ action: 'research-complete', commandId: selected.id, report: {
    kind: 'RESEARCH_POST', url: selected.url, body: '', captionPartial: true, author: '', authorUrl: null,
    location: '', mediaLinks: [], hasMedia: true, mediaPartial: true, instagramMedia: [], sourceKind: 'post', partial: true,
    comments: [{ externalId: '999', name: 'alice', text: 'Bình luận từ trang nguồn', depth: 0 }], instagramCommentStatus: 'READ',
  } });
  const captured = await h.db.extensionRadarScan.findUniqueOrThrow({ where: { id: selected.id } });
  expect(captured.result).toMatchObject({ commentsChecked: true, body: caption, instagramCommentStatus: 'READ', mediaLinks: [image] });
  const workspace = await research.workspace();
  expect(workspace.jobs.map(job => job.id)).toEqual([id]);
  expect(workspace.jobs[0].batch).toMatchObject({ total: 40, complete: 1, ready: 1, queued: 39,
    destination: { uid: destinationUid, code: 'B1' }, posts: expect.arrayContaining([
      expect.objectContaining({ url: selected.url, readerCode: 'B2', caption, images: 1 }),
    ]) });
  const sourceId = h.ids.sources.A1;
  await h.db.source.update({ where: { id: sourceId }, data: { connector: 'manual' } });
  await expect(research.importPosts(id, { sourceId }, admin)).rejects.toThrow('quyền sử dụng');
  await expect(research.importPosts(id, { sourceId, rightsConfirmed: true }, admin)).resolves.toMatchObject({ saved: 1, skipped: [] });
  await expect(research.importPosts(id, { sourceId, rightsConfirmed: true }, admin)).resolves.toMatchObject({ saved: 1, skipped: [] });
  const saved = await h.db.sourcePost.findFirstOrThrow({ where: { sourceId } });
  expect(await h.db.sourcePost.count({ where: { sourceId } })).toBe(1);
  expect(await h.db.sourcePostRevision.findUniqueOrThrow({ where: { id: saved.latestRevisionId! } })).toMatchObject({
    text: caption, mediaStatus: 'PENDING', raw: { platform: 'instagram', researchBatchId: id, destinationUid, rightsConfirmed: true },
  });
  expect(await h.db.contentVariant.count({ where: { sourcePostId: saved.id } })).toBe(0);

  const nextPoll = await reader.poll();
  const next = 'command' in nextPoll ? nextPoll.command : null;
  if (!next || !('url' in next)) throw new Error('No second research job was dispatched');
  await reader.call({ action: 'research-complete', commandId: next.id, report: {
    kind: 'RESEARCH_POST', url: next.url, body: 'Video gốc', captionPartial: false, author: 'example_creator', authorUrl: url,
    location: '', mediaLinks: [image], hasMedia: true, mediaPartial: false, instagramMedia: [{ kind: 'video', url: image }], expectedMediaCount: 1,
    sourceKind: 'reel', comments: [], instagramCommentStatus: 'EMPTY', partial: false,
  } });
  const auto = await h.db.outboxEvent.findFirstOrThrow({ where: { queue: Q.InstagramBatchImport } });
  expect(auto.payload).toEqual({ batchId: id, researchId: next.id });
  await expect(saveApprovedInstagramBatchPost(h.db, id, next.id, h.clock.now())).resolves.toBe(true);
  await expect(saveApprovedInstagramBatchPost(h.db, id, next.id, h.clock.now())).resolves.toBe(true);
  expect(await h.db.sourcePost.count({ where: { sourceId } })).toBe(2);
  expect(await h.db.publication.count()).toBe(0);
});

it('recognizes a profile and grants reads only to the installed extension with the right protocol and UID', async () => {
  const old = await pair('B1', directory.profiles[0].uid, {});
  await expect(research.enqueue({ url: profile, limit: 3 }, admin)).rejects.toThrow('Post Research');
  const current = await pair('B2', directory.profiles[1].uid);
  const task = await research.enqueue({ url: profile + '&tracking=test', limit: 3 }, admin);
  expect(task.targetCode).toBe('B2');
  await expect(research.enqueue({ url: profile, limit: 3 }, admin)).resolves.toEqual(task);
  await expect(old.poll()).resolves.toMatchObject({ command: null });
  await expect(current.poll({ uid: directory.profiles[0].uid })).resolves.toMatchObject({ state: 'WRONG_UID', command: null });
  await expect(current.poll()).resolves.toMatchObject({ command: { id: task.id, action: 'research-scan', kind: 'RESEARCH_PROFILE', url: profile, limit: 3 } });
  const report = { kind: 'RESEARCH_PROFILE', url: profile, partial: false, rows: [{ url: postUrl, title: 'Bài thử', body: 'Bài thử', captionPartial: false }] };
  await expect(current.call({ action: 'research-complete', commandId: task.id, report: { ...report, url: postUrl } }))
    .rejects.toThrow('không khớp việc đã giao');
  await expect(current.call({ action: 'research-complete', commandId: task.id, report })).resolves.toEqual({ ok: true });
  expect((await research.workspace()).jobs[0]).toMatchObject({ id: task.id, state: 'COMPLETE', result: report });
  expect((await new PersonasController(h.db, h.clock).workspace()).scans).toEqual([]);
});

it('paces a bound Instagram trial at six seconds after complete content and thirty seconds after an error', async () => {
  const reader = await pair('B2', directory.profiles[1].uid, instagramProtocol);
  const other = await pair('B1', directory.profiles[0].uid, { ...instagramProtocol, instagramCadenceTrial: 1 });
  const targetId = h.ids.targets.B2;
  const binding = await h.db.extensionBinding.findUniqueOrThrow({ where: { targetId } });
  const batchProfileId = randomUUID();
  const ids = Array.from({ length: 3 }, () => randomUUID());
  const urls = ids.map((_, index) => `https://www.instagram.com/p/PacedTrial${index}/`);
  await h.db.extensionRadarScan.createMany({ data: ids.map((id, index) => ({
    id, url: urls[index], targetId, installationId: binding.installationId!, kind: 'RESEARCH_POST', state: 'QUEUED', limit: 10,
    createdAt: new Date(+h.clock.now() + index), expiresAt: new Date(+h.clock.now() + 120_000),
    result: { batch: true, batchProfileId, cadenceTrial: { intervalMs: 6_000,
      ...(index > 0 && { previousId: ids[index - 1] }), ...(index + 1 < ids.length && { nextId: ids[index + 1] }),
    } },
  })) });
  const paced = { instagramCadenceTrial: 1 };
  await expect(other.poll()).resolves.toMatchObject({ command: null });
  await expect(reader.poll()).resolves.toMatchObject({ command: null });
  await expect(reader.poll(paced)).resolves.toMatchObject({ command: { id: ids[0] } });
  const image = 'https://scontent.cdninstagram.com/pace.jpg';
  h.advance(1000);
  await expect(reader.call({ action: 'research-complete', commandId: ids[0], report: {
    kind: 'RESEARCH_POST', url: urls[0], body: 'Caption gốc', captionPartial: false, author: '', authorUrl: null, location: '',
    mediaLinks: [image], hasMedia: true, mediaPartial: false, instagramMedia: [{ kind: 'image', url: image }], expectedMediaCount: 1,
    sourceKind: 'post', comments: [], partial: false,
  } })).resolves.toMatchObject({ ok: true, nextResearchPollMs: 5000 });
  h.advance(4999);
  await expect(reader.poll(paced)).resolves.toMatchObject({ command: null });
  h.advance(1);
  await expect(reader.poll(paced)).resolves.toMatchObject({ command: { id: ids[1] } });
  h.advance(7000);
  await expect(reader.call({ action: 'research-complete', commandId: ids[1], report: null, issue: 'IG_NO_GRID' }))
    .resolves.toMatchObject({ nextResearchPollMs: 23000 });
  h.advance(22999);
  await expect(reader.poll(paced)).resolves.toMatchObject({ command: null });
  h.advance(1);
  await expect(reader.poll(paced)).resolves.toMatchObject({ command: { id: ids[2] } });
  expect(await h.db.outboxEvent.count({ where: { queue: Q.InstagramBatchImport } })).toBe(0);
  expect(await h.db.publication.count()).toBe(0);
});

it('routes an explicitly targeted research read to that profile even if another profile already has the same link', async () => {
  const first = await pair('B1', directory.profiles[0].uid, instagramProtocol);
  const second = await pair('B2', directory.profiles[1].uid, instagramProtocol);
  const url = 'https://www.instagram.com/example_creator/';
  const other = await research.enqueue({ url, limit: 40, targetCode: 'B1' }, admin);
  const selected = await research.enqueue({ url, limit: 40, targetCode: 'B2' }, admin);
  expect(selected.targetCode).toBe('B2');
  expect(selected.id).not.toBe(other.id);
  await expect(research.enqueue({ url, limit: 40, targetCode: 'B2' }, admin)).resolves.toEqual(selected);
  await expect(second.poll()).resolves.toMatchObject({ command: { id: selected.id } });
  await expect(first.poll()).resolves.toMatchObject({ command: { id: other.id } });
  await expect(research.enqueue({ url, limit: 40, targetCode: 'B9' }, admin)).rejects.toThrow('B9');
});

it('saves Instagram checkpoints across expired leases and stops only when the read completes or the user stops it', async () => {
  const reader = await pair('B2', directory.profiles[1].uid, instagramProtocol);
  const url = 'https://www.instagram.com/example_creator/';
  await expect(research.enqueue({ url, limit: 41 }, admin)).rejects.toThrow('tối đa 40');
  await expect(research.enqueue({ url: profile, limit: 40 }, admin)).rejects.toThrow('tối đa 20');
  const { id } = await research.enqueue({ url: 'https://instagram.com/EXAMPLE_CREATOR', limit: 40 }, admin);
  await expect(reader.poll({ instagramResearch: 3 })).resolves.toMatchObject({ command: null });
  const first = await reader.poll();
  expect(first).toMatchObject({ command: { id, kind: 'RESEARCH_PROFILE', url, limit: 40, lifetimeMs: 8_000, checkpoint: null } });
  const firstLease = ('command' in first && first.command && 'lease' in first.command) ? first.command.lease : undefined;
  expect(firstLease).toBeTypeOf('string');
  const rows = Array.from({ length: 40 }, (_, index) => ({ url: `https://www.instagram.com/p/Example_${index}/`,
    title: 'Bài Instagram', body: '', captionPartial: true }));
  const report = { kind: 'RESEARCH_PROFILE', url, partial: false, rows, scrollSteps: 15 };
  const checkpoint = { ...report, rows: rows.slice(0, 12), partial: true };
  await expect(reader.call({ action: 'research-complete', commandId: id, lease: firstLease, pending: true, report: checkpoint }))
    .resolves.toEqual({ ok: true, nextResearchPollMs: 300 });
  expect((await research.workspace()).jobs[0]).toMatchObject({ state: 'RUNNING', result: checkpoint });
  for (let idle = 1; idle <= 3; idle++) {
    const poll = await reader.poll();
    const lease = 'command' in poll && poll.command && 'lease' in poll.command ? poll.command.lease : undefined;
    expect(lease).toBeTypeOf('string');
    await expect(reader.call({ action: 'research-complete', commandId: id, lease, pending: true, report: checkpoint }))
      .resolves.toEqual(idle < 3 ? { ok: true, nextResearchPollMs: 1200 } : { ok: true });
  }
  h.advance(24 * 60 * 60_000);
  expect((await research.workspace()).jobs[0]).toMatchObject({ state: 'WAITING_PROFILE', result: checkpoint });
  const resumed = await reader.poll();
  expect(resumed).toMatchObject({ command: { id, checkpoint } });
  const nextLease = ('command' in resumed && resumed.command && 'lease' in resumed.command) ? resumed.command.lease : undefined;
  expect(nextLease).toBeTypeOf('string');
  expect(nextLease).not.toBe(firstLease);
  await reader.call({ action: 'research-complete', commandId: id, lease: firstLease, report });
  expect((await research.workspace()).jobs[0]).toMatchObject({ state: 'RUNNING', result: checkpoint });
  await expect(reader.call({ action: 'research-complete', commandId: id, lease: nextLease, report })).resolves.toEqual({ ok: true });
  expect((await research.workspace()).jobs[0]).toMatchObject({ id, state: 'COMPLETE', result: report });
  const retry = await research.enqueue({ url, limit: 40 }, admin);
  await expect(reader.poll()).resolves.toMatchObject({ command: { id: retry.id } });
  await expect(research.stop(retry.id, admin)).resolves.toEqual({ ok: true });
  expect((await research.workspace()).jobs.find(job => job.id === retry.id))
    .toMatchObject({ state: 'CANCELLED', result: null });
});

it('uses a logged-in Instagram profile and transfers an automatic job with its saved links when the first Chrome goes offline', async () => {
  const first = await pair('B1', directory.profiles[0].uid, instagramProtocol);
  const second = await pair('B2', directory.profiles[1].uid, instagramProtocol);
  const url = 'https://www.instagram.com/example_creator/';
  await first.poll({ instagramLoggedIn: false });
  await expect(research.enqueue({ url, limit: 40, targetCode: 'B1' }, admin)).rejects.toThrow('B1');
  expect((await research.workspace()).profiles.find(profile => profile.code === 'B1')).toMatchObject({ online: true, instagramLoggedIn: false });
  const { id } = await research.enqueue({ url, limit: 40 }, admin);
  await expect(research.workspace()).resolves.toMatchObject({ jobs: [expect.objectContaining({ id, targetCode: 'B2' })] });
  const claimed = await second.poll();
  const lease = ('command' in claimed && claimed.command && 'lease' in claimed.command) ? claimed.command.lease : undefined;
  const checkpoint = { kind: 'RESEARCH_PROFILE', url, partial: true,
    rows: [{ url: 'https://www.instagram.com/p/Example1/', title: 'Bài Instagram', body: '', captionPartial: true }] };
  await second.call({ action: 'research-complete', commandId: id, lease, pending: true, report: checkpoint });
  h.advance(90_000);
  await expect(first.poll()).resolves.toMatchObject({ command: { id, checkpoint } });
  expect((await research.workspace()).jobs.find(job => job.id === id)).toMatchObject({ targetCode: 'B1', result: checkpoint });
});

it.each([
  { sourceKind: 'post', url: postUrl },
  { sourceKind: 'reel', url: 'https://www.facebook.com/reel/930/' },
])('publishes a composed root comment on a $sourceKind with no source comments', async ({ sourceKind, url }) => {
  const sender = await pair('B1', directory.profiles[0].uid, { ...commentProtocol, commentProtocol: 2 });
  const owner = await pair('B2', directory.profiles[1].uid);
  const personas = new PersonasController(h.db, h.clock);
  await personas.importPeople({ revision: 0, registry: directory }, admin);
  const role = { from: 'author', to: 'advisor' };
  const preview = await personas.preview(role);
  const approved = await personas.approve({ ...role, fingerprint: preview.fingerprint }, admin);
  const sourceId = h.ids.sources.A1;
  const destinationId = h.ids.targets.B2;
  await h.db.source.update({ where: { id: sourceId }, data: { connector: 'manual' } });
  const { id: job } = await research.enqueue({ url, limit: 5 }, admin);
  await expect(sender.poll()).resolves.toMatchObject({ command: { id: job, action: 'research-scan' } });
  await sender.call({ action: 'research-complete', commandId: job, report: {
    kind: 'RESEARCH_POST', url, body: 'Bài chưa có bình luận', captionPartial: false, author: 'Chủ bài',
    authorUrl: profile, location: '', mediaLinks: [], hasMedia: sourceKind === 'reel', mediaPartial: false, sourceKind,
    partial: false, comments: [],
  } });
  const { postId } = await research.importPost(job, { sourceId, useExisting: true, textOnly: sourceKind === 'reel' }, admin);
  expect(await h.db.sourceComment.count({ where: { sourcePostId: postId } })).toBe(0);
  const draft = randomUUID();
  const text = 'Bình luận mới từ dashboard.';
  const update = (body: object) => library.updateNewComment(postId, destinationId, draft, body, admin);
  await update({ action: 'draft', text, personaApprovalId: approved.id });
  await expect(update({ action: 'send' })).rejects.toThrow('duyệt bình luận');
  await update({ action: 'approve', text, personaApprovalId: approved.id });
  await library.confirmCommentAccess(postId, destinationId, { confirmed: true }, admin);
  await update({ action: 'send' });
  await expect(update({ action: 'send' })).rejects.toThrow('đang xử lý');
  h.browser.registry.addPublisher(new ExtensionPublishConnector(h.db, h.clock));
  const run = handleCommentPublish(h.browser, { replayId: draft, sendVersion: 1 });
  const claim = async (action: 'comment-prepare' | 'comment-commit') => {
    await expect.poll(() => h.db.extensionCommand.count({ where: { action, claimedAt: null } })).toBe(1);
    await expect(owner.poll()).resolves.toMatchObject({ command: null });
    await expect(sender.poll({ commentProtocol: 1 })).resolves.toMatchObject({ command: null });
    const response = await sender.poll();
    expect(response).toMatchObject({ command: { action, caption: text, comment: { replayId: draft, postUrl: url, composed: true } } });
    if (!('command' in response) || !response.command) throw new Error('Missing extension command');
    return response.command.id;
  };
  const prepare = await claim('comment-prepare');
  await sender.call({ action: 'complete', commandId: prepare, outcome: 'prepared' });
  const commit = await claim('comment-commit');
  await sender.call({ action: 'authorize', commandId: commit });
  await expect(sender.call({ action: 'authorize', commandId: commit })).rejects.toThrow();
  const permalink = url + '?comment_id=910';
  await sender.call({ action: 'complete', commandId: commit, outcome: 'clicked', receipt: { externalId: '910', permalink },
    verification: 'reopened-post' });
  await run;
  expect(await library.detail(postId, admin)).toMatchObject({ comments: [],
    composedComments: [{ id: draft, text, status: 'POSTED', permalink, author: { code: 'B1' } }] });
  expect(await h.db.publicationComment.findUnique({ where: { id: draft } })).toMatchObject({ sourceCommentId: null, sourcePostId: postId });
  expect(await h.db.extensionCommand.findUnique({ where: { id: commit } })).toMatchObject({
    result: { outcome: 'clicked', verification: 'reopened-post', receipt: { externalId: '910', permalink } },
  });
});

it('imports a research thread once, dispatches approved root and reply to different UIDs, and never retries an uncertain click', async () => {
  const sender = await pair('B1', directory.profiles[0].uid);
  const owner = await pair('B2', directory.profiles[1].uid);
  const personas = new PersonasController(h.db, h.clock);
  await personas.importPeople({ revision: 0, registry: directory }, admin);
  const approveRole = async (from: string, to: string) => {
    const input = { from, to };
    const preview = await personas.preview(input);
    return personas.approve({ ...input, fingerprint: preview.fingerprint }, admin);
  };
  const forward = await approveRole('author', 'advisor');
  const reverse = await approveRole('advisor', 'author');
  const sourceId = h.ids.sources.A1;
  const destinationId = h.ids.targets.B2;
  await h.db.source.update({ where: { id: sourceId }, data: { connector: 'manual' } });
  const task = await research.enqueue({ url: postUrl, limit: 5 }, admin);
  expect(task.targetCode).toBe('B1');
  await expect(sender.poll()).resolves.toMatchObject({ command: { id: task.id, action: 'research-scan', kind: 'RESEARCH_POST' } });
  const report = { url: postUrl, kind: 'RESEARCH_POST', body: 'Mô tả đầy đủ của bài', captionPartial: false, author: 'Người viết',
    authorUrl: profile, location: '', mediaLinks: [], hasMedia: false, mediaPartial: false, sourceKind: 'post', partial: false,
    comments: [{ externalId: '700', name: 'Khách', text: 'Nội dung gốc', depth: 0 },
      { externalId: '701', name: 'Khách khác', text: 'Phản hồi gốc', depth: 1 }] };
  await sender.call({ action: 'research-complete', commandId: task.id, report });
  const saved = await research.importPost(task.id, { sourceId, useExisting: true }, admin);
  await expect(research.importPost(task.id, { sourceId, useExisting: true }, admin)).resolves.toEqual(saved);
  expect(saved.ownerCode).toBe('B2');
  expect(await h.db.publication.count()).toBe(1);
  const comments = await h.db.sourceComment.findMany({ where: { sourcePostId: saved.postId }, orderBy: { position: 'asc' } });
  expect(comments.map(c => [c.externalId, c.parentExternalId])).toEqual([['700', null], ['701', '700']]);
  const [root, reply] = comments;
  const update = (id: string, body: object) => library.updateComment(saved.postId, destinationId, id, body, admin);
  await expect(update(root.id, { action: 'approve', text: 'Em chào anh', personaApprovalId: reverse.id })).rejects.toThrow('người nghe');
  await update(root.id, { action: 'approve', text: 'Anh chào em', personaApprovalId: forward.id });
  await update(reply.id, { action: 'approve', text: 'Em chào anh', personaApprovalId: reverse.id });
  await expect(update(root.id, { action: 'send' })).rejects.toThrow('Chỉ mình tôi');
  await library.confirmCommentAccess(saved.postId, destinationId, { confirmed: true }, admin);
  await expect(library.sendApprovedComments(saved.postId, destinationId, admin)).resolves.toMatchObject({ queued: 2, skipped: [] });
  const jobs = (await h.db.outboxEvent.findMany({ where: { queue: Q.CommentPublish }, orderBy: { id: 'asc' } }))
    .map(row => row.payload as JobPayload<typeof Q.CommentPublish>);
  h.browser.registry.addPublisher(new ExtensionPublishConnector(h.db, h.clock));
  await expect(handleCommentPublish(h.browser, jobs[1])).rejects.toThrow('Chờ bình luận cha');

  async function run(index: number, profile: typeof sender, wrong: typeof sender, expected: object, receipt?: object) {
    const result = handleCommentPublish(h.browser, jobs[index]);
    try {
      const next = async (action: 'comment-prepare' | 'comment-commit') => {
        await expect.poll(() => h.db.extensionCommand.count({ where: { action, claimedAt: null, expiresAt: { gt: h.clock.now() } } }))
          .toBe(1);
        await expect(wrong.poll()).resolves.toMatchObject({ command: null });
        const response = await profile.poll();
        expect(response).toMatchObject({ command: { action, comment: expected } });
        if (!('command' in response) || !response.command) throw new Error('Missing extension command');
        return response.command.id;
      };
      const prepare = await next('comment-prepare');
      await expect(profile.call({ action: 'authorize', commandId: prepare })).rejects.toThrow();
      await profile.call({ action: 'complete', commandId: prepare, outcome: 'prepared' });
      const commit = await next('comment-commit');
      await expect(wrong.call({ action: 'authorize', commandId: commit })).rejects.toThrow();
      await expect(profile.call({ action: 'authorize', commandId: commit, uid: '9999999' })).rejects.toThrow();
      await expect(profile.call({ action: 'authorize', commandId: commit })).resolves.toMatchObject({ lifetimeMs: 5000 });
      await expect(profile.call({ action: 'authorize', commandId: commit })).rejects.toThrow();
      await profile.call({ action: 'complete', commandId: commit, outcome: 'clicked', receipt });
    } finally {
      await result;
    }
  }
  const receipt = { externalId: '900', permalink: postUrl + '?comment_id=900' };
  await run(0, sender, owner, { postUrl }, receipt);
  expect(await h.db.publicationComment.findUnique({ where: { id: jobs[0].replayId } }))
    .toMatchObject({ status: 'POSTED', authorTargetId: h.ids.targets.B1, ...receipt });
  await run(1, owner, sender, { postUrl: receipt.permalink, parentId: '900' });
  expect(await h.db.publicationComment.findUnique({ where: { id: jobs[1].replayId } }))
    .toMatchObject({ status: 'UNKNOWN', authorTargetId: h.ids.targets.B2 });
  await handleCommentPublish(h.browser, jobs[1]);
  await expect(owner.poll()).resolves.toMatchObject({ command: null });
});
