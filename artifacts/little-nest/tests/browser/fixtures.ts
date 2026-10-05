import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createClerkClient } from '@clerk/backend';
import { createRun, marker, markerKey, saveRun } from '../../../api-server/test-support/browser-fixture-ownership';
import { test as base, expect, type Page, type BrowserContext } from '@playwright/test';

type Snapshot = {
  activeId: string;
  members: { id: string; name: string; role: string }[];
  groceries: { id: string; title: string; quantity?: string }[];
};
type LinkedMemberSession = {
  page: Page;
  accountId: string;
  joinWithCode: (code: string) => Promise<number>;
};
type Household = {
  context: BrowserContext;
  first: Page;
  second: Page;
  snapshot: () => Promise<Snapshot>;
  draft: (page?: Page) => Promise<{ session: { text: string; uncertainId: string | null; drafts: { title: string }[] } }>;
  createLinkedMember: (memberId: string) => Promise<LinkedMemberSession>;
};

export const test = base.extend<{ household: Household }>({
  household: async ({ browser, baseURL }, use, testInfo) => {
    if (!process.env.CLERK_SECRET_KEY?.startsWith('sk_test_')) {
      throw new Error('Development Clerk credentials are required; live keys are refused.');
    }
    const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
    execFileSync('pnpm', ['--filter', '@workspace/api-server', 'exec', 'tsx',
      'test-support/cleanup-browser-household.ts', '--verify-database'], {
      cwd: fileURLToPath(new URL('../../../../', import.meta.url)), stdio: 'pipe', timeout: 30_000,
    });
    // Write ownership before the remote call, including the lost-create-response window.
    const run = createRun({
      project: testInfo.project.name, testId: testInfo.testId, fixture: 'household',
    });
    const name = run.name;
    let context: BrowserContext | undefined;
    const linkedContexts: BrowserContext[] = [];
    const linkedRuns: ReturnType<typeof createRun>[] = [];
    const linkedMemberIds: string[] = [];
    let linkedRunIndex = 0;
    let parentCleanupPage: Page | undefined;
    try {
      // Only a newly created identity is used. No existing account is updated.
      const user = await clerk.users.createUser({
        externalId: name, firstName: 'Browser', lastName: 'Regression',
        emailAddress: [`${name}@example.com`], skipPasswordRequirement: true,
        privateMetadata: { [markerKey]: marker(run) },
      });
      run.accountId = user.id;
      saveRun(run);
      context = await browser.newContext({ baseURL, ignoreHTTPSErrors: true });
      const first = await context.newPage();
      parentCleanupPage = first;
      await first.goto('/');
      await first.waitForFunction(() => Boolean((window as any).Clerk?.loaded));
      const ticket = await clerk.signInTokens.createSignInToken({ userId: user.id, expiresInSeconds: 60 });
      // Real Clerk cookies, not a mocked React auth hook or API authentication bypass.
      await first.evaluate(async (token) => {
        const clerk = (window as any).Clerk;
        const result = await clerk.client.signIn.create({ strategy: 'ticket', ticket: token });
        if (result.status !== 'complete') throw new Error('Test sign-in did not complete.');
        await clerk.setActive({ session: result.createdSessionId });
      }, ticket.token);
      await first.waitForFunction((id) => (window as any).Clerk?.user?.id === id, user.id);
      const created = await first.evaluate(async (name) => {
        const existing = await fetch('/api/nest/snapshot');
        if (existing.status !== 404) {
          const clerk = (window as any).Clerk;
          const token = await clerk.session?.getToken();
          const bearerStatus = token
            ? (await fetch('/api/nest/snapshot', { headers: { Authorization: `Bearer ${token}` } })).status
            : 'unavailable';
          throw new Error(
            `Disposable account snapshot returned ${existing.status}, expected 404; `
            + `CI auth diagnostics=${existing.headers.get('x-little-nest-ci-auth') ?? 'missing'}; `
            + `sessionToken=${Boolean(token)}; bearerStatus=${bearerStatus}.`,
          );
        }
        const response = await fetch('/api/nest/households', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, parentName: 'Browser Parent', childName: 'Browser Child' }),
        });
        if (response.status !== 201) throw new Error(`Fixture creation failed (${response.status}).`);
        return response.json() as Promise<{ id: string }>;
      }, name);
      run.householdId = created.id;
      saveRun(run);
      await first.goto('/app/groceries');
      await expect(first.getByTestId('paste-open')).toBeVisible();
      const second = await context.newPage();
      await second.goto('/app/groceries');
      await expect(second.getByTestId('paste-open')).toBeVisible();
      const snapshot = () => first.isClosed()
        ? readSnapshot(second) : readSnapshot(first);
      const activeId = (await snapshot()).activeId;
      const key = `little-nest:paste:v1:${JSON.stringify([user.id, activeId, 'groceries'])}`;
      const createLinkedMember = async (memberId: string): Promise<LinkedMemberSession> => {
        if (linkedRunIndex > 0) throw new Error('A browser test may create only one linked fixture account.');
        const linkedRun = createRun({
          project: testInfo.project.name, testId: testInfo.testId,
          fixture: 'linked', index: linkedRunIndex++,
        });
        linkedRuns.push(linkedRun);
        linkedMemberIds.push(memberId);
        const linkedUser = await clerk.users.createUser({
          externalId: linkedRun.name, firstName: 'Browser', lastName: 'Linked',
          emailAddress: [`${linkedRun.name}@example.com`], skipPasswordRequirement: true,
          privateMetadata: { [markerKey]: marker(linkedRun) },
        });
        linkedRun.accountId = linkedUser.id;
        saveRun(linkedRun);
        const linkedContext = await browser.newContext({ baseURL, ignoreHTTPSErrors: true });
        linkedContexts.push(linkedContext);
        const linkedPage = await linkedContext.newPage();
        await linkedPage.goto('/');
        await linkedPage.waitForFunction(() => Boolean((window as any).Clerk?.loaded));
        const linkedTicket = await clerk.signInTokens.createSignInToken({ userId: linkedUser.id, expiresInSeconds: 60 });
        await linkedPage.evaluate(async (token) => {
          const clerk = (window as any).Clerk;
          const result = await clerk.client.signIn.create({ strategy: 'ticket', ticket: token });
          if (result.status !== 'complete') throw new Error('Test sign-in did not complete.');
          await clerk.setActive({ session: result.createdSessionId });
        }, linkedTicket.token);
        await linkedPage.waitForFunction((id) => (window as any).Clerk?.user?.id === id, linkedUser.id);
        const noHousehold = await linkedPage.evaluate(async () => (await fetch('/api/nest/snapshot')).status);
        if (noHousehold !== 404) throw new Error('Disposable linked account unexpectedly has a household.');
        return {
          page: linkedPage,
          accountId: linkedUser.id,
          joinWithCode: (code) => linkedPage.evaluate(async (inviteCode) => {
            const response = await fetch('/api/nest/join', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ code: inviteCode }),
            });
            return response.status;
          }, code),
        };
      };
      await use({
        context, first, second, snapshot, createLinkedMember,
        draft: (page = first.isClosed() ? second : first) => page.evaluate((key) => {
          const raw = localStorage.getItem(key);
          if (!raw) throw new Error('Expected a persisted browser draft.');
          return JSON.parse(raw);
        }, key),
      });
    } finally {
      // Detach any linked test account before guarded cleanup checks the fixtures.
      try {
        if (parentCleanupPage && !parentCleanupPage.isClosed()) {
          for (const memberId of linkedMemberIds) {
            const status = await parentCleanupPage.evaluate(async (id) => (
              await fetch(`/api/nest/members/${id}`, { method: 'DELETE' })
            ).status, memberId);
            if (![204, 404].includes(status)) {
              throw new Error(`Could not detach disposable linked profile (${status}).`);
            }
          }
        }
      } finally {
        let cleanupError: unknown;
        try { await context?.close(); } catch (error) { cleanupError = error; }
        for (const linkedContext of linkedContexts) {
          try { await linkedContext.close(); } catch (error) { cleanupError ??= error; }
        }
        for (const linkedRun of linkedRuns) {
          try {
            execFileSync('pnpm', ['--filter', '@workspace/api-server', 'exec', 'tsx',
              'test-support/cleanup-browser-household.ts', '--finish', linkedRun.runId], {
              cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
              stdio: 'pipe',
              timeout: 30_000,
            });
          } catch (error) { cleanupError ??= error; }
        }
        try {
          execFileSync('pnpm', ['--filter', '@workspace/api-server', 'exec', 'tsx',
            'test-support/cleanup-browser-household.ts', '--finish', run.runId], {
            cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
            stdio: 'pipe',
            timeout: 30_000,
          });
        } catch (error) { cleanupError ??= error; }
        if (cleanupError) throw cleanupError;
      }
    }
  },
});

export { expect };

async function readSnapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(async () => {
    const response = await fetch('/api/nest/snapshot', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Snapshot failed (${response.status}).`);
    return response.json();
  });
}

export async function review(page: Page, text: string) {
  await page.getByTestId('paste-open').click();
  await page.getByTestId('paste-input').fill(text);
  await page.getByTestId('paste-review-button').click();
  await expect(page.getByTestId('paste-add')).toBeEnabled();
}

export async function loadLatest(page: Page) {
  await page.getByTestId('paste-load-latest').click();
  await expect(page.getByTestId('paste-conflict')).toHaveCount(0);
}

// Hold delivery to the component AFTER the original browser fetch completes.
// Forwarding through route.fetch changes the request's authentication path in
// the proxied development environment, even with a real Clerk cookie session.
export async function holdSaveResponse(context: BrowserContext) {
  let entered!: () => void;
  let failed!: (error: Error) => void;
  const committed = new Promise<void>((resolve, reject) => { entered = resolve; failed = reject; });
  const requests: string[] = [];
  context.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/nest/records') {
      requests.push(request.postData() ?? '');
    }
  });
  await context.exposeBinding('__pasteResponseCommitted', (_source, status: number) => {
    if (status === 201) entered();
    else failed(new Error(`Original browser save failed (${status}).`));
  });
  const install = () => {
    const original = window.fetch.bind(window);
    const state = window as unknown as {
      __pasteRelease?: () => void;
      __pasteReleased?: boolean;
      __pasteResponseCommitted: (status: number) => Promise<void>;
    };
    window.fetch = async (input, init) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(request?.url ?? String(input), location.href);
      const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
      const response = await original(input, init);
      if (method === 'POST' && url.pathname === '/api/nest/records' && !state.__pasteReleased) {
        // Install the release callback before notifying the test, so there is
        // no timing gap between observing a commit and releasing its response.
        const held = new Promise<void>((resolve) => { state.__pasteRelease = resolve; });
        await state.__pasteResponseCommitted(response.status);
        await held;
      }
      return response;
    };
  };
  await context.addInitScript(install);
  await Promise.all(context.pages().map((page) => page.evaluate(install)));
  const release = async () => {
    await Promise.all(context.pages().map(async (page) => {
      if (page.isClosed()) return;
      await page.evaluate(() => {
        const state = window as unknown as { __pasteReleased?: boolean; __pasteRelease?: () => void };
        state.__pasteReleased = true;
        state.__pasteRelease?.();
      }).catch((error) => { if (!page.isClosed()) throw error; });
    }));
  };
  return { committed, release, requests };
}