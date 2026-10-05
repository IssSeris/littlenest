import assert from 'node:assert/strict';
import test from 'node:test';
import React, { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import JournalSearch from '../src/components/JournalSearch';
import type { NestJournalEntry } from '@workspace/api-client-react';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
// tsx preserves the app's classic JSX transform; Vite supplies the automatic runtime.
(globalThis as any).React = React;
const entries: NestJournalEntry[] = [
  { id: 'own', authorId: 'me', body: 'A walk in the park', mood: null, shared: false, promptId: 'p1', createdAt: '2026-10-03T12:00:00Z' },
  { id: 'shared', authorId: 'other', body: 'Secret park words', mood: 'calm', shared: true, promptId: 'p1', createdAt: '2026-10-03T13:00:00Z' },
];

test('search UI reports results/empty states, links to entries, clears, and resets between accounts', async () => {
  let view!: ReturnType<typeof create>;
  const render = (authorId: string, snapshot = entries) => createElement(JournalSearch, { key: authorId, authorId, entries: snapshot });
  await act(async () => { view = create(render('me')); });
  const find = (id: string) => view.root.findByProps({ 'data-testid': id });
  const status = () => find('text-journal-search-status').children.join('');
  assert.match(status(), /Type words/);
  await act(async () => { find('input-journal-search').props.onChange({ target: { value: 'PARK' } }); });
  assert.match(status(), /1 matching entry/);
  assert.equal(view.root.findAllByProps({ 'data-testid': 'result-journal-search-shared' }).length, 0);
  const link = find('link-journal-search-own');
  assert.equal(link.props.href, '#journal-entry-own');
  const calls: string[] = [];
  (globalThis as any).document = { getElementById: (id: string) => {
    assert.equal(id, 'journal-entry-own');
    return { focus: () => calls.push('focus'), scrollIntoView: () => calls.push('scroll') };
  } };
  link.props.onClick({ preventDefault: () => calls.push('preventDefault') });
  assert.deepEqual(calls, ['preventDefault', 'focus', 'scroll']);
  await act(async () => { view.update(render('me', [{ ...entries[0], body: 'A beach day' }, entries[1]])); });
  assert.match(status(), /No entries match/);
  await act(async () => { find('button-clear-journal-search').props.onClick(); });
  assert.equal(find('input-journal-search').props.value, '');
  assert.match(status(), /Type words/);
  await act(async () => { find('input-journal-search').props.onChange({ target: { value: 'park' } }); });
  await act(async () => { view.update(render('other')); });
  assert.equal(find('input-journal-search').props.value, '');
  assert.equal(view.root.findAllByProps({ 'data-testid': 'result-journal-search-own' }).length, 0);
  await act(async () => { view.update(render('empty-account')); });
  assert.match(status(), /No journal entries of your own yet/);
  await act(async () => { view.unmount(); });
});