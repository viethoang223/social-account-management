import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ComposeController } from '../../apps/api/src/compose.controller';
import { LibraryController } from '../../apps/api/src/library.controller';
import { createHarness, type Harness } from '../helpers/harness';

const operator = { role: 'operator', actor: 'test-operator' } as const;
let h: Harness;
let compose: ComposeController;
let library: LibraryController;

beforeEach(async () => {
  h = await createHarness({ codes: [1, 2] });
  compose = new ComposeController(h.db, h.clock, h.browser.store);
  library = new LibraryController(h.db, h.clock);
});
afterEach(() => h.close());

it('publishes the exact composed text once to the selected B and surfaces its result in the library', async () => {
  const request = { id: randomUUID(), targetId: h.ids.targets.B1, text: 'Bài viết từ màn Đăng bài', audience: 'ONLY_ME' };
  const receipt = await compose.publish(request, undefined, operator);
  expect(receipt.targetCode).toBe('B1');
  await expect(compose.publish(request, undefined, operator)).resolves.toEqual(receipt);
  await expect(compose.publish({ ...request, text: 'Bài đã thay đổi' }, undefined, operator)).rejects.toMatchObject({ status: 409 });
  await expect(library.catalog({ filter: 'waiting' })).resolves.toMatchObject({ total: 1, posts: [
    { snippet: request.text, written: true, accounts: [{ code: 'B1', status: 'QUEUED', publicationId: receipt.publicationId }] },
  ] });
  await h.drain();
  const timeline = h.platform.timeline('fb-B1');
  expect(timeline.map(post => post.caption)).toEqual([request.text]);
  expect(h.platform.timeline('fb-B2')).toHaveLength(0);
  await expect(library.catalog({ filter: 'published', target: 'B1', q: 'từ màn' })).resolves.toMatchObject({ total: 1, posts: [
    { accounts: [{ code: 'B1', status: 'PUBLISHED_VERIFIED', publicationId: receipt.publicationId }] },
  ] });
  await expect(library.catalog({ filter: 'published', target: 'B2' })).resolves.toMatchObject({ total: 0, posts: [] });
});

it('rolls back blocked submissions and queues a supported attachment in its original order', async () => {
  const request = { id: randomUUID(), targetId: h.ids.targets.B1, text: 'Bài kèm ảnh', audience: 'ONLY_ME' };
  await expect(compose.publish({ ...request, audience: 'PUBLIC' }, undefined, operator)).rejects.toThrow('Đối tượng xem vừa thay đổi');
  expect(await h.db.sourcePost.count()).toBe(0);
  await h.db.targetAccount.update({ where: { id: h.ids.targets.B1 }, data: { enabled: false } });
  await expect(compose.publish(request, undefined, operator)).rejects.toThrow('Tài khoản đích đang tắt');
  expect(await h.db.contentVariant.count()).toBe(0);
  await h.db.targetAccount.update({ where: { id: h.ids.targets.B1 }, data: { enabled: true } });
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 7)]);
  const receipt = await compose.publish(request, [{ buffer: jpg }], operator);
  const publication = await h.db.publication.findUniqueOrThrow({ where: { id: receipt.publicationId }, include: { variant: true } });
  expect(publication.contentType).toBe('SINGLE_PHOTO');
  expect(publication.variant.snapshot).toMatchObject({ caption: request.text, media: [{ position: 0, mime: 'image/jpeg' }] });
});
