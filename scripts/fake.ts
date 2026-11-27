/**
 * Local fake platform helper (APP_ENV=local only).
 *   pnpm fake post N1 "Nội dung bài"            → text post
 *   pnpm fake post N2 "Album" --photos 3         → multi-photo
 *   pnpm fake post N4 "Video" --video            → video
 *   pnpm fake timeline fb-B1                     → what was published on B1
 *   pnpm fake session fb-B1 CHECKPOINT|OK        → simulate a checkpoint
 */
import { resolve } from 'node:path';
import { canonicalSourceCode, legacySourceCode } from '@seedingsys/contracts';
import { FakePlatform } from '@seedingsys/connectors-fake';

const file = resolve(process.env.FAKE_PLATFORM_FILE ?? '.data/fake-platform.json');
const p = new FakePlatform({ file });
const [cmd, a, b, ...rest] = process.argv.slice(2);

if (cmd === 'post') {
  const code = canonicalSourceCode(a);
  const ref = p.view(state => [code, legacySourceCode(code)].find(key => Object.hasOwn(state.sources, key))) ?? a;
  const photos = rest.includes('--photos') ? Number(rest[rest.indexOf('--photos') + 1]) : 0;
  const video = rest.includes('--video');
  const id = `${a}-${Date.now()}`;
  const media = video
    ? [{ kind: 'video' as const, ref: `${id}-video-1` }]
    : Array.from({ length: photos }, (_, i) => ({ kind: 'image' as const, ref: `${id}-img-${i + 1}` }));
  const contentType = video ? 'VIDEO' : photos > 1 ? 'MULTI_PHOTO' : photos === 1 ? 'SINGLE_PHOTO' : 'TEXT';
  const post = p.addSourcePost(ref, { id, text: b ?? 'Bài thử nghiệm', contentType, media });
  console.log(`added ${contentType} ${post.id} to ${code}`);
} else if (cmd === 'timeline') {
  console.log(JSON.stringify(p.timeline(a), null, 2));
} else if (cmd === 'session') {
  p.setSession(a, b as 'OK' | 'LOGGED_OUT' | 'CHECKPOINT');
  console.log(`${a} session = ${b}`);
} else {
  console.log('usage: fake post <N#> "<text>" [--photos N|--video] | fake timeline <fb-B#> | fake session <fb-B#> OK|CHECKPOINT|LOGGED_OUT');
}
