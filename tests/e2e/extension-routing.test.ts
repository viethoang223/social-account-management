import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExtensionController } from '../../apps/api/src/extension.controller';
import { ConfigController } from '../../apps/api/src/config.controller';
import { ExtensionPublishConnector } from '../../apps/worker-browser/src/runtime/extension';
import { handlePublish, handleReconcile } from '../../apps/worker-browser/src';
import { dispatchBacklogItem, setControl } from '@seedingsys/db';
import { EXTENSION_CONNECTOR } from '@seedingsys/contracts';
import { createHarness, cycle, MIN, type Harness } from '../helpers/harness';

let h: Harness;
beforeEach(async () => { h = await createHarness({ codes: [1, 2] }); });
afterEach(async () => { await h.close(); });

const admin = { role: 'admin', actor: 'test-admin' } as const;
const uid1 = '10001001';
const uid2 = '10001002';

it('creates mappings for checked targets in one batch and preserves existing mappings', async () => {
  const config = new ConfigController(h.db, h.clock);
  const sourceId = h.ids.sources.A1;
  const original = await h.db.sourceTargetMapping.findUniqueOrThrow({
    where: { sourceId_targetId: { sourceId, targetId: h.ids.targets.B1 } },
  });
  await expect(config.createMappings({ sourceId, targetIds: [h.ids.targets.B1, h.ids.targets.B2, h.ids.targets.B2],
    reviewMode: 'MANUAL' }, admin)).resolves.toMatchObject({
    created: [{ sourceId, targetId: h.ids.targets.B2, reviewMode: 'MANUAL' }], skipped: 1,
  });
  await expect(h.db.sourceTargetMapping.findUnique({ where: { id: original.id } })).resolves.toMatchObject({
    reviewMode: original.reviewMode, enabled: original.enabled,
  });
});

it('imports unique UIDs as disabled targets and preserves existing accounts', async () => {
  const controller = new ExtensionController(h.db, h.clock);
  const result = await controller.importUids({ uids: [uid1, uid2, uid1] }, admin);
  expect(result.added).toEqual([{ code: 'B3', uid: uid1 }, { code: 'B4', uid: uid2 }]);
  await expect(controller.importUids({ uids: [uid1] }, admin)).resolves.toEqual({ added: [], skipped: [uid1] });
  expect(await h.db.targetAccount.count({ where: { enabled: false, connector: EXTENSION_CONNECTOR } })).toBe(2);
  expect(await h.db.targetAccount.count({ where: { enabled: true, connector: 'fake' } })).toBe(2);
});

async function setup() {
  const controller = new ExtensionController(h.db, h.clock);
  h.browser.registry.addPublisher(new ExtensionPublishConnector(h.db, h.clock));
  await h.db.targetAccount.update({ where: { id: h.ids.targets.B1 }, data: { connector: EXTENSION_CONNECTOR, externalId: uid1 } });
  await h.db.targetAccount.update({ where: { id: h.ids.targets.B2 }, data: { connector: EXTENSION_CONNECTOR, externalId: uid2 } });
  const { token: token1 } = await controller.issue(h.ids.targets.B1, admin);
  const { token: token2 } = await controller.issue(h.ids.targets.B2, admin);
  const profile1 = { installationId: randomUUID(), uid: uid1 };
  const profile2 = { installationId: randomUUID(), uid: uid2 };
  const call1 = (message: object) => controller.message('Bearer ' + token1, { ...profile1, ...message });
  const call2 = (message: object) => controller.message('Bearer ' + token2, { ...profile2, ...message });
  return { controller, call1, call2 };
}

async function readyPosts() {
  await cycle(h);
  h.platform.addSourcePost('A1', { contentType: 'TEXT', text: 'Nội dung riêng cho B1', media: [] });
  h.platform.addSourcePost('A2', { contentType: 'TEXT', text: 'Nội dung riêng cho B2', media: [] });
  h.advance(5 * MIN);
  await cycle(h);
  const [first, second] = await Promise.all(['B1', 'B2'].map(code => h.db.contentVariant.findFirstOrThrow({
    where: { targetId: h.ids.targets[code], status: 'READY' },
  })));
  return { first, second };
}

it('pins two accounts, rejects switched profiles, and keeps each command in its own profile', async () => {
  const { controller, call1, call2 } = await setup();
  const { first, second } = await readyPosts();
  await expect(call1({ action: 'poll', uid: uid2 })).resolves.toMatchObject({ state: 'WRONG_UID', command: null });
  await expect(dispatchBacklogItem(h.core, first.id)).rejects.toThrow('NO_WORKER');
  await expect(call1({ action: 'poll' })).resolves.toMatchObject({ code: 'B1', state: 'CONNECTED' });
  await expect(call2({ action: 'poll' })).resolves.toMatchObject({ code: 'B2', state: 'CONNECTED' });
  await expect(call1({ action: 'poll', installationId: randomUUID() })).rejects.toMatchObject({ status: 401 });
  const [pub1, pub2] = await Promise.all([dispatchBacklogItem(h.core, first.id), dispatchBacklogItem(h.core, second.id)]);
  const publishing = [pub1, pub2].map(publicationId => handlePublish(h.browser, { publicationId, jobVersion: 1 }));
  await vi.waitFor(async () => {
    expect(await h.db.extensionCommand.count({ where: { action: 'prepare' } })).toBe(2);
  }, { timeout: 5_000 });
  const [draft1, draft2] = await Promise.all([call1({ action: 'poll' }), call2({ action: 'poll' })]);
  expect(draft1).toMatchObject({ command: { caption: expect.stringContaining('riêng cho B1') } });
  expect(draft2).toMatchObject({ command: { caption: expect.stringContaining('riêng cho B2') } });
  const a = 'command' in draft1 ? draft1.command! : null;
  const b = 'command' in draft2 ? draft2.command! : null;
  await expect(call2({ action: 'complete', commandId: a!.id, outcome: 'prepared' })).rejects.toMatchObject({ status: 409 });
  await call1({ action: 'complete', commandId: a!.id, outcome: 'prepared' });
  await call2({ action: 'complete', commandId: b!.id, outcome: 'prepared' });
  await vi.waitFor(async () => {
    expect(await h.db.extensionCommand.count({ where: { action: 'commit' } })).toBe(2);
  }, { timeout: 5_000 });
  const [commit1, commit2] = await Promise.all([call1({ action: 'poll' }), call2({ action: 'poll' })]);
  if (!('command' in commit1) || !commit1.command || !('command' in commit2) || !commit2.command) throw new Error('Missing commit');
  await expect(call1({ action: 'poll' })).resolves.toMatchObject({ command: null });
  await expect(call1({ action: 'authorize', commandId: commit1.command.id, uid: uid2 })).rejects.toMatchObject({ status: 409 });
  await expect(call1({ action: 'authorize', commandId: commit1.command.id })).resolves.toMatchObject({ lifetimeMs: 5000 });
  await expect(call1({ action: 'authorize', commandId: commit1.command.id })).rejects.toMatchObject({ status: 409 });
  await setControl(h.db, 'TARGET', h.ids.targets.B2, true, admin.actor, 'Test stop');
  await expect(call2({ action: 'authorize', commandId: commit2.command.id })).rejects.toMatchObject({ status: 409 });
  await call1({ action: 'complete', commandId: commit1.command.id, outcome: 'clicked' });
  await call2({ action: 'complete', commandId: commit2.command.id, outcome: 'blocked' });
  expect(await Promise.all(publishing)).toEqual(['UNKNOWN', 'UNKNOWN']);
  await expect(handlePublish(h.browser, { publicationId: pub1, jobVersion: 1 })).resolves.toBe('STALE');
  expect(await h.db.extensionCommand.count({ where: { action: 'commit', targetId: h.ids.targets.B1 } })).toBe(1);
  await expect(handleReconcile(h.browser, { publicationId: pub1 })).resolves.toBe('NEEDS_OPERATOR');
  const queued = await controller.verifyOldPublication(pub1);
  await expect(controller.verifyOldPublication(pub1)).resolves.toEqual(queued);
  await expect(call1({ action: 'poll' })).resolves.toMatchObject({ command: null });
  await expect(call2({ action: 'poll', publicationVerifyProtocol: 1 })).resolves.toMatchObject({ command: null });
  const readback = await call1({ action: 'poll', publicationVerifyProtocol: 1 });
  const command = 'command' in readback ? readback.command : null;
  if (!command || !('from' in command)) throw new Error('Missing read-only command');
  expect(command).toMatchObject({ id: queued.commandId, action: 'publication-verify' });
  await expect(call1({ action: 'authorize', commandId: command.id })).rejects.toMatchObject({ status: 409 });
  const permalink = 'https://www.facebook.com/permalink.php?id=' + uid1 + '&story_fbid=341';
  const candidate = { uid: uid1, caption: command.caption, createdAt: command.from + 10_000, permalink };
  const completed = (id: string, candidates: object[], reopened: boolean) => ({ action: 'publication-verify-complete',
    commandId: id, report: { candidates, reopened } });
  await expect(call2(completed(command.id, [candidate], true))).resolves.toMatchObject({ outcome: 'STALE' });
  await expect(call1(completed(command.id, [candidate, { ...candidate, permalink: permalink.replace('341', '342') }], false)))
    .resolves.toMatchObject({ outcome: 'AMBIGUOUS' });
  await expect(h.db.publication.findUnique({ where: { id: pub1 } })).resolves.toMatchObject({ status: 'NEEDS_OPERATOR', permalink: null });
  const retry = await controller.verifyOldPublication(pub1);
  await expect(call1({ action: 'poll', publicationVerifyProtocol: 1 })).resolves.toMatchObject({ command: { id: retry.commandId } });
  await expect(call1(completed(retry.commandId, [{ ...candidate, createdAt: command.from - 1 }], true))).resolves.toMatchObject({ outcome: 'UNCONFIRMED' });
  const final = await controller.verifyOldPublication(pub1);
  await expect(call1({ action: 'poll', publicationVerifyProtocol: 1 })).resolves.toMatchObject({ command: { id: final.commandId } });
  await expect(call1(completed(final.commandId, [candidate], true))).resolves.toMatchObject({ outcome: 'VERIFIED' });
  await expect(h.db.publication.findUnique({ where: { id: pub1 } })).resolves.toMatchObject({ status: 'PUBLISHED_VERIFIED', permalink,
    externalPostId: '341', publishTries: 1, lastReason: null });
  await expect(h.db.operatorTask.findFirst({ where: { publicationId: pub1, kind: 'CONFIRM_RESULT' } }))
    .resolves.toMatchObject({ status: 'DONE' });
  await controller.revoke(h.ids.targets.B1, admin);
  await expect(call1({ action: 'poll' })).rejects.toMatchObject({ status: 401 });
});

it('routes a public draft only to the updated profile and verifies the one posted link', async () => {
  const { call1 } = await setup();
  const targets = new ConfigController(h.db, h.clock);
  await expect(targets.updateTarget(h.ids.targets.B1, { audience: 'PUBLIC' }, admin)).resolves.toMatchObject({ audience: 'PUBLIC' });
  const { first } = await readyPosts();
  const poll = () => call1({ action: 'poll', publishProtocol: 2 });
  await poll();
  const publicationId = await dispatchBacklogItem(h.core, first.id);
  const publish = handlePublish(h.browser, { publicationId, jobVersion: 1 });
  const next = async (action: string) => {
    await vi.waitFor(async () => {
      expect(await h.db.extensionCommand.count({ where: { publicationId, action } })).toBe(1);
    }, { timeout: 5_000 });
    await expect(call1({ action: 'poll' })).resolves.toMatchObject({ command: null });
    const response = await poll();
    expect(response).toMatchObject({ command: { action, audience: 'PUBLIC' } });
    if (!('command' in response) || !response.command) throw new Error('Missing publication command');
    return response.command.id;
  };
  const prepare = await next('prepare');
  await call1({ action: 'complete', commandId: prepare, outcome: 'prepared' });
  const commit = await next('commit');
  await expect(call1({ action: 'authorize', commandId: commit })).resolves.toMatchObject({ lifetimeMs: 5000 });
  await expect(call1({ action: 'authorize', commandId: commit })).rejects.toMatchObject({ status: 409 });
  const permalink = 'https://www.facebook.com/' + uid1 + '/posts/253';
  await expect(call1({ action: 'complete', commandId: commit, outcome: 'clicked',
    receipt: { externalId: '253', permalink: permalink + '?comment_id=6' } })).rejects.toMatchObject({ status: 409 });
  await call1({ action: 'complete', commandId: commit, outcome: 'clicked', verification: 'reopened-post',
    receipt: { externalId: '253', permalink } });
  await expect(publish).resolves.toBe('PUBLISHED_VERIFIED');
  await expect(h.db.publication.findUnique({ where: { id: publicationId } })).resolves.toMatchObject({
    status: 'PUBLISHED_VERIFIED', externalPostId: '253', permalink,
  });
});
