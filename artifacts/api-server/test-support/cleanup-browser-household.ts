// Development CLI only. Never mounted on the application API.
import { readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { createClerkClient } from '@clerk/express';
import {
  assertDevelopment, expectedDatabase, isOwnerAlive, readRun, recoveryContextFromEnv, recoveryIdentity, recoverRun,
  registry, runPath, saveRun, validateUser, validateHousehold, validateRecoveredHousehold,
  type FixtureScope,
} from './browser-fixture-ownership';

assertDevelopment(); // Before loading the database or making any network request.
const trustedDatabase = expectedDatabase(); // Reject other endpoints before connecting.
const args = process.argv.slice(2);
const finish = args[0] === '--finish' && args.length === 2;
const apply = args.length === 1 && args[0] === '--apply';
const verifyOnly = args.length === 1 && args[0] === '--verify-database';
const recoverWorkflow = args[0] === '--recover-workflow' && args.length === 4
  && /^[1-9]\d{0,19}$/.test(args[1] ?? '') && /^[1-9]\d{0,5}$/.test(args[2] ?? '');
const scoped = args[0] === '--run' && (args.length === 2
  || (args.length === 3 && ['--apply', '--dry-run'].includes(args[2]!)));
const scopedApply = scoped && args[2] === '--apply';
if (!finish && !apply && !verifyOnly && !recoverWorkflow && !scoped
  && !(args.length === 0 || (args.length === 1 && args[0] === '--dry-run'))) {
  throw new Error('Usage: cleanup-browser-household.ts [--dry-run | --apply | --run RUN_ID [--apply|--dry-run] | --finish RUN_ID | --verify-database | --recover-workflow RUN_ID ATTEMPT SCOPES_FILE]');
}
const { db, pool, nestHouseholds, nestMembers, nestRecords, nestInvitations, nestNotifications } = await import('@workspace/db');
const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
let refused = false;
try {
  const identity = await db.execute(sql`SELECT md5(current_database() || ':' || system_identifier::text) AS fingerprint FROM pg_control_system()`);
  if (identity.rows[0]?.fingerprint !== trustedDatabase) {
      throw new Error('Refusing an unverified database: target is not the pinned browser-fixture database.');
  }
  if (recoverWorkflow) {
    const context = recoveryContextFromEnv();
    if (!context || context.workflowRunId !== args[1] || String(context.attempt) !== args[2]) {
      throw new Error('Recovery source does not match the explicitly selected workflow run attempt.');
    }
    const scopes = readRecoveryScopes(args[3]!);
    let recovered = 0;
    let absent = 0;
    for (const { project, testId } of scopes) {
      try {
        const result = await recoverTestScope(context, { project, testId }, trustedDatabase);
        if (result === 'recovered') recovered += 1;
        else absent += 1;
      } catch {
        refused = true;
        // Avoid printing Clerk request errors, private markers, or other remote response data.
        console.error('Refused recovery for one exact browser test scope after ownership validation failed.');
      }
    }
    console.log(`Browser fixture recovery finished: ${recovered} exact test scope(s) cleaned; ${absent} had no remaining account.`);
  } else {
    const ids = verifyOnly ? [] : (finish || scoped) ? [args[1]!] : (() => {
      try { return readdirSync(registry).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    })();
    for (const id of ids) {
      try {
        const run = readRun(id);
        if (!finish && (run.expiresAt > Date.now() || isOwnerAlive(run))) {
          console.log(JSON.stringify({ runId: id, status: 'skipped-active-or-unexpired' }));
          continue;
        }
        // Exact external ID lookup also recovers a killed createUser response.
        const users = await clerk.users.getUserList({ externalId: [run.name], limit: 2 });
        if (users.totalCount > 1) throw new Error('Ambiguous Clerk ownership.');
        const user = users.data[0];
        if (user) validateUser(run, user);
        else if (run.accountId && run.phase !== 'deleting') throw new Error('Owned Clerk account is unexpectedly missing.');
        const accountId = user?.id ?? run.accountId;
        const deleting = finish || apply || scopedApply;
        await db.transaction(async (tx) => {
          // Serialize cleaners and block concurrent membership changes while checking ownership.
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${id}))`);
          await tx.execute(sql`LOCK TABLE nest_members IN SHARE ROW EXCLUSIVE MODE`);
          const memberships = accountId
            ? await tx.select().from(nestMembers).where(eq(nestMembers.authUserId, accountId))
            : [];
          if (memberships.length > 1) throw new Error('Account belongs to multiple households.');
          const householdId = run.householdId ?? memberships[0]?.householdId;
          const [house] = householdId
            ? await tx.select().from(nestHouseholds).where(eq(nestHouseholds.id, householdId)).for('update')
            : [];
          if (house) {
            if (!user || !accountId) throw new Error('Household lacks a verifiable owned Clerk account.');
            const members = await tx.select().from(nestMembers).where(eq(nestMembers.householdId, house.id)).for('update');
            validateHousehold(run, accountId, house, members, memberships);
          } else if (memberships.length || (householdId && run.phase !== 'deleting')) {
            throw new Error('Fixture household is unexpectedly missing.');
          }
          if (!deleting) {
            console.log(JSON.stringify({ runId: id, status: 'would-delete', accountId, householdId: house?.id ?? null }));
            return;
          }
          // Persist validated identity BEFORE commit; interruptions on either side are retryable.
          run.accountId = accountId;
          run.householdId = householdId;
          run.phase = 'deleting';
          saveRun(run);
          if (house) await deleteHousehold(tx, house.id);
        });
        if (deleting) {
          // Keep the ledger until BOTH systems are clean, so failures can be retried.
          if (user) {
            const current = await clerk.users.getUser(user.id);
            validateUser(run, current);
            await clerk.users.deleteUser(user.id);
          }
          unlinkSync(runPath(id));
          console.log(JSON.stringify({ runId: id, status: 'deleted' }));
        }
      } catch (error) {
        refused = true;
        // Do not print remote error objects: they may include request headers.
        console.error(JSON.stringify({ runId: id, status: 'refused', reason: error instanceof Error ? error.message : 'Unknown cleanup failure' }));
      }
    }
    if (!ids.length) console.log(verifyOnly ? 'Trusted development database verified.' : 'No recorded browser fixture runs.');
  }
} finally {
  await pool.end();
}
if (refused) process.exitCode = 1;

function readRecoveryScopes(path: string): { project: string; testId: string }[] {
  const scopes = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > 500) {
    throw new Error('Invalid browser recovery scope file.');
  }
  const unique = new Map<string, { project: string; testId: string }>();
  for (const item of scopes) {
    if (!item || typeof item !== 'object') throw new Error('Invalid browser recovery test scope.');
    const { project, testId } = item as Record<string, unknown>;
    if (!['chromium', 'firefox', 'webkit'].includes(project as string)
      || typeof testId !== 'string' || testId.length < 1 || testId.length > 2048) {
      throw new Error('Invalid browser recovery test scope.');
    }
    unique.set(`${project}\0${testId}`, { project: project as string, testId });
  }
  return [...unique.values()];
}

async function recoverTestScope(
  context: { workflowRunId: string; attempt: number },
  scope: { project: string; testId: string },
  database: string,
): Promise<'recovered' | 'absent'> {
  const secret = process.env.CLERK_SECRET_KEY!;
  const parentScope: FixtureScope = { ...scope, fixture: 'household' };
  const linkedScope: FixtureScope = { ...scope, fixture: 'linked', index: 0 };

  async function findOwned(scope: FixtureScope) {
    const identity = recoveryIdentity(context, scope);
    const users = await clerk.users.getUserList({ externalId: [identity.name], limit: 2 });
    if (users.totalCount > 1) throw new Error('Ambiguous exact synthetic Clerk identity.');
    const user = users.data[0];
    return user ? { user, run: recoverRun(context, scope, user, database, secret) } : undefined;
  }

  const parent = await findOwned(parentScope);
  const linked = await findOwned(linkedScope);
  if (!parent && !linked) return 'absent';
  const locks = [parent?.run.runId, linked?.run.runId].filter((id): id is string => Boolean(id)).sort();

  await db.transaction(async (tx) => {
    for (const id of locks) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${id}))`);
    await tx.execute(sql`LOCK TABLE nest_members IN SHARE ROW EXCLUSIVE MODE`);
    const parentMemberships = parent
      ? await tx.select().from(nestMembers).where(eq(nestMembers.authUserId, parent.user.id))
      : [];
    const linkedMemberships = linked
      ? await tx.select().from(nestMembers).where(eq(nestMembers.authUserId, linked.user.id))
      : [];
    if (parentMemberships.length > 1 || linkedMemberships.length > 1) {
      throw new Error('A recovered account belongs to multiple households.');
    }

    if (parent) {
      const householdId = parentMemberships[0]?.householdId;
      if (!householdId) {
        const namedHouses = await tx.select().from(nestHouseholds).where(eq(nestHouseholds.name, parent.run.name));
        if (namedHouses.length || linkedMemberships.length) {
          throw new Error('A recovered household or linked membership lacks its exact parent membership.');
        }
        return;
      }
      const [house] = await tx.select().from(nestHouseholds).where(eq(nestHouseholds.id, householdId)).for('update');
      if (!house) throw new Error('A recovered parent membership points to a missing household.');
      const members = await tx.select().from(nestMembers).where(eq(nestMembers.householdId, house.id)).for('update');
      validateRecoveredHousehold(
        parent.run, parent.user.id, linked?.user.id, house, members, parentMemberships, linkedMemberships,
      );
      await deleteHousehold(tx, house.id);
    } else {
      const identity = recoveryIdentity(context, parentScope);
      const namedHouses = await tx.select().from(nestHouseholds).where(eq(nestHouseholds.name, identity.name));
      if (namedHouses.length || linkedMemberships.length) {
        throw new Error('A recovered household remains without its exact parent account.');
      }
    }
  });

  // The database transaction removes the exact, verified household first. Recheck
  // each private marker immediately before deleting either remote test identity.
  if (parent) {
    const current = await clerk.users.getUser(parent.user.id);
    validateUser(parent.run, current);
    await clerk.users.deleteUser(parent.user.id);
  }
  if (linked) {
    const current = await clerk.users.getUser(linked.user.id);
    validateUser(linked.run, current);
    await clerk.users.deleteUser(linked.user.id);
  }
  return 'recovered';
}

async function deleteHousehold(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], householdId: string) {
  await tx.delete(nestNotifications).where(eq(nestNotifications.householdId, householdId));
  await tx.delete(nestInvitations).where(eq(nestInvitations.householdId, householdId));
  await tx.delete(nestRecords).where(eq(nestRecords.householdId, householdId));
  await tx.delete(nestMembers).where(eq(nestMembers.householdId, householdId));
  await tx.delete(nestHouseholds).where(eq(nestHouseholds.id, householdId));
}