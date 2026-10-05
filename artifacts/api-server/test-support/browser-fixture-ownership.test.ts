import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import {
  assertDevelopment, assertEphemeralBrowserDatabase, databaseEndpoint, isOwnerAlive, marker, markerKey,
  recoveryContextFromEnv, recoveryIdentity, recoveryProof, recoverEphemeralCiRun, recoverRun, runPath,
  validateHousehold, validateRecoveredHousehold, validateUser, type FixtureScope, type Run,
} from './browser-fixture-ownership';

const run: Run = {
  version: 1, runId: 'a33a2f6c-78ed-4b27-8514-314337db3141', proof: 'a'.repeat(64),
  database: 'b'.repeat(32), name: 'paste-browser-a33a2f6c-78ed-4b27-8514-314337db3141',
  createdAt: 1000, expiresAt: 2000, pid: process.pid, host: hostname(), phase: 'active',
  accountId: 'user_synthetic', householdId: 'synthetic-household',
};
const user = () => ({
  id: run.accountId!, externalId: run.name, createdAt: 1500,
  privateMetadata: { [markerKey]: marker(run) },
  emailAddresses: [{ emailAddress: `${run.name}@example.com` }],
});
const house = () => ({ id: run.householdId!, name: run.name, createdAt: new Date(1500) });
const members = () => [
  { householdId: run.householdId!, role: 'parent', name: 'Browser Parent', authUserId: run.accountId! },
  { householdId: run.householdId!, role: 'child', name: 'Browser Child', authUserId: null },
];
const memberships = [{ householdId: run.householdId! }];

test('test credentials only; live credentials and deployment indicators fail closed', () => {
  assert.doesNotThrow(() => assertDevelopment({ CLERK_SECRET_KEY: 'sk_test_synthetic' }));
  for (const env of [
    {}, { CLERK_SECRET_KEY: 'sk_live_synthetic' },
    { CLERK_SECRET_KEY: 'sk_test_synthetic', NODE_ENV: 'production' },
    { CLERK_SECRET_KEY: 'sk_test_synthetic', REPLIT_DEPLOYMENT: '1' },
    { CLERK_SECRET_KEY: 'sk_test_synthetic', CLERK_PUBLISHABLE_KEY: 'pk_live_synthetic' },
    { CLERK_SECRET_KEY: 'sk_test_synthetic', VITE_CLERK_PUBLISHABLE_KEY: 'pk_live_synthetic' },
  ]) assert.throws(() => assertDevelopment(env));
});
test('the CI database guard accepts only the exact loopback PostgreSQL service', () => {
  const valid = {
    GITHUB_ACTIONS: 'true',
    BROWSER_TEST_DATABASE_MODE: 'ephemeral-service',
    DATABASE_URL: 'postgresql://browser_ci:browser-ci-ephemeral@127.0.0.1:5432/little_nest_browser',
  };
  assert.doesNotThrow(() => assertEphemeralBrowserDatabase(valid));
  for (const change of [
    { GITHUB_ACTIONS: 'false' },
    { BROWSER_TEST_DATABASE_MODE: 'external' },
    { DATABASE_URL: 'postgresql://browser_ci:browser-ci-ephemeral@db.example/little_nest_browser' },
    { DATABASE_URL: 'postgresql://browser_ci:browser-ci-ephemeral@127.0.0.1:5433/little_nest_browser' },
    { DATABASE_URL: 'postgresql://browser_ci:browser-ci-ephemeral@127.0.0.1:5432/production' },
    { DATABASE_URL: 'postgresql://other:browser-ci-ephemeral@127.0.0.1:5432/little_nest_browser' },
    { DATABASE_URL: 'postgresql://browser_ci:wrong@127.0.0.1:5432/little_nest_browser' },
  ]) assert.throws(() => assertEphemeralBrowserDatabase({ ...valid, ...change }));
});
test('matching private marker and identity are required', () => {
  assert.doesNotThrow(() => validateUser(run, user()));
  for (const field of Object.keys(marker(run))) {
    const candidate = user();
    Object.assign(candidate.privateMetadata[markerKey], { [field]: 'foreign' });
    assert.throws(() => validateUser(run, candidate), field);
  }
});
test('CI fixture identities are reproducible only for their exact completed-run scope', () => {
  const context = { workflowRunId: '123456789', attempt: 2 };
  const scope: FixtureScope = {
    project: 'firefox', testId: 'spec.ts-test-id', fixture: 'household',
  };
  const secret = 'sk_test_private_synthetic_key';
  const first = recoveryIdentity(context, scope);
  assert.deepEqual(recoveryIdentity(context, scope), first);
  assert.notEqual(recoveryIdentity({ ...context, attempt: 1 }, scope).runId, first.runId);
  assert.notEqual(recoveryIdentity(context, { ...scope, project: 'webkit' }).runId, first.runId);
  assert.match(first.runId, /^[a-f0-9-]{36}$/);
  assert.equal(first.name, `paste-browser-${first.runId}`);
  assert.throws(() => recoveryIdentity(context, { ...scope, project: 'unknown' }));
});
test('recovery validates the keyed private marker and reconstructs only the exact fixture', () => {
  const context = { workflowRunId: '987654321', attempt: 1 };
  const scope: FixtureScope = { project: 'chromium', testId: 'settings-test', fixture: 'linked', index: 0 };
  const secret = 'sk_test_private_synthetic_key';
  const identity = recoveryIdentity(context, scope);
  const createdAt = 1000;
  const expiresAt = createdAt + 24 * 60 * 60 * 1000;
  const marked = {
    version: 1, ...identity, database: run.database, createdAt, expiresAt,
    proof: recoveryProof(context, scope, {
      runId: identity.runId, database: run.database, name: identity.name, createdAt, expiresAt,
    }, secret),
  };
  const candidate = {
    id: 'user_synthetic', externalId: identity.name, createdAt: 1500,
    privateMetadata: { [markerKey]: marked },
    emailAddresses: [{ emailAddress: `${identity.name}@example.com` }],
  };
  const recovered = recoverRun(context, scope, candidate, run.database, secret);
  const recoveredWithoutDatabase = recoverEphemeralCiRun(context, scope, candidate, secret);
  assert.equal(recovered.runId, identity.runId);
  assert.equal(recoveredWithoutDatabase.runId, identity.runId);
  assert.equal(recovered.accountId, candidate.id);
  assert.equal(recovered.proof, marked.proof);
  assert.equal(recoveredWithoutDatabase.proof, marked.proof);
  for (const change of [
    { proof: '0'.repeat(64) }, { runId: run.runId }, { database: 'c'.repeat(32) },
    { expiresAt: expiresAt + 1 }, { name: 'paste-browser-other' },
  ]) {
    assert.throws(() => recoverRun(context, scope, {
      ...candidate, privateMetadata: { [markerKey]: { ...marked, ...change } },
    }, run.database, secret));
    assert.throws(() => recoverEphemeralCiRun(context, scope, {
      ...candidate, privateMetadata: { [markerKey]: { ...marked, ...change } },
    }, secret));
  }
  assert.throws(() => recoverEphemeralCiRun(context, scope, {
    ...candidate, privateMetadata: { [markerKey]: { ...marked, database: 'invalid' } },
  }, secret));
  assert.throws(() => recoverRun(context, scope, { ...candidate, externalId: 'other' }, run.database, secret));
  assert.throws(() => recoverRun(context, scope, {
    ...candidate, emailAddresses: [{ emailAddress: 'other@example.com' }],
  }, run.database, secret));
  assert.throws(() => recoverRun(context, scope, { ...candidate, createdAt: expiresAt + 1 }, run.database, secret));
  assert.throws(() => recoverRun(context, scope, candidate, 'c'.repeat(32), secret));
});
test('CI recovery context requires a run attempt and test-only Clerk key', () => {
  assert.deepEqual(recoveryContextFromEnv({
    GITHUB_ACTIONS: 'true', BROWSER_TEST_WORKFLOW_RUN_ID: '123', BROWSER_TEST_WORKFLOW_RUN_ATTEMPT: '2',
    CLERK_SECRET_KEY: 'sk_test_synthetic',
  }), { workflowRunId: '123', attempt: 2 });
  assert.throws(() => recoveryContextFromEnv({ GITHUB_ACTIONS: 'true' }));
  assert.throws(() => recoveryContextFromEnv({
    BROWSER_TEST_WORKFLOW_RUN_ID: '123', BROWSER_TEST_WORKFLOW_RUN_ATTEMPT: '2',
    CLERK_SECRET_KEY: 'sk_live_synthetic',
  }));
});
test('name prefix alone never authorizes an existing user', () => {
  const candidate = user();
  candidate.privateMetadata = {} as ReturnType<typeof user>['privateMetadata'];
  assert.throws(() => validateUser(run, candidate));
});
test('different account, external ID, email, creation time or additional email is refused', () => {
  for (const change of [
    { id: 'user_existing' }, { externalId: 'other' }, { createdAt: 999 }, { createdAt: 2001 },
    { emailAddresses: [{ emailAddress: 'someone@example.com' }] },
    { emailAddresses: [...user().emailAddresses, { emailAddress: 'another@example.com' }] },
  ]) assert.throws(() => validateUser(run, { ...user(), ...change }));
});
test('lost account-create response can recover only its exact marked identity', () => {
  assert.doesNotThrow(() => validateUser({ ...run, accountId: undefined }, user()));
});
test('matching synthetic household is authorized; lost create response can recover membership', () => {
  assert.doesNotThrow(() => validateHousehold(run, run.accountId!, house(), members(), memberships));
  assert.doesNotThrow(() => validateHousehold({ ...run, householdId: undefined }, run.accountId!, house(), members(), memberships));
  assert.doesNotThrow(() => validateHousehold(run, run.accountId!, house(), [members()[0]!], memberships));
});
test('recovered household accepts only the exact synthetic linked child or known UI removal', () => {
  assert.doesNotThrow(() => validateRecoveredHousehold(
    { ...run, householdId: undefined }, run.accountId!, undefined, house(), members(), memberships, [],
  ));
  const linkedMembers = members();
  linkedMembers[1]!.authUserId = 'user_linked';
  assert.doesNotThrow(() => validateRecoveredHousehold(
    { ...run, householdId: undefined }, run.accountId!, 'user_linked', house(),
    linkedMembers, memberships, [{ householdId: run.householdId! }],
  ));
  assert.doesNotThrow(() => validateRecoveredHousehold(
    { ...run, householdId: undefined }, run.accountId!, 'user_linked', house(),
    [members()[0]!], memberships, [],
  ));
  assert.doesNotThrow(() => validateRecoveredHousehold(
    { ...run, householdId: undefined }, run.accountId!, undefined, house(),
    [members()[0]!], memberships, [],
  ));
  assert.throws(() => validateRecoveredHousehold(
    { ...run, householdId: undefined }, run.accountId!, 'user_linked', house(),
    linkedMembers, memberships, [{ householdId: 'foreign-household' }],
  ));
  assert.throws(() => validateRecoveredHousehold(
    { ...run, householdId: undefined }, run.accountId!, 'user_linked', house(),
    members(), memberships, [{ householdId: run.householdId! }],
  ));
});
test('household identity and creation window cannot be substituted', () => {
  for (const change of [{ id: 'other' }, { name: 'other' }, { createdAt: new Date(999) }, { createdAt: new Date(2001) }]) {
    assert.throws(() => validateHousehold(run, run.accountId!, { ...house(), ...change }, members(), memberships));
  }
});
test('foreign/linked/additional/renamed members and foreign memberships are refused', () => {
  for (const change of [{ authUserId: 'user_existing' }, { name: 'Existing Child' }, { role: 'parent' }, { householdId: 'other' }]) {
    const candidate = members();
    Object.assign(candidate[1]!, change);
    assert.throws(() => validateHousehold(run, run.accountId!, house(), candidate, memberships));
  }
  assert.throws(() => validateHousehold(run, run.accountId!, house(), [...members(), members()[1]!], memberships));
  assert.throws(() => validateHousehold(run, run.accountId!, house(), members(), [{ householdId: 'other' }]));
  assert.throws(() => validateHousehold(run, run.accountId!, house(), members(), []));
});
test('living owner is protected even if expired; invalid IDs cannot escape registry', () => {
  assert.equal(isOwnerAlive(run), true);
  assert.throws(() => runPath('../../existing'));
});
test('database endpoint pinning rejects production clones without storing passwords', () => {
  const development = 'postgresql://fixture:first@development.invalid/nest';
  assert.equal(databaseEndpoint(development), databaseEndpoint('postgresql://fixture:changed@development.invalid/nest'));
  assert.notEqual(databaseEndpoint(development), databaseEndpoint('postgresql://fixture:first@production.invalid/nest'));
  assert.notEqual(databaseEndpoint(development), databaseEndpoint('postgresql://fixture:first@development.invalid/production'));
});