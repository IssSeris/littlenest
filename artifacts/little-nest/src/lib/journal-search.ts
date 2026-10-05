import type { NestJournalEntry } from '@workspace/api-client-react';

/** Search only the author's written words, without changing the authorized snapshot. */
export function searchOwnJournal(entries: NestJournalEntry[], authorId: string, query: string): NestJournalEntry[] {
  const text = query.trim().toLowerCase();
  if (!text || !authorId) return [];
  return entries
    .filter((entry) => entry.authorId === authorId && entry.body.toLowerCase().includes(text))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}