import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { higherInstagramFormat } from '../../apps/worker-media/src/instagram-video-quality';
import { prepareFacebookMp4 } from '../../apps/worker-media/src/video-bridge';

it('selects a higher complete video track from the exact Reel, excluding protected and oversized renditions', () => {
  const url = 'https://scontent.cdninstagram.com/hd.mp4';
  const hd = { url, width: 1080, height: 1920, protocol: 'https', ext: 'mp4', vcodec: 'vp9' };
  const info = { extractor_key: 'Instagram', id: 'Correct', formats: [hd,
    { ...hd, width: 2160, has_drm: true }, { ...hd, width: 2160, filesize: 10001 },
    { ...hd, width: 2160, url: 'https://example.org/other.mp4' }] };
  expect(higherInstagramFormat(info, 'Correct', 720, 1280, 10000)?.href).toBe(url);
  expect(higherInstagramFormat(info, 'Other', 720, 1280, 10000)).toBeNull();
  expect(higherInstagramFormat({ ...info, entries: [] }, 'Correct', 720, 1280, 10000)).toBeNull();
  expect(higherInstagramFormat(info, 'Correct', 1080, 1920, 10000)).toBeNull();
});

const ffmpeg = process.env.MEDIA_FFMPEG_PATH || 'ffmpeg';
it.skipIf(spawnSync(ffmpeg, ['-version']).status !== 0)('uses native higher-resolution frames with the original audio and falls back on a duration mismatch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-test-'));
  const run = (args: string[]) => execFileSync(ffmpeg, ['-nostdin', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  const low = join(dir, 'low.mp4'), high = join(dir, 'high.mp4'), output = join(dir, 'out.mp4');
  const hash = (file: string, stream: string) => run(['-i', file, '-map', stream, '-c', 'copy', '-f', 'streamhash', '-hash', 'sha256', '-']);
  try {
    run(['-f', 'lavfi', '-i', 'testsrc2=size=90x160:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440',
      '-t', '1', '-c:v', 'libx264', '-c:a', 'aac', low]);
    for (const seconds of ['1', '2']) {
      run(['-f', 'lavfi', '-i', 'testsrc2=size=180x320:rate=10', '-t', seconds, '-c:v', 'libx264', high]);
      const result = await prepareFacebookMp4(readFileSync(low), 5_000_000, ffmpeg, async () => readFileSync(high));
      writeFileSync(output, result);
      expect(hash(output, '0:v:0')).toBe(hash(seconds === '1' ? high : low, '0:v:0'));
      expect(hash(output, '0:a:0')).toBe(hash(low, '0:a:0'));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
