// Recover only exact synthetic Clerk identities after the per-run database
// service has been discarded by GitHub Actions.
import { readFileSync } from 'node:fs';
import { createClerkClient } from '@clerk/express';
import {
  assertDevelopment, recoverEphemeralCiRun, recoveryContextFromEnv, recoveryIdentity,
  type FixtureScope,
} from './browser-fixture-ownership';

assertDevelopment();
if (process.env.GITHUB_ACTIONS !== 'true'
  || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
  || process.env.GITHUB_REF !== 'refs/heads/main'
  || process.env.BROWSER_TEST_RECOVERY_MODE !== 'clerk-only-after-ephemeral-database'
  || process.env.BROWSER_TEST_RECOVERY_SOURCE_VALIDATED !== 'true'
  || !process.env.CLERK_PUBLISHABLE_KEY?.startsWith('pk_test_')
  || process.env.CLERK_PUBLISHABLE_KEY !== process.env.VITE_CLERK_PUBLISHABLE_KEY) {
  throw new Error('Clerk fixture recovery is restricted to the validated main-branch workflow.');
}

const context = recoveryContextFromEnv();
if (!context) throw new Error('A completed browser workflow run and attempt are required.');
const [command, sourceRunId, rawAttempt, scopesPath, ...extra] = process.argv.slice(2);
const attempt = Number(rawAttempt);
if (command !== '--recover-workflow'
  || !/^[1-9]\d{0,19}$/.test(sourceRunId ?? '')
  || !Number.isSafeInteger(attempt) || attempt < 1
  || sourceRunId !== context.workflowRunId || attempt !== context.attempt
  || !scopesPath || extra.length) {
  throw new Error('Provide the validated source workflow run, attempt, and exact test scopes.');
}

const scopes = readRecoveryScopes(scopesPath);
const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
let cleaned = 0;
let absent = 0;
let refused = false;

for (const { project, testId } of scopes) {
  const candidates: FixtureScope[] = [
    { project, testId, fixture: 'household' },
    { project, testId, fixture: 'linked', index: 0 },
  ];
  for (const scope of candidates) {
    try {
      const identity = recoveryIdentity(context, scope);
      const listed = await clerk.users.getUserList({ externalId: [identity.name], limit: 2 });
      if (listed.totalCount > 1) throw new Error('Ambiguous exact test identity.');
      const user = listed.data[0];
      if (!user) {
        absent += 1;
        continue;
      }
      const owned = recoverEphemeralCiRun(context, scope, user, process.env.CLERK_SECRET_KEY!);
      const current = await clerk.users.getUser(user.id);
      const confirmed = recoverEphemeralCiRun(context, scope, current, process.env.CLERK_SECRET_KEY!);
      if (confirmed.runId !== owned.runId || confirmed.accountId !== user.id) {
        throw new Error('The exact test identity changed during recovery.');
      }
      await clerk.users.deleteUser(user.id);
      cleaned += 1;
    } catch {
      refused = true;
      console.error('Refused one exact browser test identity after ownership validation failed.');
    }
  }
}

console.log(`Browser fixture recovery finished: ${cleaned} exact test account(s) cleaned; ${absent} were absent.`);
if (refused) process.exitCode = 1;

function readRecoveryScopes(path: string): { project: 'chromium' | 'firefox' | 'webkit'; testId: string }[] {
  const scopes = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > 500) {
    throw new Error('Invalid browser recovery scope file.');
  }
  const unique = new Map<string, { project: 'chromium' | 'firefox' | 'webkit'; testId: string }>();
  for (const item of scopes) {
    if (!item || typeof item !== 'object') throw new Error('Invalid browser recovery test scope.');
    const { project, testId } = item as Record<string, unknown>;
    if (!['chromium', 'firefox', 'webkit'].includes(project as string)
      || typeof testId !== 'string' || testId.length < 1 || testId.length > 2048) {
      throw new Error('Invalid browser recovery test scope.');
    }
    unique.set(`${project}\0${testId}`, {
      project: project as 'chromium' | 'firefox' | 'webkit', testId,
    });
  }
  return [...unique.values()];
}