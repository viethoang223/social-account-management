export const EXTENSION_CONNECTOR = 'fb-extension';
export const EXTENSION_VERSION = '1.0.0';
export const EXTENSION_FRESH_MS = 75_000;

export interface ExtensionCommentContext {
  replayId: string;
  sendVersion: number;
  postUrl: string;
  parentId?: string;
  composed?: true;
  knownCommentIds?: string[];
}
