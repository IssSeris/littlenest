// Protected CI integration check: simulate a canceled runner with no local ledger.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createClerkClient } from '@clerk/express';
import { eq } from 'drizzle-orm';
import {
  assertDevelopment, createRun, marker, markerKey, recoveryContextFromEnv, runPath, saveRun,
  type FixtureScope, type Run,
} from './browser-fixture-ownership';

function requireCheck(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assertDevelopment();
requireCheck(process.env.GITHUB_ACTIONS === 'true', 'This integration check requires protected CI.');
requireCheck(
  process.env.CLERK_PUBLISHABLE_KEY?.startsWith('pk_test_')
    && process.env.CLERK_PUBLISHABLE_KEY === process.env.VITE_CLERK_PUBLISHABLE_KEY,
  'This integration check requires matching test-instance Clerk keys.',
);
const context = recoveryContextFromEnv();
requireCheck(context, 'This integration check requires a workflow run and attempt.');

const cwd = fileURLToPath(new URL('../', import.meta.url));
function runCleanup(args: string[]) {
  try {
    return {
      status: 0,
      output: execFileSync('pnpm', ['exec', 'tsx', 'test-support/cleanup-browser-household.ts', ...args], {
        cwd, encoding: 'utf8', stdio: 'pipe', timeout: 60_000,
      }),
    };
  } catch (error) {
    const result = error as { status?: number | null; stdout?: string; stderr?: string };
    return {
      status: result.status ?? 1,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    };
  }
}

requireCheck(runCleanup(['--verify-database']).status === 0, 'The pinned ephemeral CI database was not verified.');
const { db, pool, nestHouseholds, nestMembers } = await import('@workspace/db');
const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
type Fixture = { run: Run; accountId?: string; householdId?: string; linkedAccountId?: string; foreignMarker?: boolean };
const fixtures: Fixture[] = [];
const scopeFileDir = mkdtempSync(join(tmpdir(), 'little-nest-canceled-recovery-'));
const scopeFile = join(scopeFileDir, 'scopes.json');

function makeScope(project: string, testId: string): FixtureScope {
  return { project, testId, fixture: 'household' };
}

async function createFixture(
  scope: FixtureScope,
  options: { household?: boolean; linkedAccountId?: string } = {},
): Promise<Fixture> {
  const run = createRun(scope);
  const fixture: Fixture = { run, linkedAccountId: options.linkedAccountId };
  fixtures.push(fixture); // The ledger exists before any external fixture is created.
  const user = await clerk.users.createUser({
    externalId: run.name,
    firstName: 'Browser',
    lastName: 'Recovery Check',
    emailAddress: [`${run.name}@example.com`],
    skipPasswordRequirement: true,
    privateMetadata: { [markerKey]: marker(run) },
  });
  fixture.accountId = user.id;
  run.accountId = user.id;
  saveRun(run);

  if (options.household) {
    const household = await db.transaction(async (tx) => {
      const [created] = await tx.insert(nestHouseholds).values({ name: run.name }).returning();
      requireCheck(created, 'The synthetic household could not be created.');
      await tx.insert(nestMembers).values([
        {
          householdId: created.id, authUserId: user.id, role: 'parent',
          name: 'Browser Parent', avatarId: 'animals-01-a',
        },
        {
          householdId: created.id, authUserId: options.linkedAccountId ?? null, role: 'child',
          name: 'Browser Child', avatarId: 'reptiles-01-a',
        },
      ]);
      return created;
    });
    fixture.householdId = household.id;
    run.householdId = household.id;
    saveRun(run);
  }
  return fixture;
}

async function accountExists(fixture: Fixture): Promise<boolean> {
  const users = await clerk.users.getUserList({ userId: fixture.accountId ? [fixture.accountId] : [], limit: 2 });
  return users.totalCount === 1;
}

async function householdExists(fixture: Fixture): Promise<boolean> {
  if (!fixture.householdId) return false;
  const rows = await db.select().from(nestHouseholds).where(eq(nestHouseholds.id, fixture.householdId));
  return rows.length === 1;
}

async function assertRemoved(fixture: Fixture, label: string) {
  requireCheck(!(await accountExists(fixture)), `${label} account was not removed by recovery.`);
  requireCheck(!(await householdExists(fixture)), `${label} household was not removed by recovery.`);
}

async function assertIntact(fixture: Fixture, label: string) {
  requireCheck(await accountExists(fixture), `${label} account was unexpectedly removed.`);
  const user = await clerk.users.getUser(fixture.accountId!);
  requireCheck(
    user.externalId === fixture.run.name
      && user.emailAddresses.length === 1
      && user.emailAddresses[0]?.emailAddress === `${fixture.run.name}@example.com`,
    `${label} identity changed unexpectedly.`,
  );
  const expectedMarker = marker(fixture.run);
  if (fixture.foreignMarker) expectedMarker.proof = '0'.repeat(64);
  const actualMarker = user.privateMetadata[markerKey] as Record<string, unknown> | undefined;
  requireCheck(
    Boolean(actualMarker)
      && Object.keys(expectedMarker).length === Object.keys(actualMarker!).length
      && Object.entries(expectedMarker).every(([key, value]) => actualMarker![key] === value),
    `${label} ownership marker changed unexpectedly.`,
  );

  if (fixture.householdId) {
    const [household] = await db.select().from(nestHouseholds).where(eq(nestHouseholds.id, fixture.householdId));
    const members = await db.select().from(nestMembers).where(eq(nestMembers.householdId, fixture.householdId));
    requireCheck(
      household?.name === fixture.run.name
        && members.length === 2
        && members.some((member) => member.role === 'parent'
          && member.authUserId === fixture.accountId && member.name === 'Browser Parent')
        && members.some((member) => member.role === 'child'
          && member.authUserId === (fixture.linkedAccountId ?? null) && member.name === 'Browser Child'),
      `${label} household changed unexpectedly.`,
    );
  }
}

async function restoreLedgerAndClean(fixture: Fixture) {
  const users = fixture.accountId
    ? await clerk.users.getUserList({ userId: [fixture.accountId], limit: 2 })
    : await clerk.users.getUserList({ externalId: [fixture.run.name], limit: 2 });
  requireCheck(users.totalCount <= 1, 'A fixture identity became ambiguous during test teardown.');
  const user = users.data[0];
  if (user) {
    requireCheck(
      user.externalId === fixture.run.name
        && (!fixture.accountId || user.id === fixture.accountId)
        && user.emailAddresses.length === 1
        && user.emailAddresses[0]?.emailAddress === `${fixture.run.name}@example.com`,
      'A fixture identity changed during test teardown.',
    );
    const expectedMarker = marker(fixture.run);
    if (fixture.foreignMarker) {
      requireCheck(
        (user.privateMetadata[markerKey] as Record<string, unknown> | undefined)?.proof === '0'.repeat(64),
        'A foreign-marker control changed during test teardown.',
      );
      fixture.foreignMarker = false;
    }
    await clerk.users.updateUserMetadata(user.id, { privateMetadata: { [markerKey]: expectedMarker } });
    fixture.accountId = user.id;
    fixture.run.accountId = user.id;
  }

  if (fixture.householdId && fixture.linkedAccountId) {
    const rows = await db.select().from(nestMembers).where(eq(nestMembers.householdId, fixture.householdId));
    const parent = rows.find((member) => member.role === 'parent');
    const child = rows.find((member) => member.role === 'child');
    if (rows.length === 2 && parent !== undefined && child !== undefined
      && parent.authUserId === fixture.accountId && parent.name === 'Browser Parent'
      && child.authUserId === fixture.linkedAccountId && child.name === 'Browser Child') {
      await db.update(nestMembers).set({ authUserId: null }).where(eq(nestMembers.id, child.id));
    } else {
      requireCheck(rows.length === 0, 'A household could not be safely detached during test teardown.');
    }
  }

  fixture.run.phase = user ? 'active' : 'deleting';
  saveRun(fixture.run);
  requireCheck(runCleanup(['--finish', fixture.run.runId]).status === 0, 'A test-owned fixture could not be safely removed.');
}

async function teardown() {
  // The recovery test itself may have stopped after deleting only part of a fixture.
  // The known linked synthetic child is detached only when the exact two rows match.
  const parents = fixtures.filter((fixture) => fixture.householdId && fixture.linkedAccountId);
  for (const parent of parents) {
    const rows = await db.select().from(nestMembers).where(eq(nestMembers.householdId, parent.householdId!));
    const child = rows.find((member) => member.role === 'child');
    if (rows.length === 2 && child !== undefined
      && child.authUserId === parent.linkedAccountId && child.name === 'Browser Child') {
      await db.update(nestMembers).set({ authUserId: null }).where(eq(nestMembers.id, child.id));
    }
  }
  for (const fixture of fixtures) await restoreLedgerAndClean(fixture);
}

try {
  const suffix = randomUUID();
  const targetScope = makeScope('chromium', `canceled-recovery-target-${suffix}`);
  const foreignScope = makeScope('firefox', `canceled-recovery-foreign-${suffix}`);
  const unrelatedScope = makeScope('webkit', `canceled-recovery-unrelated-${suffix}`);

  const parent = await createFixture({ ...targetScope, fixture: 'household' });
  const linked = await createFixture({ ...targetScope, fixture: 'linked', index: 0 });
  parent.linkedAccountId = linked.accountId;
  const targetHousehold = await db.transaction(async (tx) => {
    const [household] = await tx.insert(nestHouseholds).values({ name: parent.run.name }).returning();
    requireCheck(household, 'The target household could not be created.');
    await tx.insert(nestMembers).values([
      {
        householdId: household.id, authUserId: parent.accountId!, role: 'parent',
        name: 'Browser Parent', avatarId: 'animals-01-a',
      },
      {
        householdId: household.id, authUserId: linked.accountId!, role: 'child',
        name: 'Browser Child', avatarId: 'reptiles-01-a',
      },
    ]);
    return household;
  });
  parent.householdId = targetHousehold.id;
  parent.run.householdId = targetHousehold.id;
  saveRun(parent.run);
  linked.householdId = targetHousehold.id;

  const foreign = await createFixture({ ...foreignScope, fixture: 'household' }, { household: true });
  foreign.foreignMarker = true;
  const invalidMarker = { ...marker(foreign.run), proof: '0'.repeat(64) };
  requireCheck(invalidMarker.proof !== foreign.run.proof, 'The foreign-marker control was not distinct.');
  await clerk.users.updateUserMetadata(foreign.accountId!, {
    privateMetadata: { [markerKey]: invalidMarker },
  });

  const unrelated = await createFixture({ ...unrelatedScope, fixture: 'household' }, { household: true });

  // Model a canceled worker: its only discovery aid is intentionally erased.
  for (const fixture of [parent, linked, foreign]) {
    const ledger = runPath(fixture.run.runId);
    requireCheck(existsSync(ledger), 'The fixture ledger was not created before the cancellation simulation.');
    unlinkSync(ledger);
    requireCheck(!existsSync(ledger), 'The cancellation simulation retained a local ownership ledger.');
  }

  writeFileSync(scopeFile, JSON.stringify([
    { project: targetScope.project, testId: targetScope.testId },
    { project: foreignScope.project, testId: foreignScope.testId },
  ]), { mode: 0o600, flag: 'wx' });

  const recovery = runCleanup([
    '--recover-workflow', context.workflowRunId, String(context.attempt), scopeFile,
  ]);
  requireCheck(recovery.status === 1, 'Recovery did not refuse the foreign-marker control.');
  requireCheck(
    !recovery.output.includes(process.env.CLERK_SECRET_KEY!)
      && fixtures.every((fixture) => !recovery.output.includes(fixture.run.proof)),
    'Recovery output exposed a test credential or ownership proof.',
  );

  await assertRemoved(parent, 'Recovered parent');
  await assertRemoved(linked, 'Recovered linked member');
  await assertIntact(foreign, 'Foreign-marker control');
  await assertIntact(unrelated, 'Same-prefix control');
  console.log('PASS: recovery removed the exact parent household and linked account; foreign-marker and same-prefix controls remained unchanged.');
} finally {
  try {
    await teardown();
  } finally {
    await pool.end();
    rmSync(scopeFileDir, { recursive: true, force: true });
  }
}