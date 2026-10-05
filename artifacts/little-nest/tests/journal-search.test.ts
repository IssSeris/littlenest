import assert from 'node:assert/strict';
import test from 'node:test';
import type { NestJournalEntry } from '@workspace/api-client-react';
import { searchOwnJournal } from '../src/lib/journal-search';

function entry(id: string, authorId: string, body: string, shared = false, mood: NestJournalEntry['mood'] = null, createdAt = '2026-10-03T12:00:00Z'): NestJournalEntry {
  return { id, authorId, body, shared, mood, createdAt, promptId: 'p1' };
}

test('search includes own private/shared entries without moods, never another author', () => {
  const entries = [
    entry('private', 'parent', 'We went to the park'),
    entry('shared', 'parent', 'The PARK was sunny', true, 'calm'),
    entry('child-shared', 'child', 'park', true),
    entry('child-private', 'child', 'park'),
  ];
  assert.deepEqual(searchOwnJournal(entries, 'parent', '  PaRk  ').map((item) => item.id), ['private', 'shared']);
  assert.deepEqual(searchOwnJournal(entries, 'child', 'park').map((item) => item.id), ['child-shared', 'child-private']);
  assert.deepEqual(searchOwnJournal(entries, 'other-account', 'park'), []);
  assert.deepEqual(searchOwnJournal(entries, '', 'park'), []);
});

test('matches literal phrases and punctuation in the body, not mood or prompt metadata', () => {
  const entries = [entry('one', 'me', 'I loved the park. [really]', false, 'calm')];
  assert.equal(searchOwnJournal(entries, 'me', 'THE PARK').length, 1);
  assert.equal(searchOwnJournal(entries, 'me', '[really]').length, 1);
  assert.deepEqual(searchOwnJournal(entries, 'me', 'calm'), []);
  assert.deepEqual(searchOwnJournal(entries, 'me', 'p1'), []);
  assert.deepEqual(searchOwnJournal(entries, 'me', 'missing'), []);
  assert.deepEqual(searchOwnJournal(entries, 'me', ''), []);
  assert.deepEqual(searchOwnJournal(entries, 'me', ' \n '), []);
  assert.deepEqual(searchOwnJournal([], 'me', 'park'), []);
});

test('orders newest first without mutating the snapshot and reflects edits, removal, and sharing changes', () => {
  const old = entry('old', 'me', 'park', false, null, '2026-10-01T12:00:00Z');
  const recent = entry('recent', 'me', 'park');
  const entries = [old, recent];
  assert.deepEqual(searchOwnJournal(entries, 'me', 'park').map((item) => item.id), ['recent', 'old']);
  assert.deepEqual(entries.map((item) => item.id), ['old', 'recent']);
  assert.deepEqual(searchOwnJournal([{ ...old, body: 'beach' }, recent], 'me', 'park').map((item) => item.id), ['recent']);
  assert.deepEqual(searchOwnJournal([old], 'me', 'park').map((item) => item.id), ['old']);
  assert.equal(searchOwnJournal([{ ...old, shared: true }], 'me', 'park').length, 1);
  assert.equal(searchOwnJournal([{ ...old, shared: true }], 'someone-else', 'park').length, 0);
});