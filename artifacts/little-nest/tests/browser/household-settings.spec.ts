import { test, expect } from './fixtures';
import type { Locator } from '@playwright/test';

test('parents can change roles, revoke stale invites, and remove a linked member safely', async ({ household: h }) => {
  const parent = h.first;
  await parent.setViewportSize({ width: 390, height: 844 });
  const child = (await h.snapshot()).members.find((member) => member.name === 'Browser Child');
  const parentMember = (await h.snapshot()).members.find((member) => member.name === 'Browser Parent');
  expect(child).toBeDefined();
  expect(parentMember).toBeDefined();
  const childId = child!.id;
  const parentId = parentMember!.id;
  const roster = parent.getByTestId('household-roster');
  const openSettings = async () => {
    await parent.getByTestId('button-open-settings').click();
    await expect(roster).toBeVisible();
  };
  const assertMobileTouchTarget = async (target: Locator) => {
    await target.scrollIntoViewIfNeeded();
    await expect(target).toBeInViewport();
    const bounds = await target.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  };
  const expectNoHorizontalOverflow = async () => {
    const widths = await parent.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect(widths.content).toBeLessThanOrEqual(widths.viewport);
  };

  await openSettings();
  await expectNoHorizontalOverflow();
  await expect(parent.getByTestId(`select-member-role-${parentId}`)).toBeDisabled();
  await expect(parent.getByTestId(`button-remove-member-${parentId}`)).toBeDisabled();
  await expect(roster).toContainText('At least one parent must remain in the household.');

  const childRole = parent.getByTestId(`select-member-role-${childId}`);
  await assertMobileTouchTarget(childRole);
  await expect(parent.getByTestId(`member-link-status-${childId}`)).toHaveText('Not linked');
  const createInvitation = parent.getByTestId(`button-create-invitation-${childId}`);
  await assertMobileTouchTarget(createInvitation);
  await createInvitation.click();
  const originalCode = parent.getByTestId(`input-invitation-code-${childId}`);
  await expect(originalCode).toBeVisible();
  await expectNoHorizontalOverflow();
  const revokedCode = await originalCode.inputValue();

  await childRole.selectOption('parent');
  await expect(childRole).toHaveValue('parent');
  await expect(parent.getByTestId(`input-invitation-code-${childId}`)).toHaveCount(0);
  await expect(parent.getByTestId('error-household-member')).toHaveCount(0);

  await parent.getByTestId('button-close-settings').click();
  await parent.getByTestId('button-refresh').click();
  await openSettings();
  await expect(parent.getByTestId(`select-member-role-${childId}`)).toHaveValue('parent');

  await parent.getByTestId(`select-member-role-${childId}`).selectOption('child');
  await expect(parent.getByTestId(`input-invitation-code-${childId}`)).toHaveCount(0);
  await assertMobileTouchTarget(parent.getByTestId(`button-create-invitation-${childId}`));
  await parent.getByTestId(`button-create-invitation-${childId}`).click();
  const replacementCodeInput = parent.getByTestId(`input-invitation-code-${childId}`);
  await expect(replacementCodeInput).toBeVisible();
  const replacementCode = await replacementCodeInput.inputValue();
  expect(replacementCode).not.toBe(revokedCode);

  const linked = await h.createLinkedMember(childId);
  expect(await linked.joinWithCode(revokedCode)).toBe(400);
  expect(await linked.joinWithCode(replacementCode)).toBe(200);
  await linked.page.reload();
  await expect(linked.page.getByTestId('signed-in-profile')).toHaveText('Browser Child · Child');

  await parent.getByTestId('button-close-settings').click();
  await parent.getByTestId('button-refresh').click();
  await openSettings();
  await expect(parent.getByTestId(`member-link-status-${childId}`)).toHaveText('Account linked');
  await expectNoHorizontalOverflow();

  const chore = await parent.evaluate(async (memberId) => {
    const response = await fetch('/api/nest/records', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'chores',
        data: {
          title: 'Keep this assignment after removal',
          assignedTo: memberId,
          cadence: 'Weekly',
          dueDate: '2026-10-12',
          done: false,
        },
      }),
    });
    if (!response.ok) throw new Error(`Could not create the assignment fixture (${response.status}).`);
    return response.json() as Promise<{ id: string }>;
  }, childId);

  let cancelRemoval!: () => void;
  let removalPrompt = '';
  parent.once('dialog', (dialog) => {
    removalPrompt = dialog.message();
    void dialog.dismiss().then(cancelRemoval);
  });
  const cancelled = new Promise<void>((resolve) => { cancelRemoval = resolve; });
  const removeMember = parent.getByTestId(`button-remove-member-${childId}`);
  await assertMobileTouchTarget(removeMember);
  await removeMember.click();
  await cancelled;
  expect(removalPrompt).toContain('Their account will lose access, but their sign-in account will not be deleted.');
  expect(removalPrompt).toContain('Existing records and assigned work stay in history.');
  expect(removalPrompt).toContain('This cannot be undone.');
  await expect(parent.getByTestId(`settings-member-${childId}`)).toBeVisible();

  let acceptRemoval!: () => void;
  parent.once('dialog', (dialog) => {
    removalPrompt = dialog.message();
    void dialog.accept().then(acceptRemoval);
  });
  const accepted = new Promise<void>((resolve) => { acceptRemoval = resolve; });
  await assertMobileTouchTarget(removeMember);
  await removeMember.click();
  await accepted;
  expect(removalPrompt).toContain('Their account will lose access');
  await expect(parent.getByTestId(`settings-member-${childId}`)).toHaveCount(0);

  const parentSnapshot = await parent.evaluate(async () => {
    const response = await fetch('/api/nest/snapshot', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not refresh the parent household (${response.status}).`);
    return response.json() as Promise<{
      members: { id: string }[];
      chores: { id: string; title: string; assignedTo: string }[];
    }>;
  });
  expect(parentSnapshot.members.some((member) => member.id === childId)).toBe(false);
  expect(parentSnapshot.chores.find((item) => item.id === chore.id)).toMatchObject({
    title: 'Keep this assignment after removal',
    assignedTo: childId,
  });

  await parent.getByTestId('button-close-settings').click();
  await parent.getByTestId('link-nav-chores').click();
  await expectNoHorizontalOverflow();
  await expect(parent.getByTestId(`row-chore-${chore.id}`)).toContainText('Former household member');
  await parent.getByTestId(`button-edit-chore-${chore.id}`).click();
  await expect(parent.getByTestId('select-chore-memberId').locator(`option[value="${childId}"]`))
    .toHaveText('Former household member (keep existing assignment)');

  await expect(linked.page.getByRole('heading', { name: 'Set up your household' })).toBeVisible();
  const stillSignedInId = await linked.page.evaluate(() => (window as any).Clerk?.user?.id);
  expect(stillSignedInId).toBe(linked.accountId);
  const removedAccountSnapshotStatus = await linked.page.evaluate(async () => (
    await fetch('/api/nest/snapshot', { cache: 'no-store' })
  ).status);
  expect(removedAccountSnapshotStatus).toBe(404);
});