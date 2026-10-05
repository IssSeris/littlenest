import assert from 'node:assert/strict';
import test from 'node:test';
import React, { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { randomUUID } from 'node:crypto';
import type { NestPasteDraft, NestPasteDraftInput, NestPasteRowInput } from '@workspace/api-client-react';
import type { AppData } from '../src/App';

(globalThis as any).React = React;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const slots = new Map<string, NestPasteDraft>();
const storage = new Map<string, string>();
let writes = 0, sends = 0, lostCheckpoint = false, lostSave = false;
let holdDiscard: (() => Promise<void>) | null = null;
const copy = <T,>(value: T): T => structuredClone(value);
const key = (membership: string, kind: string) => `${membership}:${kind}`;
test.mock.module('@workspace/api-client-react', { namedExports: {
  getNestPasteDraft: async (m: string, k: string) => copy(slots.get(key(m, k)) ?? { revision: null, session: null }),
  putNestPasteDraft: async (m: string, k: string, input: NestPasteDraftInput) => {
    const old = slots.get(key(m, k));
    if ((old?.revision ?? null) !== input.revision) throw Object.assign(new Error('stale'), { status: 409 });
    writes++;
    const value = { revision: randomUUID(), session: copy(input.session) };
    slots.set(key(m, k), value);
    if (input.session === null && holdDiscard) await holdDiscard();
    if (lostCheckpoint && input.session?.uncertainId) { lostCheckpoint = false; throw new Error('lost checkpoint response'); }
    return copy(value);
  },
  saveNestPasteDraftRow: async (m: string, k: string, input: NestPasteRowInput) => {
    const old = slots.get(key(m, k))!;
    if (old.revision !== input.revision) throw Object.assign(new Error('stale'), { status: 409 });
    sends++;
    const s = old.session!;
    const remaining = s.drafts.filter((r) => r.id !== input.rowId);
    const value = { revision: randomUUID(), session: { ...s, drafts: remaining, uncertainId: null, savedCount: s.savedCount + 1, finished: !remaining.length } };
    slots.set(key(m, k), value);
    if (lostSave) { lostSave = false; throw new Error('lost save response'); }
    return copy(value);
  },
} });
const { default: PasteList } = await import('../src/components/PasteList');
const { PasteScope } = await import('../src/hooks/use-paste-session');
(globalThis as any).window = {
  confirm: () => true, localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) },
  setInterval: (fn: () => void, ms: number) => setInterval(fn, ms).unref(), clearInterval,
  addEventListener() {}, removeEventListener() {},
};
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (_k: string, _o: unknown, fn: (lock: object) => unknown) => fn({}) } } });
const data = { members: [{ id: 'parent', name: 'Parent' }, { id: 'child', name: 'Child' }], groceries: [], chores: [] } as unknown as AppData;
async function mount(kind: 'groceries' | 'chores' = 'groceries') {
  let view!: ReturnType<typeof create>, reviews = 0;
  await act(async () => {
    view = create(createElement(PasteScope.Provider, { value: { accountId: 'account', membershipId: 'member' } },
      createElement(PasteList, { kind, data, onSave: async () => { throw new Error('Synced drafts must not use the local saver'); },
        onRefresh: async () => { reviews++; return data; } })));
  });
  const find = (id: string) => view.root.findByProps({ 'data-testid': id });
  const click = (id: string) => act(async () => { await find(id).props.onClick(); });
  const change = (id: string, value: string) => act(async () => { await find(id).props.onChange({ target: { value } }); });
  return { view, find, click, change, reviews: () => reviews, rows: () => view.root.findAllByType('fieldset'), close: () => act(async () => view.unmount()) };
}
const reset = () => { slots.clear(); storage.clear(); writes = 0; sends = 0; lostCheckpoint = false; lostSave = false; holdDiscard = null; };

test('private raw and reviewed drafts resume across devices, preserve removals/duplicates, and discard globally', async () => {
  reset();
  storage.set('little-nest-old-household', 'legacy data');
  let first = await mount();
  assert.equal(writes, 0);
  await first.click('paste-open'); await first.change('paste-input', 'Local only');
  assert.equal(writes, 0); assert.equal(first.find('paste-private-start').props.disabled, true);
  await first.click('paste-cancel');
  await first.click('paste-private-start');
  await first.change('paste-input', 'Milk\nMilk\nRemove me');
  await first.close();
  let second = await mount();
  await second.click('paste-private-resume');
  assert.equal(second.find('paste-input').props.value, 'Milk\nMilk\nRemove me');
  await second.click('paste-review-button');
  const ids = second.rows().map((r) => r.props['data-testid'].slice('paste-row-'.length));
  await second.change(`paste-quantity-${ids[0]}`, '2 cartons');
  await second.click(`paste-remove-${ids[2]}`);
  await second.close();
  first = await mount();
  await first.click('paste-private-resume');
  assert.equal(first.rows().length, 2);
  assert.equal(first.find(`paste-quantity-${ids[0]}`).props.value, '2 cartons');
  await first.click('paste-add');
  assert.equal(sends, 2);
  assert.equal(first.reviews(), 1);
  assert.match(first.find('paste-status').children.join(''), /2 saved, 0 remaining/);
  await first.click('paste-cancel'); await first.close();
  second = await mount();
  assert.equal(second.view.root.findAllByProps({ 'data-testid': 'paste-private-resume' }).length, 0);
  assert.equal(storage.get('little-nest-old-household'), 'legacy data');
  await second.close();
});

test('stale devices cannot overwrite or submit; uncertain resumes require a new saved-list review', async () => {
  reset();
  const first = await mount('chores');
  await first.click('paste-private-start');
  await first.change('paste-input', 'Sweep\nSweep');
  await first.click('paste-review-button');
  const id = first.rows()[0].props['data-testid'].slice('paste-row-'.length);
  await first.change(`paste-assignee-${id}`, 'child');
  await first.change(`paste-cadence-${id}`, 'Weekly');
  const second = await mount('chores');
  await second.click('paste-private-resume');
  assert.equal(second.find(`paste-assignee-${id}`).props.value, 'child');
  assert.equal(second.find(`paste-cadence-${id}`).props.value, 'Weekly');
  await first.change(`paste-title-${id}`, 'Sweep upstairs');
  await second.change(`paste-title-${id}`, 'Stale edit');
  assert.ok(second.find('paste-conflict'));
  await second.click('paste-add'); assert.equal(sends, 0);
  await second.click('paste-load-latest');
  assert.equal(second.find(`paste-title-${id}`).props.value, 'Sweep upstairs');
  lostCheckpoint = true;
  await second.click('paste-add');
  assert.equal(sends, 0);
  await second.click('paste-load-latest');
  assert.equal(second.find('paste-add').props.disabled, true);
  // Actual UI review is deliberately not persisted as retry permission.
  await second.click('paste-refresh');
  await second.close();
  const third = await mount('chores'); await third.click('paste-private-resume');
  assert.equal(third.view.root.findAllByProps({ 'data-testid': 'paste-resolve-retry' }).length, 0);
  await third.click('paste-refresh');
  await third.click('paste-resolve-retry');
  await third.click('paste-add');
  assert.equal(sends, 2);
  await first.close(); await third.close();
});

test('lost synced save response reloads only remaining rows, never the confirmed repeated title', async () => {
  reset();
  const ui = await mount();
  await ui.click('paste-private-start');
  await ui.change('paste-input', 'Milk\nMilk');
  await ui.click('paste-review-button');
  lostSave = true;
  await ui.click('paste-add');
  assert.equal(sends, 1); assert.ok(ui.find('paste-conflict'));
  await ui.click('paste-load-latest');
  assert.equal(ui.rows().length, 1);
  await ui.click('paste-add');
  assert.equal(sends, 2);
  await ui.close();
});

for (const kind of ['groceries', 'chores'] as const) {
  test(`${kind} delayed discard fences edits and stale handlers without resurrecting a private draft`, async () => {
    reset();
    const ui = await mount(kind);
    await ui.click('paste-private-start');
    await ui.change('paste-input', 'Discard this private text');
    const staleEdit = ui.find('paste-input').props.onChange;
    let release!: () => void, started!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const arrived = new Promise<void>((resolve) => { started = resolve; });
    holdDiscard = async () => { started(); await held; };
    let cancel!: Promise<void>;
    await act(async () => {
      cancel = ui.find('paste-cancel').props.onClick();
      await arrived;
    });
    const writesAtDiscard = writes;
    assert.equal(ui.find('paste-input').props.disabled, true);
    // Bypass disabled input to also test a handler captured before discard.
    await act(async () => { await staleEdit({ target: { value: 'Must not return' } }); });
    assert.equal(writes, writesAtDiscard);
    assert.equal(ui.find('paste-input').props.value, 'Discard this private text');
    assert.equal(slots.get(key('member', kind))!.session, null);
    await act(async () => { release(); await cancel; });
    // A delayed handler from the closed panel must still be fenced.
    await act(async () => { await staleEdit({ target: { value: 'Still must not return' } }); });
    assert.equal(writes, writesAtDiscard);
    assert.equal(slots.get(key('member', kind))!.session, null);
    await ui.close();
    const otherDevice = await mount(kind);
    assert.equal(otherDevice.view.root.findAllByProps({ 'data-testid': 'paste-private-resume' }).length, 0);
    assert.ok(otherDevice.find('paste-private-start'));
    await otherDevice.close();
  });
}