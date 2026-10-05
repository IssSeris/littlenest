import { test, expect, review, loadLatest, holdSaveResponse } from './fixtures';

test('real storage events fence stale edits and discard, including a background tab', async ({ household: h }) => {
  const { first: a, second: b } = h;
  await a.getByTestId('paste-open').click();
  await b.getByTestId('paste-open').click();
  await a.bringToFront();
  await a.getByTestId('paste-input').fill('Original milk');
  await expect(b.getByTestId('paste-conflict')).toBeVisible();
  await expect(b.getByTestId('paste-input')).toBeDisabled();
  await loadLatest(b);
  await expect(b.getByTestId('paste-input')).toHaveValue('Original milk');
  await b.getByTestId('paste-input').fill('Edited milk');
  await expect(a.getByTestId('paste-conflict')).toBeVisible();
  await expect(a.getByTestId('paste-review-button')).toBeDisabled();
  a.once('dialog', (dialog) => dialog.accept());
  await a.getByTestId('paste-cancel').click();
  await expect(a.getByTestId('paste-conflict')).toBeVisible();
  expect((await h.draft()).session.text).toBe('Edited milk');
  await loadLatest(a);
  await expect(a.getByTestId('paste-input')).toHaveValue('Edited milk');
  a.once('dialog', (dialog) => dialog.accept());
  await a.getByTestId('paste-cancel').click();
  await expect(a.getByTestId('paste-panel')).toHaveCount(0);
  await expect(b.getByTestId('paste-conflict')).toBeVisible();
  await loadLatest(b);
  await expect(b.getByTestId('paste-input')).toHaveValue('');
  expect((await h.draft()).session.text).toBe('');
  expect((await h.snapshot()).groceries).toEqual([]);
});

test('simultaneous saves send one request and retain the lock until the response returns', async ({ household: h }) => {
  const { first: a, second: b } = h;
  await review(a, 'Lock milk');
  await loadLatest(b);
  await b.getByTestId('paste-resume').click();
  await expect(b.getByTestId('paste-add')).toBeEnabled();
  const gate = await holdSaveResponse(h.context);
  try {
    // DOM clicks in both pages avoid Playwright auto-wait serializing the race.
    await Promise.all([a, b].map((page) => page.evaluate(() =>
      (document.querySelector('[data-testid="paste-add"]') as HTMLButtonElement).click())));
    await gate.committed;
    const owner = await a.getByTestId('paste-status').textContent();
    const loser = owner?.includes('Saving') ? b : a;
    await loser.bringToFront(); // the pending save's owner is now the background tab
    await expect(loser.getByTestId('paste-conflict')).toBeVisible();
    await expect(loser.getByTestId('paste-add')).toBeDisabled();
    expect(gate.requests).toHaveLength(1);
    expect((await h.snapshot()).groceries.map((row) => row.title)).toEqual(['Lock milk']);
    // A reload attempt while the response is held cannot take the owner's lock.
    await loser.getByTestId('paste-load-latest').click();
    await expect(loser.getByTestId('paste-conflict')).toBeVisible();
    expect((await h.draft()).session.uncertainId).not.toBeNull();
    expect(gate.requests).toHaveLength(1);
    await gate.release();
    await expect((loser === a ? b : a).getByTestId('paste-status')).toContainText('1 saved, 0 remaining');
    await loadLatest(loser);
    expect((await h.draft()).session.uncertainId).toBeNull();
    expect((await h.snapshot()).groceries).toHaveLength(1);
  } finally { await gate.release(); }
});

test('terminated owner leaves uncertainty and requires a fresh saved-list review on every reload', async ({ household: h }) => {
  const { first: a, second: b } = h;
  // Identical titles are intentional: recovery must not infer success from title equality.
  await review(a, 'Same milk\nSame milk');
  await loadLatest(b);
  await b.getByTestId('paste-resume').click();
  const gate = await holdSaveResponse(h.context);
  try {
    await a.getByTestId('paste-add').click();
    await gate.committed;
    await expect(b.getByTestId('paste-conflict')).toBeVisible();
    await a.close();
    await gate.release();
    await loadLatest(b); // browser releases the terminated tab's Web Lock
    await expect(b.getByTestId('paste-uncertain')).toBeVisible();
    await expect(b.getByTestId('paste-add')).toBeDisabled();
    await expect(b.getByTestId('paste-resolve-saved')).toHaveCount(0);
    expect(gate.requests).toHaveLength(1);
    expect((await h.draft()).session.drafts).toHaveLength(2);
    await b.getByTestId('paste-refresh').click();
    await expect(b.getByTestId('paste-saved-list')).toContainText('Same milk');
    await expect(b.getByTestId('paste-resolve-saved')).toBeVisible();
    // A review performed before navigation is not reusable confirmation.
    await b.reload();
    await b.getByTestId('paste-resume').click();
    await expect(b.getByTestId('paste-uncertain')).toBeVisible();
    await expect(b.getByTestId('paste-resolve-saved')).toHaveCount(0);
    await expect(b.getByTestId('paste-add')).toBeDisabled();
    expect(gate.requests).toHaveLength(1);
    await b.getByTestId('paste-refresh').click();
    await expect(b.getByTestId('paste-saved-list').locator('li')).toHaveCount(1);
    await b.getByTestId('paste-resolve-saved').click();
    await expect(b.getByTestId('paste-uncertain')).toHaveCount(0);
    await expect(b.getByTestId('paste-add')).toHaveText('Add items (1)');
    expect((await h.draft()).session.drafts).toHaveLength(1);
    expect((await h.snapshot()).groceries).toHaveLength(1);
    expect(gate.requests).toHaveLength(1); // no automatic resend, including the remaining row
  } finally { await gate.release(); }
});

test('missing Web Locks fails visibly without overwriting the draft or sending a record', async ({ household: h }) => {
  const { first: a, second: b } = h;
  await review(a, 'Unsupported milk');
  const before = await h.draft();
  await b.addInitScript(() => {
    // Unsupported browsers lack the property, not just its value. Shadowing
    // it with undefined misleads libraries that use `'locks' in navigator`.
    let owner: object | null = navigator;
    while (owner && !Object.prototype.hasOwnProperty.call(owner, 'locks')) owner = Object.getPrototypeOf(owner);
    if (owner && !Reflect.deleteProperty(owner, 'locks')) throw new Error('Could not simulate absent Web Locks.');
  });
  await b.reload();
  expect(await b.evaluate(() => 'locks' in navigator)).toBe(false);
  await b.getByTestId('paste-resume').click();
  let sent = 0;
  b.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/nest/records') sent++;
  });
  await b.getByTestId('paste-add').click();
  await expect(b.getByTestId('paste-storage-error')).toContainText('Web Locks support. Nothing was sent.');
  expect(await h.draft(b)).toEqual(before);
  expect((await h.snapshot()).groceries).toEqual([]);
  expect(sent).toBe(0);
  await expect(b.locator('[data-testid^="paste-title-"]')).toHaveValue('Unsupported milk');
});