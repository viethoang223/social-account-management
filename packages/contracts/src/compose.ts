import type { ContentType } from './content';

export interface ComposeAccount {
  id: string;
  code: string;
  name: string;
  audience: string;
  formats: ContentType[];
  unavailable: string | null;
}

export interface ComposeReceipt {
  publicationId: string;
  targetCode: string;
}

export const LIBRARY_FILTERS = ['all', 'waiting', 'published', 'attention'] as const;
export type LibraryFilter = typeof LIBRARY_FILTERS[number];

export interface LibraryCatalog {
  total: number;
  posts: Array<{
    id: string;
    sourceCode: string;
    sourceName: string;
    written: boolean;
    snippet: string;
    date: string;
    contentType: ContentType;
    accounts: Array<{ code: string; name: string; status: string; publicationId: string | null }>;
  }>;
}
