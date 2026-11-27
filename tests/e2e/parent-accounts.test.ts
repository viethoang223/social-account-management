import { afterEach, beforeEach, expect, it } from 'vitest';
import { ConfigController } from '../../apps/api/src/config.controller';
import { createHarness, type Harness } from '../helpers/harness';

const admin = { role: 'admin', actor: 'test-admin' } as const;
let h: Harness;
beforeEach(async () => { h = await createHarness({ codes: [1, 2] }); });
afterEach(async () => { await h.close(); });

it('assigns the A21–A40 directory in batches and rejects conflicting updates atomically', async () => {
  const config = new ConfigController(h.db, h.clock);
  const save = (...changes: Array<{ slot: number; uid: string | null; previousUid: string | null }>) => config.updateParentAccounts({ changes }, admin);
  const initial = await config.parentAccounts();
  const [sources, targets] = await Promise.all([config.sources(), config.targets()]);
  expect(initial).toEqual(Array.from({ length: 20 }, (_, i) => ({ slot: i + 21, uid: null })));

  const first = { slot: 21, uid: '90000000000000001', previousUid: null };
  const second = { slot: 22, uid: '90000000000000002', previousUid: null };
  await expect(save(first, second)).resolves.toEqual([{ slot: 21, uid: first.uid }, { slot: 22, uid: second.uid }, ...initial.slice(2)]);
  await expect(save({ ...first, uid: '90000000000000003' })).rejects.toMatchObject({ status: 409 });
  await expect(save({ slot: 23, uid: first.uid, previousUid: null }, { slot: 24, uid: '90000000000000004', previousUid: null }))
    .rejects.toMatchObject({ status: 409 });
  await expect(save({ ...second, slot: 41 })).rejects.toMatchObject({ status: 404 });
  await expect(save({ slot: 23, uid: '9-03', previousUid: null })).rejects.toMatchObject({ status: 400 });
  expect((await config.parentAccounts()).slice(2)).toEqual(initial.slice(2));

  await expect(save({ slot: 21, uid: second.uid, previousUid: first.uid }, { slot: 22, uid: first.uid, previousUid: second.uid }))
    .resolves.toEqual([{ slot: 21, uid: second.uid }, { slot: 22, uid: first.uid }, ...initial.slice(2)]);
  await expect(save({ slot: 21, uid: null, previousUid: second.uid })).resolves.toContainEqual({ slot: 21, uid: null });
  await expect(Promise.all([config.sources(), config.targets()])).resolves.toEqual([sources, targets]);
});
