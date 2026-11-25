import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { EXTENSION_CONNECTOR } from '@seedingsys/contracts';
import { accountResource, acquireLease, releaseLease } from '@seedingsys/db';
import { ExtensionController } from '../../apps/api/src/extension.controller';
import { PersonasController } from '../../apps/api/src/personas.controller';
import directoryExport from '../fixtures/personas/directory.json';
import radarExport from '../fixtures/personas/customer.json';
import { createHarness, type Harness } from '../helpers/harness';

let h: Harness;
beforeEach(async () => { h = await createHarness({ codes: [1, 2] }); });
afterEach(async () => { await h.close(); });

const admin = { role: 'admin', actor: 'test-admin' } as const;
const reviewer = { role: 'reviewer', actor: 'test-reviewer' } as const;

async function pair(extension: ExtensionController, code: string, uid: string, radarProtocol?: 1) {
  const id = h.ids.targets[code];
  await h.db.targetAccount.update({ where: { id }, data: { externalId: uid, connector: EXTENSION_CONNECTOR } });
  const { token } = await extension.issue(id, admin);
  const installationId = randomUUID();
  const call = (message: object) => extension.message('Bearer ' + token, { uid, installationId, ...message });
  const pairing = await call({ action: 'poll', radarProtocol });
  expect(pairing).toMatchObject({ code, state: 'CONNECTED' });
  return call;
}

it('consumes exports from Radar and FB Desk, excludes the retired axes and preserves manual and unknown scores', async () => {
  const controller = new PersonasController(h.db, h.clock);
  await expect(controller.importPeople({ revision: 0, registry: directoryExport }, admin))
    .resolves.toMatchObject({ added: 2, relations: 2, revision: 1 });
  const state = await controller.workspace();
  expect(state.registry.profiles.map(p => p.uid)).toEqual(directoryExport.profiles.map(p => p.uid));
  expect(state.registry.relations).toEqual(directoryExport.relations);
  await expect(controller.importRadar({ reports: [radarExport] }, admin)).resolves.toEqual({ saved: 1, skipped: 0 });
  const id = (await controller.workspace()).radars[0].id;
  const { report } = await controller.radar(id);
  expect(Object.keys(report).sort()).toEqual(['demographic', 'personality', 'postsRead']);
  expect(report.demographic).toHaveLength(6);
  expect(report.personality).toHaveLength(8);
  expect(report.demographic.find(a => a.id === 'age')).toMatchObject({ score: 0, manual: true, originalScore: null });
  expect(report.demographic.find(a => a.id === 'family')).toMatchObject({ score: null, manual: false });
  expect(report.personality.find(a => a.id === 'driven')?.evidence.length).toBeGreaterThan(0);
  const stored = await h.db.customerRadar.findUniqueOrThrow({ where: { id } });
  expect(JSON.stringify(stored.report)).not.toMatch(/legacy_only|buying/);
  const reset = await controller.setRadarScore(id, { group: 'demographic', axisId: 'age', score: null }, admin);
  expect(reset.report.demographic.find(a => a.id === 'age')).toMatchObject({ score: null, manual: false });
});

it('uses paired UIDs, keeps directional wording, snapshots the reviewed inputs and exports the original preview protocol', async () => {
  const controller = new PersonasController(h.db, h.clock);
  const extension = new ExtensionController(h.db, h.clock);
  await controller.importPeople({ revision: 0, registry: directoryExport }, admin);
  await controller.importRadar({ reports: [radarExport] }, admin);
  const radarId = (await controller.workspace()).radars[0].id;
  const input = { from: 'author', to: 'advisor', topic: 'Kiểm tra trên dữ liệu mẫu', radarId };
  await expect(controller.preview(input)).rejects.toThrow('đã ghép Chrome profile');
  await pair(extension, 'B1', directoryExport.profiles[0].uid);
  await pair(extension, 'B2', directoryExport.profiles[1].uid);
  const forward = await controller.preview(input);
  expect(forward).toMatchObject({
    speaker: { code: 'B1', uid: directoryExport.profiles[0].uid },
    listener: { code: 'B2', uid: directoryExport.profiles[1].uid },
    relationship: { role: 'senior_male', self: 'anh', other: 'em' },
    sample: 'Anh chào em.',
  });
  await expect(controller.preview({ ...input, from: 'advisor', to: 'author' })).resolves.toMatchObject({
    speaker: { code: 'B2' }, listener: { code: 'B1' }, relationship: { self: 'em', other: 'anh' },
  });
  await controller.setRadarScore(radarId, { group: 'demographic', axisId: 'age', score: 45 }, admin);
  await expect(controller.approve({ ...input, fingerprint: forward.fingerprint }, reviewer)).rejects.toThrow('Xem trước lại');
  const updated = await controller.preview(input);
  const request = { ...input, fingerprint: updated.fingerprint };
  const approval = await controller.approve(request, reviewer);
  expect(approval.context.radarReport?.demographic.find(a => a.id === 'age')?.score).toBe(45);
  await expect(controller.approve(request, reviewer)).resolves.toMatchObject({ id: approval.id });
  const exported = await controller.exportContext(approval.id);
  expect(exported).toMatchObject({
    schema: 'desk.persona-context/1',
    speaker: { id: 'author', uid: directoryExport.profiles[0].uid },
    target: { id: 'advisor', uid: directoryExport.profiles[1].uid },
    relationship: { from: 'author', to: 'advisor', role: 'senior_male', self: 'anh', other: 'em' },
    longTermContext: directoryExport.profiles[0].memory,
    rules: directoryExport.profiles[0].rules,
    capabilities: { previewOnly: true, canSendComment: false },
  });
  await controller.setRadarScore(radarId, { group: 'demographic', axisId: 'age', score: 52 }, admin);
  expect((await controller.workspace()).approvals[0].context.radarReport?.demographic[0].score).toBe(45);
  expect(await h.db.extensionCommand.count()).toBe(0);
});

it('binds a draft persona only to an already paired UID and rejects a missing or ambiguous reverse relation', async () => {
  const controller = new PersonasController(h.db, h.clock);
  const extension = new ExtensionController(h.db, h.clock);
  const draft = structuredClone(directoryExport);
  draft.profiles[1].uid = '';
  draft.relations.pop();
  await controller.importPeople({ revision: 0, registry: draft }, admin);
  await pair(extension, 'B1', directoryExport.profiles[0].uid);
  const binding = { personaId: 'advisor', revision: 1, targetId: h.ids.targets.B2 };
  await expect(controller.bind(binding, admin)).rejects.toThrow('Đích chưa ghép');
  await pair(extension, 'B2', directoryExport.profiles[1].uid);
  await expect(controller.bind(binding, admin)).resolves.toEqual({ revision: 2 });
  const reverse = { from: 'advisor', to: 'author' };
  await expect(controller.preview(reverse)).rejects.toThrow('theo chiều này');
  await controller.saveRelation({ revision: 2, relation: { ...reverse, role: 'junior_female', self: 'em', other: '' } }, admin);
  await expect(controller.preview(reverse)).rejects.toThrow('cách tự xưng và gọi cụ thể');
});

it('routes Radar to a capable extension, waits while an account is busy, and saves only the matching report', async () => {
  h.setTime('2026-11-25T04:00:00.000Z');
  const controller = new PersonasController(h.db, h.clock);
  const extension = new ExtensionController(h.db, h.clock);
  const request = { url: radarExport.url, publicConfirmed: true };
  const older = await pair(extension, 'B1', directoryExport.profiles[0].uid);
  await expect(controller.scanRadar(request, admin)).rejects.toThrow('extension hỗ trợ Radar');
  const capable = await pair(extension, 'B2', directoryExport.profiles[1].uid, 1);
  await controller.importRadar({ reports: [radarExport] }, admin);
  const task = await controller.scanRadar(request, admin);
  expect(task.targetCode).toBe('B2');
  await expect(controller.scanRadar(request, admin)).resolves.toEqual(task);
  await expect(older({ action: 'poll' })).resolves.toMatchObject({ command: null });
  const lease = await acquireLease(h.db, {
    resource: accountResource(h.ids.targets.B2), holder: 'test-publish', ttlMs: 30_000, now: h.clock.now(),
  });
  expect(lease).not.toBeNull();
  await expect(capable({ action: 'poll', radarProtocol: 1 })).resolves.toMatchObject({ command: null });
  await releaseLease(h.db, lease!, h.clock.now());
  await expect(capable({ action: 'poll', radarProtocol: 1 })).resolves.toMatchObject({
    command: { id: task.id, action: 'radar-scan', url: radarExport.url },
  });
  await expect(capable({ action: 'poll', radarProtocol: 1 })).resolves.toMatchObject({ command: null });
  const report = {
    ...radarExport, manual: {},
    demographic: { ...radarExport.demographic, age: { ...radarExport.demographic.age, score: 58 } },
  };
  const receipt = { action: 'radar-complete', commandId: task.id, report };
  await expect(older(receipt)).rejects.toThrow('không thuộc profile');
  await expect(capable({ ...receipt, report: { ...radarExport, url: 'https://www.facebook.com/profile.php?id=10002000' } }))
    .rejects.toThrow('không khớp trang');
  await expect(capable(receipt)).resolves.toEqual({ ok: true });
  await expect(capable(receipt)).resolves.toEqual({ ok: true });
  const workspace = await controller.workspace();
  expect(workspace.scans[0]).toMatchObject({ targetCode: 'B2', state: 'COMPLETE', radarId: workspace.radars[0].id });
  expect(workspace.radars).toHaveLength(1);
  expect((await controller.radar(workspace.radars[0].id)).report.demographic[0]).toMatchObject({ score: 0, originalScore: 58, manual: true });
});
