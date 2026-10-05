import { NestJournalMood, type NestJournalEntry } from '@workspace/api-client-react';

export const moodLabel = (mood: string) => mood.charAt(0).toUpperCase() + mood.slice(1);

export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function recentMoodRange(days: number, now = new Date()) {
  const start = new Date(now);
  start.setDate(start.getDate() - days + 1);
  return { start: localDateKey(start), end: localDateKey(now) };
}

// Derive from the live authorized snapshot, never a household aggregate or a separate cache.
export function ownMoodHistory(
  entries: readonly NestJournalEntry[],
  authorId: string,
  start = '',
  end = '',
): NestJournalEntry[] {
  if (!authorId || (start && end && start > end)) return [];
  return entries.filter((entry) => {
    if (entry.authorId !== authorId || !entry.mood || !Object.values(NestJournalMood).includes(entry.mood)) return false;
    const date = new Date(entry.createdAt);
    if (Number.isNaN(date.getTime())) return false;
    const day = localDateKey(date);
    return (!start || day >= start) && (!end || day <= end);
  }).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() || a.id.localeCompare(b.id));
}