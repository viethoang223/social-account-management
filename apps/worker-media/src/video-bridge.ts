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

export async function prepareFacebookMp4(bytes: Buffer, sizeLimit: number, ffmpeg = ffmpegPath()) {
  const folder = await mkdtemp(join(tmpdir(), 'seedingsys-video-'));
  const input = join(folder, 'original.mp4');
  const output = join(folder, 'facebook.mp4');
  try {
    await writeFile(input, bytes);
    const probe = await run(ffmpeg, ['-hide_banner', '-nostdin', '-i', input], { timeout: 30_000 })
      .then(result => result.stderr, (error: NodeJS.ErrnoException & { stderr?: string }) => {
        if (error.code === 'ENOENT') throw new ConnectorError('PERMANENT', 'Media Bridge cần FFmpeg trên máy xử lý video.');
        return error.stderr ?? '';
      });
    const video = /Stream #\d+:\d+[^\n]*?Video:\s*([\w]+)/.exec(probe)?.[1];
    const audio = /Stream #\d+:\d+[^\n]*?Audio:\s*([\w]+)/.exec(probe)?.[1];
    if (!video) throw new ConnectorError('PERMANENT', 'Media Bridge không tìm thấy luồng video hợp lệ.');

    // FB Desk's upload preparation keeps compatible streams and fixes incompatible codecs before upload.
    const videoArgs = video === 'h264' ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p'];
    const audioArgs = !audio || audio === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k'];
    try {
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', input, '-map', '0:v:0', '-map', '0:a:0?',
        ...videoArgs, ...audioArgs, '-movflags', '+faststart', output], { timeout: 600_000 });
    } catch {
      throw new ConnectorError('PERMANENT', 'Media Bridge không chuẩn bị được MP4 H.264/AAC.');
    }
    const { size } = await stat(output);
    if (!size || size > sizeLimit) throw new ConnectorError('PERMANENT', 'MP4 đã chuẩn bị vượt giới hạn tải lên hoặc không có dữ liệu.');
    return await readFile(output);
  } finally {
    await Promise.allSettled([unlink(input), unlink(output)]);
    await rmdir(folder).catch(() => undefined);
  }
}
