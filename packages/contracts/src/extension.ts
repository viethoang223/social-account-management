export const EXTENSION_CONNECTOR = 'fb-extension';
export const EXTENSION_VERSION = '1.0.0';
export const EXTENSION_FRESH_MS = 75_000;
export const EXTENSION_PUBLISH_AUDIENCES = ['ONLY_ME', 'PUBLIC'] as const;
export const EXTENSION_MEDIA_FORMATS = ['SINGLE_PHOTO', 'REEL', 'VIDEO', 'MULTI_PHOTO', 'MEDIA_ALBUM'] as const;
export const EXTENSION_MEDIA_CHUNK = 512 * 1024;
export const EXTENSION_MEDIA_LIMIT = 120 * 1024 * 1024;
export const EXTENSION_MEDIA_FILE_LIMIT = 20;
export const EXTENSION_IMAGE_MIME = /^image\/(?:jpeg|png|webp|gif)$/;

export function isExtensionMediaFormat(value: unknown): value is typeof EXTENSION_MEDIA_FORMATS[number] {
  return EXTENSION_MEDIA_FORMATS.some(format => format === value);
}

export function extensionMediaProtocol(format: typeof EXTENSION_MEDIA_FORMATS[number]): 1 | 2 {
  return format === 'REEL' || format === 'SINGLE_PHOTO' ? 1 : 2;
}

export function validExtensionMedia(format: typeof EXTENSION_MEDIA_FORMATS[number], files: readonly { mime: string }[]) {
  const photos = files.filter(file => EXTENSION_IMAGE_MIME.test(file.mime)).length;
  const videos = files.filter(file => file.mime === 'video/mp4').length;
  if (photos + videos !== files.length) return false;
  if (format === 'REEL' || format === 'VIDEO') return files.length === 1 && videos === 1;
  if (format === 'SINGLE_PHOTO') return files.length === 1 && photos === 1;
  if (files.length < 2 || files.length > EXTENSION_MEDIA_FILE_LIMIT) return false;
  return format === 'MULTI_PHOTO' ? videos === 0 : videos > 0;
}
export type ExtensionPublishAudience = (typeof EXTENSION_PUBLISH_AUDIENCES)[number];

export function isExtensionPublishAudience(value: unknown): value is ExtensionPublishAudience {
  return EXTENSION_PUBLISH_AUDIENCES.some(audience => audience === value);
}

export interface ExtensionCommentContext {
  replayId: string;
  sendVersion: number;
  postUrl: string;
  parentId?: string;
  composed?: true;
  knownCommentIds?: string[];
}
