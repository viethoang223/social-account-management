import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { AssignmentsController } from '../../apps/api/src/assignments.controller';
import { createHarness, type Harness } from '../helpers/harness';

const operator = { role: 'operator', actor: 'test-operator' } as const;
let h: Harness;
let assignments: AssignmentsController;

beforeEach(async () => {
  h = await createHarness({ codes: [1, 2] });
  assignments = new AssignmentsController(h.db, h.clock);
});
afterEach(() => h.close());

it('stores the chosen source article and distinct B targets without sending a command', async () => {
  const sourceId = h.ids.sources.A1;
  await h.db.source.update({ where: { id: sourceId }, data: { code: 'N1' } });
  const article = await h.db.sourcePost.create({ data: {
    sourceId, externalId: '456', identityConfidence: 'HIGH', contentType: 'TEXT',
    permalink: 'https://m.facebook.com/groups/123/permalink/456/?ref=share', firstSeenAt: h.clock.now(),
  } });
  const targetIds = [h.ids.targets.B2, h.ids.targets.B1, h.ids.targets.B1];
  const payload = { id: randomUUID(), code: 'X3', sourceId, sourcePostId: article.id, targetIds };
  await expect(assignments.create(payload, operator)).resolves.toMatchObject({
    status: 'PENDING', source: { id: sourceId, code: 'N1' }, sourcePostId: article.id,
    targets: [{ code: 'B1' }, { code: 'B2' }], urls: ['https://www.facebook.com/groups/123/posts/456'],
  });
  await expect(assignments.create(payload, operator)).resolves.toMatchObject({ id: payload.id });
  await expect(assignments.workspace()).resolves.toMatchObject({ assignments: [{ id: payload.id }] });
  expect(await h.db.workAssignment.count()).toBe(1);
  expect(await h.db.extensionCommand.count()).toBe(0);
});

it('lets X2 reuse only the selected groups from a completed Y1', async () => {
  const search = await assignments.create({ id: randomUUID(), code: 'Y1', targetIds: [], brief: 'Nhóm nhiếp ảnh' }, operator);
  const input = { id: randomUUID(), code: 'X2', targetIds: [h.ids.targets.B2], fromAssignmentId: search.id,
    urls: ['https://www.facebook.com/groups/123'] };
  await expect(assignments.create(input, operator)).rejects.toThrow('Chọn kết quả Y1 đã hoàn tất');
  await expect(assignments.update(search.id, { status: 'DONE', results: [] }, operator)).rejects.toThrow('ít nhất một nhóm');
  await expect(assignments.update(search.id, { status: 'DONE',
    results: ['https://m.facebook.com/groups/123/?ref=share', 'https://www.facebook.com/groups/345'] }, operator)).resolves
    .toMatchObject({ status: 'DONE', results: ['https://www.facebook.com/groups/123', 'https://www.facebook.com/groups/345'] });
  await expect(assignments.create({ ...input, urls: ['https://www.facebook.com/groups/678'] }, operator)).rejects.toThrow('có trong kết quả Y1');
  const job = await assignments.create(input, operator);
  expect(job).toMatchObject({ fromAssignmentId: search.id, targets: [{ code: 'B2' }], urls: input.urls });
  await expect(assignments.update(job.id, { status: 'CANCELLED' }, operator)).resolves.toMatchObject({ status: 'CANCELLED' });
  await expect(assignments.update(job.id, { status: 'DONE' }, operator)).rejects.toThrow('đã kết thúc');
});
