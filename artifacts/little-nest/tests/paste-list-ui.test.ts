import assert from 'node:assert/strict';
import test from 'node:test';
import React, { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import PasteList from '../src/components/PasteList';
import { localToday, type ListDraft, type ListKind, type ListSaveResult } from '../src/lib/paste-list';
import type { AppData } from '../src/App';
import { PasteScope } from '../src/hooks/use-paste-session';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).React = React;
let confirmDiscard = true;
const storage = new Map<string, string>();
const listeners = new Map<string, Set<(event: any) => void>>();
const heldLocks = new Set<string>();
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: {
  request: async (name: string, _options: unknown, callback: (lock: unknown) => unknown) => {
    if (heldLocks.has(name)) return callback(null);
    heldLocks.add(name);
    try { return await callback({ name }); } finally { heldLocks.delete(name); }
  },
} } });
(globalThis as any).window = { confirm: () => confirmDiscard,
  setInterval: (fn: () => void, ms: number) => setInterval(fn, ms).unref(), clearInterval,
  localStorage: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
  removeItem: (key: string) => { storage.delete(key); },
}, addEventListener: (name: string, listener: (event: any) => void) => {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name)!.add(listener);
}, removeEventListener: (name: string, listener: (event: any) => void) => listeners.get(name)?.delete(listener) };
const publish = () => act(async () => { for (const listener of listeners.get('storage') ?? []) listener({ key: null }); });
const data = {
  members: [{ id: 'parent', name: 'Parent', linked: true, role: 'parent' }, { id: 'child', name: 'Child', linked: true, role: 'child' }],
  groceries: [{ id: 'existing', title: 'Already here', quantity: '1', done: true }],
  chores: [],
} as unknown as AppData;

async function mount(kind: ListKind = 'groceries', onSave = async (_kind: ListKind, _row: ListDraft): Promise<ListSaveResult> => ({ status: 'saved' }), onRefresh = async (): Promise<AppData | null> => data, scope: { accountId: string; membershipId: string } | null = null) {
  let view!: ReturnType<typeof create>;
  await act(async () => { view = create(createElement(PasteScope.Provider, { value: scope }, createElement(PasteList, { kind, data, onSave, onRefresh }))); });
  const find = (id: string) => view.root.findByProps({ 'data-testid': id });
  const click = async (id: string) => act(async () => { await find(id).props.onClick(); });
  const change = async (id: string, value: string) => act(async () => { await find(id).props.onChange({ target: { value } }); });
  const rows = () => view.root.findAllByType('fieldset');
  const status = () => find('paste-status').children.join('');
  const openReview = async (input: string) => {
    await click('paste-open'); await change('paste-input', input); await click('paste-review-button');
  };
  return { view, find, click, change, rows, status, openReview, close: () => act(async () => view.unmount()) };
}

const scope = { accountId: 'account-one', membershipId: 'household-one-membership' };
test('raw text survives remount; accounts, households and list kinds have isolated resume/discard actions', async () => {
  storage.clear();
  storage.set('little-nest-old-data', 'legacy household records');
  let ui = await mount('groceries', undefined, undefined, scope);
  await ui.click('paste-open');
  await ui.change('paste-input', 'Milk\nMilk');
  await ui.close();
  for (const other of [{ accountId: 'account-two', membershipId: scope.membershipId }, { ...scope, membershipId: 'other-household' }]) {
    ui = await mount('groceries', undefined, undefined, other);
    assert.ok(ui.find('paste-open'));
    await ui.close();
  }
  ui = await mount('chores', undefined, undefined, scope);
  assert.ok(ui.find('paste-open'));
  await ui.close();
  ui = await mount('groceries', undefined, undefined, scope);
  await ui.click('paste-resume');
  assert.equal(ui.find('paste-input').props.value, 'Milk\nMilk');
  await ui.click('paste-review-button');
  assert.equal(ui.rows().length, 2); // repeated titles are intentional
  await ui.close();
  ui = await mount('groceries', undefined, undefined, scope);
  confirmDiscard = false;
  await ui.click('paste-discard');
  assert.ok(ui.find('paste-resume'));
  confirmDiscard = true;
  await ui.click('paste-discard');
  assert.ok(ui.find('paste-open'));
  await ui.close();
  ui = await mount('groceries', undefined, undefined, scope);
  assert.ok(ui.find('paste-open'));
  assert.equal(storage.get('little-nest-old-data'), 'legacy household records');
  await ui.close();
});

for (const kind of ['groceries', 'chores'] as const) {
  test(`${kind} reviewed edits and removed/confirmed rows survive reload; completion clears recovery`, async () => {
    storage.clear();
    let calls = 0;
    let ui = await mount(kind, async () => ++calls === 1 ? { status: 'saved' } : { status: 'blocked' }, undefined, scope);
    await ui.openReview('Confirmed\nEdited\nRemoved');
    const ids = ui.rows().map(rowId);
    await ui.change(`paste-title-${ids[1]}`, 'Kept edit');
    if (kind === 'groceries') await ui.change(`paste-quantity-${ids[1]}`, '3 bags');
    else {
      await ui.change(`paste-assignee-${ids[1]}`, 'child');
      await ui.change(`paste-cadence-${ids[1]}`, 'Weekly');
      await ui.change(`paste-date-${ids[1]}`, '2026-12-01');
    }
    await ui.click(`paste-remove-${ids[2]}`);
    await ui.click('paste-add');
    await ui.close();
    ui = await mount(kind, undefined, undefined, scope);
    await ui.click('paste-resume');
    assert.equal(ui.rows().length, 1);
    assert.equal(ui.find(`paste-title-${ids[1]}`).props.value, 'Kept edit');
    if (kind === 'groceries') assert.equal(ui.find(`paste-quantity-${ids[1]}`).props.value, '3 bags');
    else {
      assert.equal(ui.find(`paste-assignee-${ids[1]}`).props.value, 'child');
      assert.equal(ui.find(`paste-cadence-${ids[1]}`).props.value, 'Weekly');
      assert.equal(ui.find(`paste-date-${ids[1]}`).props.value, '2026-12-01');
    }
    assert.match(ui.status(), /1 saved, 1 remaining/);
    await ui.click('paste-add');
    await ui.close();
    ui = await mount(kind, undefined, undefined, scope);
    assert.ok(ui.find('paste-open'));
    await ui.close();
  });
}

test('a previously checked uncertain draft requires a NEW saved-list review after resuming', async () => {
  storage.clear();
  let ui = await mount('groceries', async () => ({ status: 'uncertain' }), undefined, scope);
  await ui.openReview('Maybe saved\nNot sent');
  await ui.click('paste-add');
  await ui.click('paste-refresh');
  assert.ok(ui.find('paste-resolve-retry'));
  await ui.close();
  let writes = 0;
  let reads = 0;
  ui = await mount('groceries', async () => { writes++; return { status: 'saved' }; }, async () => ++reads === 1 ? null : data, scope);
  await ui.click('paste-resume');
  assert.equal(ui.find('paste-add').props.disabled, true);
  assert.equal(ui.view.root.findAllByProps({ 'data-testid': 'paste-resolve-retry' }).length, 0);
  await ui.find('paste-add').props.onClick();
  assert.equal(writes, 0);
  await ui.click('paste-refresh');
  assert.ok(ui.find('paste-refresh-error'));
  assert.equal(ui.find('paste-add').props.disabled, true);
  await ui.click('paste-refresh');
  await ui.click('paste-resolve-saved');
  await ui.close();
  ui = await mount('groceries', undefined, undefined, scope);
  await ui.click('paste-resume');
  assert.equal(ui.rows().length, 1);
  assert.match(ui.status(), /1 saved, 1 remaining/);
  await ui.close();
});

for (const outcome of ['saved', 'uncertain'] as const) {
  test(`navigation during a save persists ${outcome} result and does not send the remaining queue`, async () => {
    storage.clear();
    let resolve!: (result: ListSaveResult) => void;
    let writes = 0;
    let ui = await mount('groceries', async () => { writes++; return new Promise((r) => { resolve = r; }); }, undefined, scope);
    await ui.openReview('In flight\nNot sent');
    let run!: Promise<void>;
    await act(async () => { run = ui.find('paste-add').props.onClick(); });
    const checkpoint = JSON.parse([...storage.values()][0]).session;
    assert.equal(checkpoint.uncertainId, checkpoint.drafts[0].id);
    await ui.close();
    await act(async () => { resolve({ status: outcome }); await run; });
    assert.equal(writes, 1);
    ui = await mount('groceries', undefined, undefined, scope);
    await ui.click('paste-resume');
    assert.equal(ui.rows().length, outcome === 'saved' ? 1 : 2);
    assert.equal(ui.find('paste-add').props.disabled, outcome === 'uncertain');
    await ui.close();
  });
}

test('unavailable storage is visible and prevents sending without an uncertain-save checkpoint', async () => {
  storage.clear();
  const original = window.localStorage.setItem;
  window.localStorage.setItem = () => { throw new Error('Quota exceeded'); };
  let writes = 0;
  const ui = await mount('groceries', async () => { writes++; return { status: 'saved' }; }, undefined, scope);
  try {
    await ui.openReview('Milk');
    assert.ok(ui.find('paste-storage-error'));
    await ui.click('paste-add');
    assert.equal(writes, 0);
    assert.match(ui.status(), /Nothing was sent/);
  } finally { window.localStorage.setItem = original; await ui.close(); }
});
const rowId = (field: ReturnType<typeof create>['root']) => String(field.props['data-testid']).replace('paste-row-', '');

test('stale raw edits cannot overwrite newer text even before a storage event; latest loading preserves repeated lines', async () => {
  storage.clear();
  const a = await mount('groceries', undefined, undefined, scope);
  const b = await mount('groceries', undefined, undefined, scope);
  await a.click('paste-open'); await b.click('paste-open');
  await a.change('paste-input', 'Milk\nMilk');
  const latest = [...storage.values()][0];
  await b.change('paste-input', 'Stale overwrite');
  assert.equal([...storage.values()][0], latest);
  assert.ok(b.find('paste-conflict'));
  assert.equal(b.find('paste-input').props.disabled, true);
  await b.click('paste-load-latest');
  assert.equal(b.find('paste-input').props.value, 'Milk\nMilk');
  await b.click('paste-review-button');
  assert.equal(b.rows().length, 2);
  await publish();
  assert.ok(a.find('paste-conflict'));
  await a.click('paste-load-latest');
  assert.equal(a.rows().length, 2);
  await a.close(); await b.close();
});

test('rapid local edits are queued without self-conflicts and completion retains only a content-free revision marker', async () => {
  storage.clear();
  const ui = await mount('groceries', undefined, undefined, scope);
  await ui.click('paste-open');
  await act(async () => {
    const input = ui.find('paste-input');
    const first = input.props.onChange({ target: { value: 'M' } });
    const second = input.props.onChange({ target: { value: 'Milk\nMilk' } });
    await Promise.all([first, second]);
  });
  assert.equal(ui.find('paste-input').props.value, 'Milk\nMilk');
  assert.equal(ui.view.root.findAllByProps({ 'data-testid': 'paste-conflict' }).length, 0);
  assert.equal(JSON.parse([...storage.values()][0]).session.text, 'Milk\nMilk');
  await ui.click('paste-review-button');
  const id = rowId(ui.rows()[0]);
  await act(async () => {
    const title = ui.find(`paste-title-${id}`).props.onChange({ target: { value: 'Oat milk' } });
    const quantity = ui.find(`paste-quantity-${id}`).props.onChange({ target: { value: '2 cartons' } });
    await Promise.all([title, quantity]);
  });
  const row = JSON.parse([...storage.values()][0]).session.drafts[0];
  assert.equal(row.title, 'Oat milk');
  assert.equal(row.quantity, '2 cartons');
  await ui.click('paste-add');
  const tombstone = JSON.parse([...storage.values()][0]);
  assert.equal(tombstone.session.text, '');
  assert.deepEqual(tombstone.session.drafts, []);
  assert.ok(tombstone.revision);
  assert.match(ui.status(), /2 saved, 0 remaining/);
  await ui.close();
});

for (const action of ['edit', 'remove', 'discard', 'save'] as const) {
  test(`stale ${action} cannot change or submit a newer reviewed queue`, async () => {
    storage.clear();
    let writes = 0;
    const save = async (): Promise<ListSaveResult> => { writes++; return { status: 'saved' }; };
    const a = await mount('groceries', save, undefined, scope);
    await a.openReview('Milk\nMilk');
    const b = await mount('groceries', save, undefined, scope);
    await b.click('paste-resume');
    const id = rowId(a.rows()[0]);
    await a.change(`paste-quantity-${id}`, 'Newer quantity');
    const latest = [...storage.values()][0];
    if (action === 'edit') await b.change(`paste-title-${id}`, 'Old edit');
    if (action === 'remove') await b.click(`paste-remove-${id}`);
    if (action === 'discard') await b.click('paste-cancel');
    if (action === 'save') await b.click('paste-add');
    assert.equal(writes, 0);
    assert.equal([...storage.values()][0], latest);
    assert.ok(b.find('paste-conflict'));
    await b.click('paste-load-latest');
    assert.equal(b.find(`paste-quantity-${id}`).props.value, 'Newer quantity');
    assert.equal(b.rows().length, 2);
    await a.close(); await b.close();
  });
}

test('discard notifies another tab and an empty tombstone prevents stale draft resurrection', async () => {
  storage.clear();
  const emptyTab = await mount('groceries', undefined, undefined, scope);
  const a = await mount('groceries', undefined, undefined, scope);
  await emptyTab.click('paste-open');
  await a.openReview('Discard me');
  const b = await mount('groceries', undefined, undefined, scope);
  await b.click('paste-resume');
  await a.click('paste-cancel');
  const tombstone = [...storage.values()][0];
  await emptyTab.change('paste-input', 'Resurrect');
  assert.equal([...storage.values()][0], tombstone);
  assert.ok(emptyTab.find('paste-conflict'));
  await publish();
  assert.ok(b.find('paste-conflict'));
  await b.click('paste-load-latest');
  assert.equal(b.rows().length, 0);
  assert.equal(b.find('paste-input').props.value, '');
  await a.close(); await b.close(); await emptyTab.close();
});

for (const outcome of ['saved', 'uncertain', 'blocked'] as const) {
  test(`an active ${outcome} save locks other tabs, including tabs opened after its checkpoint`, async () => {
    storage.clear();
    let resolve!: (result: ListSaveResult) => void;
    const sent: string[] = [];
    const a = await mount('groceries', async (_kind, row) => {
      sent.push(row.title);
      if (sent.length === 1) return new Promise((r) => { resolve = r; });
      return { status: 'saved' };
    }, undefined, scope);
    await a.openReview('Milk\nMilk');
    const b = await mount('groceries', async () => { assert.fail('second tab must not send'); }, undefined, scope);
    await b.click('paste-resume');
    let run!: Promise<void>;
    await act(async () => { run = a.find('paste-add').props.onClick(); });
    await b.click('paste-add'); // lock check, before its storage event arrives
    assert.ok(b.find('paste-conflict'));
    const duringSave = [...storage.values()][0];
    await b.click('paste-load-latest');
    assert.equal([...storage.values()][0], duringSave);
    assert.ok(b.find('paste-conflict'));
    const c = await mount('groceries', undefined, undefined, scope);
    await c.click('paste-resume');
    assert.equal(c.find('paste-add').props.disabled, true);
    // A list refresh cannot authorize a retry while another tab still owns the save.
    await c.click('paste-refresh');
    await c.click('paste-resolve-retry');
    assert.ok(c.find('paste-conflict'));
    assert.equal([...storage.values()][0], duringSave);
    await c.click('paste-cancel');
    assert.equal([...storage.values()][0], duringSave);
    await act(async () => { resolve({ status: outcome }); await run; });
    assert.deepEqual(sent, outcome === 'saved' ? ['Milk', 'Milk'] : ['Milk']);
    await publish();
    await b.click('paste-load-latest');
    assert.equal(b.rows().length, outcome === 'saved' ? 0 : 2);
    if (outcome === 'uncertain') {
      assert.equal(b.find('paste-add').props.disabled, true);
      assert.equal(b.view.root.findAllByProps({ 'data-testid': 'paste-resolve-retry' }).length, 0);
    }
    if (outcome === 'blocked') assert.equal(b.find('paste-add').props.disabled, false);
    await a.close(); await b.close(); await c.close();
    assert.equal(heldLocks.size, 0);
  });
}

test('saved-list review is invalidated by a cross-tab decision and must be refreshed again after loading latest', async () => {
  storage.clear();
  const a = await mount('groceries', async () => ({ status: 'uncertain' }), undefined, scope);
  await a.openReview('Milk\nMilk');
  await a.click('paste-add');
  const b = await mount('groceries', undefined, undefined, scope);
  await b.click('paste-resume');
  await a.click('paste-refresh'); await b.click('paste-refresh');
  await a.click('paste-resolve-retry');
  await a.click('paste-add'); // another uncertain write
  await publish();
  assert.ok(b.find('paste-conflict'));
  assert.equal(b.view.root.findAllByProps({ 'data-testid': 'paste-resolve-retry' }).length, 0);
  await b.click('paste-load-latest');
  assert.equal(b.find('paste-add').props.disabled, true);
  assert.equal(b.view.root.findAllByProps({ 'data-testid': 'paste-resolve-retry' }).length, 0);
  await b.click('paste-refresh');
  await b.click('paste-resolve-saved');
  assert.equal(b.rows().length, 1); // identical titles are independent IDs
  await a.close(); await b.close();
});

test('an in-flight saved-list refresh cannot authorize decisions after another tab changes the draft', async () => {
  storage.clear();
  let resolve!: (value: AppData) => void;
  const a = await mount('groceries', async () => ({ status: 'uncertain' }), undefined, scope);
  await a.openReview('Milk\nMilk'); await a.click('paste-add');
  const b = await mount('groceries', undefined, () => new Promise((r) => { resolve = r; }), scope);
  await b.click('paste-resume');
  let run!: Promise<void>;
  await act(async () => { run = b.find('paste-refresh').props.onClick(); });
  await a.click('paste-refresh'); await a.click('paste-resolve-saved');
  await publish();
  await act(async () => { resolve(data); await run; });
  await b.click('paste-load-latest');
  assert.equal(b.view.root.findAllByProps({ 'data-testid': 'paste-resolve-retry' }).length, 0);
  assert.equal(b.rows().length, 1);
  await a.close(); await b.close();
});

test('cross-tab events and locks remain isolated by account, membership and list kind', async () => {
  storage.clear();
  let resolve!: (result: ListSaveResult) => void;
  const a = await mount('groceries', () => new Promise((r) => { resolve = r; }), undefined, scope);
  await a.openReview('In flight');
  let run!: Promise<void>;
  await act(async () => { run = a.find('paste-add').props.onClick(); });
  for (const [kind, other] of [
    ['chores', scope],
    ['groceries', { ...scope, accountId: 'other-account' }],
    ['groceries', { ...scope, membershipId: 'other-membership' }],
  ] as const) {
    let writes = 0;
    const b = await mount(kind, async () => { writes++; return { status: 'saved' }; }, undefined, other);
    await publish();
    assert.equal(b.view.root.findAllByProps({ 'data-testid': 'paste-conflict' }).length, 0);
    await b.openReview('Independent');
    await b.click('paste-add');
    assert.equal(writes, 1);
    await b.close();
  }
  await act(async () => { resolve({ status: 'saved' }); await run; });
  await a.close();
});

test('browsers without atomic coordination fail visibly instead of blindly saving a recovered draft', async () => {
  storage.clear();
  const a = await mount('groceries', undefined, undefined, scope);
  await a.openReview('Milk');
  await a.close();
  const locks = navigator.locks;
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
  let writes = 0;
  const b = await mount('groceries', async () => { writes++; return { status: 'saved' }; }, undefined, scope);
  try {
    await b.click('paste-resume'); await b.click('paste-add');
    assert.equal(writes, 0);
    assert.match(b.find('paste-storage-error').children.join(''), /Web Locks/);
  } finally {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
    await b.close();
  }
});

test('lock API rejection is visible and prevents sending; corrupt browser drafts can still be explicitly discarded', async () => {
  storage.clear();
  const a = await mount('groceries', undefined, undefined, scope);
  await a.openReview('Milk');
  await a.close();
  const request = navigator.locks.request;
  navigator.locks.request = async () => { throw new Error('Access denied'); };
  let writes = 0;
  const b = await mount('groceries', async () => { writes++; return { status: 'saved' }; }, undefined, scope);
  try {
    await b.click('paste-resume'); await b.click('paste-add');
    assert.equal(writes, 0);
    assert.match(b.find('paste-storage-error').children.join(''), /could not coordinate/);
  } finally { navigator.locks.request = request; await b.close(); }
  const key = [...storage.keys()][0];
  storage.set(key, 'corrupt JSON');
  const c = await mount('groceries', undefined, undefined, scope);
  await c.click('paste-discard');
  assert.ok(c.find('paste-open'));
  assert.equal(JSON.parse(storage.get(key)!).session.text, '');
  await c.close();
});

for (const kind of ['groceries', 'chores'] as const) {
  test(`${kind} review edits/removes rows and explicitly adds independent drafts with expected defaults`, async () => {
    const sent: ListDraft[] = [];
    const ui = await mount(kind, async (k, row) => { assert.equal(k, kind); sent.push(row); return { status: 'saved' }; });
    await ui.openReview('- Milk, oat\n[x] Dishes\nMilk, oat');
    assert.equal(sent.length, 0);
    const ids = ui.rows().map(rowId);
    await ui.change(`paste-title-${ids[0]}`, 'Edited item');
    if (kind === 'groceries') await ui.change(`paste-quantity-${ids[0]}`, '2 cartons');
    else {
      assert.equal(ui.find(`paste-cadence-${ids[0]}`).props.value, 'Once');
      assert.equal(ui.find(`paste-date-${ids[0]}`).props.value, localToday());
      await ui.change(`paste-assignee-${ids[0]}`, 'child');
      await ui.change(`paste-cadence-${ids[0]}`, 'Daily');
      await ui.change(`paste-date-${ids[0]}`, '2026-11-03');
    }
    await ui.click(`paste-remove-${ids[1]}`);
    await ui.click('paste-add');
    assert.deepEqual(sent.map((row) => row.title), ['Edited item', 'Milk, oat']);
    assert.equal(kind === 'groceries' ? sent[0].quantity : sent[0].assignedTo, kind === 'groceries' ? '2 cartons' : 'child');
    assert.match(ui.status(), /2 saved, 0 remaining/);
    await ui.close();
  });
}

test('empty input, overlong rows and edited blank names report errors; cancel can keep or discard drafts', async () => {
  let writes = 0;
  const ui = await mount('groceries', async () => { writes++; return { status: 'saved' }; });
  await ui.openReview('-\n[ ]\n ');
  assert.match(ui.status(), /at least one/);
  await ui.change('paste-input', 'a'.repeat(301));
  await ui.click('paste-review-button');
  const id = rowId(ui.rows()[0]);
  assert.equal(ui.find(`paste-title-${id}`).props.value.length, 301);
  await ui.click('paste-add');
  assert.equal(writes, 0);
  assert.match(ui.rows()[0].findByProps({ role: 'alert' }).children[0].children.join(''), /300/);
  await ui.change(`paste-title-${id}`, ' ');
  await ui.click('paste-add');
  assert.equal(writes, 0);
  confirmDiscard = false;
  await ui.click('paste-cancel');
  assert.equal(ui.rows().length, 1);
  confirmDiscard = true;
  await ui.click('paste-cancel');
  assert.ok(ui.find('paste-open'));
  await ui.close();
});

test('double-click lock, partial confirmed save and blocked failure keep only unsaved drafts for retry', async () => {
  let resolve!: (result: ListSaveResult) => void;
  let calls = 0;
  const sent: string[] = [];
  const ui = await mount('groceries', async (_kind, row) => {
    sent.push(row.title);
    if (++calls === 1) return new Promise((r) => { resolve = r; });
    if (calls === 2) return { status: 'blocked', error: 'Nothing was sent.' };
    return { status: 'saved' };
  });
  await ui.openReview('First\nSecond\nThird');
  let run!: Promise<void>;
  await act(async () => {
    run = ui.find('paste-add').props.onClick();
    await ui.find('paste-add').props.onClick();
  });
  assert.equal(calls, 1);
  assert.equal(ui.find('paste-cancel').props.disabled, true);
  assert.ok(ui.rows().every((row) => row.props.disabled));
  await act(async () => { resolve({ status: 'saved' }); await run; });
  assert.deepEqual(sent, ['First', 'Second']);
  assert.equal(ui.rows().length, 2);
  assert.match(ui.status(), /1 saved, 2 remaining/);
  await ui.click('paste-add');
  assert.deepEqual(sent, ['First', 'Second', 'Second', 'Third']);
  assert.match(ui.status(), /3 saved, 0 remaining/);
  await ui.close();
});

for (const decision of ['saved', 'retry'] as const) {
  test(`uncertain response requires successful refreshed-list review before ${decision} decision`, async () => {
    const sent: string[] = [];
    let reads = 0;
    const ui = await mount('groceries', async (_kind, row) => {
      sent.push(row.title);
      return sent.length === 2 ? { status: 'uncertain', error: 'Response lost.' } : { status: 'saved' };
    }, async () => ++reads === 1 ? null : { ...data, groceries: [...data.groceries, { id: 'saved', title: 'Second', quantity: '2', done: false }] });
    await ui.openReview('First\nSecond\nThird');
    await ui.click('paste-add');
    assert.deepEqual(sent, ['First', 'Second']);
    assert.match(ui.status(), /1 saved, 2 remaining/);
    assert.equal(ui.find('paste-add').props.disabled, true);
    await ui.find('paste-add').props.onClick();
    assert.equal(sent.length, 2);
    await ui.click('paste-refresh');
    assert.ok(ui.find('paste-refresh-error'));
    assert.equal(ui.view.root.findAllByProps({ 'data-testid': 'paste-resolve-retry' }).length, 0);
    await ui.click('paste-refresh');
    assert.ok(ui.find('paste-saved-list').findAllByType('span').some((span) => span.children.join('') === 'Quantity: 2'));
    await ui.click(`paste-resolve-${decision}`);
    assert.equal(ui.find('paste-add').props.disabled, false);
    await ui.click('paste-add');
    assert.deepEqual(sent, decision === 'saved' ? ['First', 'Second', 'Third'] : ['First', 'Second', 'Second', 'Third']);
    assert.match(ui.status(), /3 saved, 0 remaining/);
    await ui.close();
  });
}