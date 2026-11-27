import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { instagramMediaUrl } from '@seedingsys/domain';

const run = promisify(execFile);

type Format = { url?: string; protocol?: string; ext?: string; width?: number; height?: number; tbr?: number;
  vcodec?: string; has_drm?: boolean; fragments?: unknown[]; filesize?: number; filesize_approx?: number };
type VideoInfo = { extractor_key?: string; id?: string; entries?: unknown[]; formats?: Format[] };

export function higherInstagramFormat(info: VideoInfo, shortcode: string, width: number, height: number, limit: number) {
  if (info.extractor_key !== 'Instagram' || info.id !== shortcode || info.entries || !Array.isArray(info.formats)) return null;
  const choices = info.formats.flatMap(format => {
    const url = instagramMediaUrl(format?.url ?? '');
    const w = format?.width ?? 0, h = format?.height ?? 0;
    if (!url || !Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w < width || h < height || w * h <= width * height
      || format.protocol !== 'https' || format.ext !== 'mp4' || format.vcodec === 'none' || format.has_drm || format.fragments?.length
      || (format.filesize ?? format.filesize_approx ?? 0) > limit) return [];
    return [{ url, pixels: w * h, bitrate: format.tbr ?? 0 }];
  });
  choices.sort((a, b) => b.pixels - a.pixels || b.bitrate - a.bitrate);
  return choices[0]?.url ?? null;
}

export async function findHigherInstagramVideo(shortcode: string, width: number, height: number, limit: number) {
  if (!/^[\w-]{1,32}$/.test(shortcode)) return null;
  const { stdout } = await run(process.env.MEDIA_YTDLP_PATH || 'yt-dlp', [
    '--ignore-config', '--no-cache-dir', '--no-playlist', '--playlist-end', '1', '--no-warnings', '--skip-download',
    '--socket-timeout', '8', '--retries', '0', '--extractor-retries', '0', '--dump-single-json',
    '--', 'https://www.instagram.com/reel/' + shortcode + '/',
  ], { timeout: 25_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  return higherInstagramFormat(JSON.parse(stdout), shortcode, width, height, limit);
}
