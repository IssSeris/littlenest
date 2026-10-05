import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { NestMember } from '@workspace/api-client-react';
import { AddMemberForm } from '../src/components/AddMemberForm';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const makeMember = (id: string, name: string, role: NestMember['role']): NestMember => ({
  id, name, role, avatarId: role === 'child' ? 'reptiles-01-a' : role === 'householdMember' ? 'bugs-01-a' : 'animals-01-a',
  linked: false, trackingLabel: 'School & work',
});
const submitEvent = () => ({ preventDefault() {}, persist() {} });
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test('member form validates, submits every role, and confirms server-saved profiles', async () => {
  const submitted: Array<{ name: string; role: NestMember['role'] }> = [];
  const saved: string[] = [];
  let view!: ReactTestRenderer;
  await act(async () => { view = create(createElement(AddMemberForm, {
    onCreate: async (values) => {
      submitted.push(values);
      return makeMember(`member-${submitted.length}`, values.name, values.role);
    },
    onSaved: async (member) => { saved.push(member.id); },
  })); });
  const form = () => view.root.findByType('form');
  const nameInput = () => view.root.findByProps({ placeholder: 'Enter a name' });
  const roleInput = () => view.root.findByType('select');

  await act(async () => { await form().props.onSubmit(submitEvent()); });
  assert.equal(submitted.length, 0);
  assert.ok(view.root.findAllByType('p').some((node) => node.children.join('') === 'Enter a name.'));

  for (const [index, role] of ['parent', 'child', 'householdMember'].entries()) {
    await act(async () => {
      nameInput().props.onChange({ target: { value: `Member ${index + 1}` } });
      roleInput().props.onChange({ target: { value: role } });
    });
    await act(async () => { await form().props.onSubmit(submitEvent()); });
    assert.deepEqual(submitted[index], { name: `Member ${index + 1}`, role });
    assert.equal(saved[index], `member-${index + 1}`);
    assert.match(view.root.findByProps({ 'data-testid': 'success-add-member' }).children.join(''), /was added as a/);
  }
  assert.equal(submitted.length, 3);
});

test('member form keeps entered values and shows actionable API failures', async () => {
  let view!: ReactTestRenderer;
  await act(async () => { view = create(createElement(AddMemberForm, {
    onCreate: async () => { throw { data: { error: 'The parent membership is unavailable.' } }; },
    onSaved: async () => {},
  })); });
  const input = view.root.findByProps({ placeholder: 'Enter a name' });
  await act(async () => { input.props.onChange({ target: { value: 'Keep this name' } }); });
  await act(async () => { await view.root.findByType('form').props.onSubmit(submitEvent()); });
  assert.equal(view.root.findByProps({ placeholder: 'Enter a name' }).props.value, 'Keep this name');
  assert.equal(view.root.findByProps({ role: 'alert' }).children.join(''), 'The parent membership is unavailable.');
});

test('member form blocks duplicate clicks while the server save is pending', async () => {
  let finish!: (member: NestMember) => void;
  let submissions = 0;
  const waiting = new Promise<NestMember>((resolve) => { finish = resolve; });
  let view!: ReactTestRenderer;
  await act(async () => { view = create(createElement(AddMemberForm, {
    onCreate: async (values) => { submissions++; return waiting; },
    onSaved: async () => {},
  })); });
  const form = view.root.findByType('form');
  await act(async () => { view.root.findByProps({ placeholder: 'Enter a name' }).props.onChange({ target: { value: 'One profile' } }); });
  let first!: Promise<void>;
  let second!: Promise<void>;
  await act(async () => {
    first = form.props.onSubmit(submitEvent());
    second = form.props.onSubmit(submitEvent());
    await settle();
  });
  assert.equal(submissions, 1);
  assert.equal(view.root.findByProps({ 'data-testid': 'button-add-member' }).props.disabled, true);
  assert.ok(view.root.findAllByProps({ role: 'status' }).some((node) => node.children.join('').includes('Saving this profile')));
  await act(async () => {
    finish(makeMember('only-one', 'One profile', 'child'));
    await Promise.all([first, second]);
  });
  assert.equal(submissions, 1);
  assert.equal(view.root.findByProps({ 'data-testid': 'success-add-member' }).children.join(''), 'One profile was added as a Child. The saved household roster is up to date.');
});