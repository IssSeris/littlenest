import test from 'node:test';
import assert from 'node:assert/strict';
import type { NestJournalEntry } from '@workspace/api-client-react';
import { localDateKey, ownMoodHistory, recentMoodRange } from '../src/lib/mood-history';

const entry = (id: string, authorId: string, mood?: NestJournalEntry['mood'], createdAt = '2026-10-03T12:00:00Z', shared = false): NestJournalEntry =>
  ({ id, authorId, mood, createdAt, shared, promptId: 'p1', body: 'A check-in' });

test('parent and child histories exclude other authors, even shared entries, and missing moods', () => {
  const entries = [entry('parent', 'p', 'sad', undefined, true), entry('child', 'c', 'hopeful', undefined, true), entry('blank', 'p'), entry('cleared', 'c', null)];
  assert.deepEqual(ownMoodHistory(entries, 'p').map((row) => row.id), ['parent']);
  assert.deepEqual(ownMoodHistory(entries, 'c').map((row) => row.id), ['child']);
  assert.deepEqual(ownMoodHistory(entries, ''), []);
  assert.deepEqual(ownMoodHistory(entries, 'outsider'), []);
});

test('history reflects mood changes, clearing, deletion and sharing without stale derived data', () => {
  let entries = [entry('own', 'p', 'sad')];
  assert.equal(ownMoodHistory(entries, 'p')[0].mood, 'sad');
  entries = [{ ...entries[0], mood: 'hopeful', shared: true }];
  assert.equal(ownMoodHistory(entries, 'p')[0].mood, 'hopeful');
  assert.deepEqual(ownMoodHistory(entries, 'c'), []);
  entries = [{ ...entries[0], shared: false }];
  assert.equal(ownMoodHistory(entries, 'p').length, 1);
  assert.deepEqual(ownMoodHistory([{ ...entries[0], mood: null }], 'p'), []);
  assert.deepEqual(ownMoodHistory([], 'p'), []);
});

test('newest-first ordering, inclusive local date bounds, open bounds, and invalid ranges', () => {
  const entries = [
    entry('late', 'p', 'sad', new Date(2026, 9, 3, 23, 59).toISOString()),
    entry('old', 'p', 'hopeful', new Date(2026, 9, 2, 12).toISOString()),
    entry('early', 'p', 'calm', new Date(2026, 9, 3, 0, 0).toISOString()),
  ];
  assert.deepEqual(ownMoodHistory(entries, 'p').map((row) => row.id), ['late', 'early', 'old']);
  assert.deepEqual(ownMoodHistory(entries, 'p', '2026-10-03', '2026-10-03').map((row) => row.id), ['late', 'early']);
  assert.equal(ownMoodHistory(entries, 'p', '', '2026-10-02').length, 1);
  assert.equal(ownMoodHistory(entries, 'p', '2026-10-03').length, 2);
  assert.deepEqual(ownMoodHistory(entries, 'p', '2026-10-04', '2026-10-03'), []);
  assert.deepEqual(entries.map((row) => row.id), ['late', 'old', 'early']); // no snapshot mutation
  assert.deepEqual(ownMoodHistory([entry('bad', 'p', 'sad', 'bad-date')], 'p'), []);
});

test('rolling ranges include today and cross month/year boundaries in local time', () => {
  const now = new Date(2026, 0, 3, 15);
  assert.equal(localDateKey(now), '2026-01-03');
  assert.deepEqual(recentMoodRange(7, now), { start: '2025-12-28', end: '2026-01-03' });
  assert.deepEqual(recentMoodRange(30, now), { start: '2025-12-05', end: '2026-01-03' });
});