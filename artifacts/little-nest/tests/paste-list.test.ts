import test from 'node:test';
import assert from 'node:assert/strict';
import { parseList, validateDraft, draftPayload, type ListDraft } from '../src/lib/paste-list';

const members = [{ id: 'parent', name: 'Parent', role: 'parent' as const, linked: true }];
const row: ListDraft = { id: 'draft', title: 'Milk', quantity: '', assignedTo: 'parent', cadence: 'Once', dueDate: '2026-10-03' };

test('plain, bullet, numbered, checkbox and CRLF lists preserve order and repeated titles', () => {
  assert.deepEqual(parseList('  Plain  \r\n- Milk\r\n* Eggs\n• Bread\n1. Apples\n2) Pears\n(3) Peaches\n- [ ] Dishes\n[x] Sweep\n☑ Mop\nMilk'), ['Plain', 'Milk', 'Eggs', 'Bread', 'Apples', 'Pears', 'Peaches', 'Dishes', 'Sweep', 'Mop', 'Milk']);
});
test('blanks and marker-only lines are ignored without losing meaningful punctuation or quantities', () => {
  assert.deepEqual(parseList(' \n-\n•\n1.\n[ ]\n- [x]\n☐\nSalt, pepper\n2 cartons milk\n-5 degrees\n3.14 pie\nC++\n[Important] call'), ['Salt, pepper', '2 cartons milk', '-5 degrees', '3.14 pie', 'C++', '[Important] call']);
  assert.deepEqual(parseList('\r\n \t\r'), []);
});
test('overlong input is preserved for review, not silently truncated', () => {
  const long = 'a'.repeat(301);
  assert.equal(parseList(`- ${long}`)[0], long);
  assert.match(validateDraft('groceries', { ...row, title: long }, members).join(), /300/);
  assert.match(validateDraft('groceries', { ...row, quantity: 'a'.repeat(101) }, members).join(), /100/);
  assert.match(validateDraft('groceries', { ...row, title: '  ' }, members).join(), /name/);
  assert.deepEqual(validateDraft('groceries', { ...row, title: 'a'.repeat(300), quantity: 'q'.repeat(100) }, members), []);
});
test('chore members, cadence and real calendar dates are validated before saving', () => {
  assert.deepEqual(validateDraft('chores', row, members), []);
  for (const dueDate of ['', '2026-02-29', '2026-04-31', '2026-13-01', '26-10-03']) {
    assert.match(validateDraft('chores', { ...row, dueDate }, members).join(), /date/);
  }
  assert.match(validateDraft('chores', { ...row, assignedTo: 'removed', cadence: 'Yearly' }, members).join(), /member.*cadence/);
  assert.deepEqual(draftPayload('chores', { ...row, title: '  Dishes  ' }), { title: 'Dishes', assignedTo: 'parent', cadence: 'Once', dueDate: '2026-10-03', done: false, isPaid: false, payAmount: 0 });
  assert.deepEqual(draftPayload('groceries', { ...row, quantity: ' 2 cartons ' }), { title: 'Milk', quantity: '2 cartons', done: false });
});
test('Household paid drafts keep a preset amount and reject invalid money', () => {
  const paid = { ...row, assignedTo: 'household', isPaid: true, payAmount: '3.29' };
  assert.deepEqual(validateDraft('chores', paid, members), []);
  assert.deepEqual(draftPayload('chores', paid), { title: 'Milk', assignedTo: 'household', cadence: 'Once', dueDate: '2026-10-03', done: false, isPaid: true, payAmount: 3.29 });
  for (const payAmount of ['', '0', '-1', '0.005', 'NaN', '10000001']) assert.match(validateDraft('chores', { ...paid, payAmount }, members).join(), /amount/);
  assert.equal(draftPayload('chores', { ...paid, isPaid: false }).payAmount, 0);
});