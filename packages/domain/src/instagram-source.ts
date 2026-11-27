export const INSTAGRAM_RESEARCH_MEDIA_CONNECTOR = 'instagram-research';
export { INSTAGRAM_ORIGIN, instagramSourceLink } from '@seedingsys/contracts';

export function instagramMediaUrl(raw: string) {
  try {
    const url = new URL(raw);
    if (raw.length > 2048 || url.protocol !== 'https:' || url.username || url.password || url.port
      || !/(?:^|\.)(?:cdninstagram\.com|fbcdn\.net)$/.test(url.hostname)) return null;
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}
