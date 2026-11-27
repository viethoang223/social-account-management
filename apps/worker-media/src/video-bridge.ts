import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ConnectorError } from '@seedingsys/connectors-core';

const run = promisify(execFile);

function ffmpegPath() {
  if (process.env.MEDIA_FFMPEG_PATH) return process.env.MEDIA_FFMPEG_PATH;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const installed = join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe');
    if (existsSync(installed)) return installed;
  }
  return 'ffmpeg';
}

async function probe(ffmpeg: string, file: string) {
  const log = await run(ffmpeg, ['-hide_banner', '-nostdin', '-i', file], { timeout: 30_000 })
    .then(result => result.stderr, (error: NodeJS.ErrnoException & { stderr?: string }) => {
      if (error.code === 'ENOENT') throw new ConnectorError('PERMANENT', 'Media Bridge cần FFmpeg trên máy xử lý video.');
      return error.stderr ?? '';
    });
  const stream = /Stream #\d+:\d+[^\n]*?Video:\s*([\w]+)([^\n]*)/.exec(log);
  if (!stream) throw new ConnectorError('PERMANENT', 'Media Bridge không tìm thấy luồng video hợp lệ.');
  const dimensions = /,\s*(\d{2,5})x(\d{2,5})(?=\s|,|$)/.exec(stream[2]);
  const time = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(log);
  const duration = time ? +time[1] * 3600 + +time[2] * 60 + +time[3] : 0;
  return { codec: stream[1], width: Number(dimensions?.[1] ?? 0), height: Number(dimensions?.[2] ?? 0), duration,
    audio: /Stream #\d+:\d+[^\n]*?Audio:\s*([\w]+)/.exec(log)?.[1] };
}

export async function prepareFacebookMp4(bytes: Buffer, sizeLimit: number, ffmpeg = ffmpegPath(),
  higherVideo?: (width: number, height: number) => Promise<Buffer | null>) {
  const folder = await mkdtemp(join(tmpdir(), 'seedingsys-video-'));
  const input = join(folder, 'original.mp4');
  const higher = join(folder, 'higher.mp4');
  const output = join(folder, 'facebook.mp4');
  try {
    await writeFile(input, bytes);
    const original = await probe(ffmpeg, input);
    const mux = async (file: string, codec: string) => {
      const enhanced = file === higher;
      const videoArgs = codec === 'h264' ? ['-c:v', 'copy']
        : ['-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', enhanced ? '18' : '21', '-pix_fmt', 'yuv420p'];
      const audioArgs = !original.audio || original.audio === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k'];
      try {
        await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', file, ...(enhanced ? ['-i', input] : []),
          '-map', '0:v:0', '-map', enhanced ? '1:a:0?' : '0:a:0?', ...videoArgs, ...audioArgs, '-movflags', '+faststart', output],
        { timeout: 600_000 });
      } catch {
        throw new ConnectorError('PERMANENT', 'Media Bridge không chuẩn bị được MP4 H.264/AAC.');
      }
      const { size } = await stat(output);
      if (!size || size > sizeLimit) throw new ConnectorError('PERMANENT', 'MP4 đã chuẩn bị vượt giới hạn tải lên hoặc không có dữ liệu.');
      return readFile(output);
    };
    if (higherVideo && original.width && original.height && original.duration) {
      try {
        const track = await higherVideo(original.width, original.height);
        if (track?.length && track.length <= sizeLimit) {
          await writeFile(higher, track);
          const hd = await probe(ffmpeg, higher);
          if (hd.width >= original.width && hd.height >= original.height && hd.width * hd.height > original.width * original.height
            && Math.abs(hd.duration - original.duration) <= 0.35
            && Math.abs((hd.width / hd.height) / (original.width / original.height) - 1) < 0.02) return await mux(higher, hd.codec);
        }
      } catch {
        // A missing extractor, expired rendition or oversized encode must not lose a working original.
      }
    }
    return await mux(input, original.codec);
  } finally {
    await Promise.allSettled([unlink(input), unlink(higher), unlink(output)]);
    await rmdir(folder).catch(() => undefined);
  }
}
