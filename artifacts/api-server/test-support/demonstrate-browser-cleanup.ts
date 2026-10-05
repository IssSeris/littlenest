// Opt-in real development demonstration. Only creates/targets its own fixtures.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { createClerkClient } from '@clerk/express';
import {
  assertDevelopment, createRun, marker, markerKey, readRun, runPath, saveRun,
} from './browser-fixture-ownership';

assertDevelopment();
const cwd = fileURLToPath(new URL('../', import.meta.url));
function cleanup(args: string[]) {
  try {
    return { status: 0, output: execFileSync('pnpm', ['exec', 'tsx', 'test-support/cleanup-browser-household.ts', ...args], { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 60_000 }) };
  } catch (error) {
    const result = error as { status: number; stdout: string; stderr: string };
    return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  }
}
assert.equal(cleanup(['--verify-database']).status, 0, 'Trusted development database required.');
const { db, pool, nestHouseholds, nestMembers } = await import('@workspace/db');
const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
type Synthetic = { runId: string; accountId: string; householdId?: string; kind: string };
const own: Synthetic[] = [];
const worker = process.argv[2] === '--abandon-worker';
let workerSucceeded = false;
if (process.argv.length > (worker ? 3 : 2)) throw new Error('Unknown demonstration arguments.');

async function createSynthetic(kind: string): Promise<Synthetic> {
  const run = createRun();
  const user = await clerk.users.createUser({
    externalId: run.name, firstName: 'Browser', lastName: 'Regression',
    emailAddress: [`${run.name}@example.com`], skipPasswordRequirement: true,
    privateMetadata: { [markerKey]: marker(run) },
  });
  const fixture: Synthetic = { runId: run.runId, accountId: user.id, kind };
  own.push(fixture); // Register for local teardown before creating any database rows.
  run.accountId = user.id;
  saveRun(run);
  if (kind !== 'account-only') {
    const house = await db.transaction(async (tx) => {
      const [house] = await tx.insert(nestHouseholds).values({ name: run.name }).returning();
      await tx.insert(nestMembers).values([
        { householdId: house!.id, authUserId: user.id, role: 'parent', name: 'Browser Parent', avatarId: 'animals-01-a' },
        { householdId: house!.id, role: 'child', name: 'Browser Child', avatarId: 'reptiles-01-a' },
      ]);
      return house!;
    });
    run.householdId = house.id;
    fixture.householdId = house.id;
    saveRun(run);
  }
  if (kind !== 'active' && kind !== 'prefix-only') {
    // Deliberately shorten just this newly created synthetic lease.
    await new Promise((resolve) => setTimeout(resolve, 20));
    run.expiresAt = Date.now();
    await clerk.users.updateUserMetadata(user.id, {
      privateMetadata: { [markerKey]: marker(run) },
    });
    saveRun(run);
  }
  if (kind === 'lost-responses') {
    // Simulate both creation responses lost: discovery must use marker + membership.
    run.accountId = undefined;
    run.householdId = undefined;
    saveRun(run);
  } else if (kind === 'foreign-marker') {
    await clerk.users.updateUserMetadata(user.id, {
      privateMetadata: { [markerKey]: { ...marker(run), proof: '0'.repeat(64) } },
    });
  } else if (kind === 'linked-child') {
    await db.update(nestMembers).set({ authUserId: `user_demo${run.runId.replaceAll('-', '')}` })
      .where(and(eq(nestMembers.householdId, fixture.householdId!), eq(nestMembers.role, 'child')));
  } else if (kind === 'prefix-only') {
    await clerk.users.updateUserMetadata(user.id, { privateMetadata: { [markerKey]: null } });
    unlinkSync(runPath(run.runId));
  }
  return fixture;
}

async function assertIntact(fixture: Synthetic) {
  assert.equal((await clerk.users.getUser(fixture.accountId)).id, fixture.accountId);
  if (fixture.householdId) {
    const houses = await db.select().from(nestHouseholds).where(eq(nestHouseholds.id, fixture.householdId));
    assert.equal(houses.length, 1, `Control household ${fixture.kind} must remain untouched.`);
  }
}

async function restoreAndFinish(fixture: Synthetic) {
  let run;
  try { run = readRun(fixture.runId); }
  catch (error) {
    // Already removed expired fixture, or the deliberately unrecorded control.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (fixture.kind !== 'prefix-only') {
      if (!['lost-responses', 'account-only'].includes(fixture.kind)) throw error;
      assert.equal((await clerk.users.getUserList({ userId: [fixture.accountId] })).totalCount, 0);
      if (fixture.householdId) {
        assert.equal((await db.select().from(nestHouseholds).where(eq(nestHouseholds.id, fixture.householdId))).length, 0);
      }
      return;
    }
    const user = await clerk.users.getUser(fixture.accountId);
    // This control was newly created by this invocation, never found by a prefix scan.
    if (user.externalId !== `paste-browser-${fixture.runId}`) throw new Error('Synthetic control identity changed.');
    if (fixture.householdId) {
      await db.transaction(async (tx) => {
        const [house] = await tx.select().from(nestHouseholds).where(eq(nestHouseholds.id, fixture.householdId!)).for('update');
        if (house?.name !== user.externalId) throw new Error('Synthetic control household changed.');
        const members = await tx.select().from(nestMembers).where(eq(nestMembers.householdId, house.id));
        assert.equal(members.length, 2);
        assert.ok(members.some((m) => m.authUserId === fixture.accountId && m.role === 'parent'));
        assert.ok(members.some((m) => m.authUserId === null && m.role === 'child'));
        await tx.delete(nestMembers).where(eq(nestMembers.householdId, house.id));
        await tx.delete(nestHouseholds).where(eq(nestHouseholds.id, house.id));
      });
    }
    await clerk.users.deleteUser(fixture.accountId);
    return;
  }
  if (fixture.kind === 'linked-child') {
    const rows = await db.select().from(nestMembers).where(eq(nestMembers.householdId, fixture.householdId!));
    const child = rows.find((m) => m.role === 'child')!;
    await db.update(nestMembers).set({ authUserId: null }).where(eq(nestMembers.id, child.id));
  }
  await clerk.users.updateUserMetadata(fixture.accountId, { privateMetadata: { [markerKey]: marker(run) } });
  assert.equal(cleanup(['--finish', fixture.runId]).status, 0, `Teardown failed for ${fixture.kind}.`);
}

try {
  if (worker) {
    for (const kind of ['lost-responses', 'account-only', 'foreign-marker', 'linked-child']) await createSynthetic(kind);
    console.log(JSON.stringify(own)); // IDs only, never proofs/keys/cookies.
    workerSucceeded = true;
    // Exit without fixture teardown: the parent must recover these dead-owner runs.
  } else {
    const active = await createSynthetic('active');
    const prefix = await createSynthetic('prefix-only');
    const abandoned = JSON.parse(execFileSync('pnpm', ['exec', 'tsx', 'test-support/demonstrate-browser-cleanup.ts', '--abandon-worker'], {
      cwd, encoding: 'utf8', stdio: 'pipe', timeout: 120_000,
    }).trim().split('\n').at(-1)!) as Synthetic[];
    own.push(...abandoned);
    const dry = cleanup(['--dry-run']);
    // Other previously abandoned runs may be refused; no broad --apply is used here.
    for (const fixture of own) await assertIntact(fixture);
    assert.ok(dry.output.includes(`"runId":"${active.runId}","status":"skipped-active-or-unexpired"`));
    assert.ok(!dry.output.includes(prefix.runId), 'Unrecorded prefix-only account cannot be a candidate.');
    for (const fixture of abandoned) {
      const shouldDelete = ['lost-responses', 'account-only'].includes(fixture.kind);
      assert.ok(dry.output.includes(`"runId":"${fixture.runId}","status":"${shouldDelete ? 'would-delete' : 'refused'}"`));
      const applied = cleanup(['--run', fixture.runId, '--apply']);
      assert.equal(applied.status, shouldDelete ? 0 : 1);
      if (shouldDelete) {
        assert.ok(applied.output.includes('"status":"deleted"'));
        assert.equal((await clerk.users.getUserList({ userId: [fixture.accountId] })).totalCount, 0);
        if (fixture.householdId) assert.equal((await db.select().from(nestHouseholds).where(eq(nestHouseholds.id, fixture.householdId))).length, 0);
      } else await assertIntact(fixture);
    }
    assert.equal(cleanup(['--run', active.runId, '--apply']).status, 0);
    await assertIntact(active);
    await assertIntact(prefix);
    console.log('PASS: dry-run made no changes; only deliberately abandoned owned fixtures were deleted; active, foreign-marker, linked-child and prefix-only controls were preserved.');
  }
} finally {
  if (!worker || !workerSucceeded) {
    try {
      for (const fixture of own) await restoreAndFinish(fixture);
      console.log('PASS: all demonstration controls removed.');
    } finally { await pool.end(); }
  } else await pool.end();
}