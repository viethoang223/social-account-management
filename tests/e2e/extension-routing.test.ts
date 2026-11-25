import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExtensionController } from '../../apps/api/src/extension.controller';
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
  await controller.revoke(h.ids.targets.B1, admin);
  await expect(call1({ action: 'poll' })).rejects.toMatchObject({ status: 401 });
});
