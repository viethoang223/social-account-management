import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { EXTENSION_CONNECTOR, Q, type JobPayload } from '@seedingsys/contracts';
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
