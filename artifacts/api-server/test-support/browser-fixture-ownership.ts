import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const registry = fileURLToPath(new URL('../../../.browser-auth/runs/', import.meta.url));
export const databaseIdentityFile = fileURLToPath(new URL('../../../.browser-auth/development-database.json', import.meta.url));
export const markerKey = 'littleNestBrowserFixture';
const ownershipLifetimeMs = 24 * 60 * 60 * 1000;
export type Run = {
  version: 1; runId: string; proof: string; database: string; name: string;
  createdAt: number; expiresAt: number; pid: number; host: string;
  accountId?: string; householdId?: string; phase: 'active' | 'deleting';
};
export type FixtureScope = {
  project: string; testId: string; fixture: 'household' | 'linked'; index?: number;
};
export type RecoveryContext = { workflowRunId: string; attempt: number };
type RecoveryUser = {
  id: string; externalId: string | null; createdAt: number;
  privateMetadata: Record<string, unknown>;
  emailAddresses: { emailAddress: string }[];
};

function scopeKey(scope: FixtureScope): string {
  if (!['chromium', 'firefox', 'webkit'].includes(scope.project)
    || typeof scope.testId !== 'string' || scope.testId.length < 1 || scope.testId.length > 2048
    || (scope.fixture !== 'household' && scope.fixture !== 'linked')
    || (scope.fixture === 'household' && scope.index !== undefined)
    || (scope.fixture === 'linked' && (!Number.isSafeInteger(scope.index) || scope.index! < 0 || scope.index! > 15))) {
    throw new Error('Invalid browser fixture recovery scope.');
  }
  return JSON.stringify([scope.project, scope.testId, scope.fixture, scope.index ?? null]);
}

export function recoveryContextFromEnv(env = process.env): RecoveryContext | undefined {
  const workflowRunId = env.BROWSER_TEST_WORKFLOW_RUN_ID;
  const rawAttempt = env.BROWSER_TEST_WORKFLOW_RUN_ATTEMPT;
  const configured = Boolean(workflowRunId || rawAttempt);
  if (!configured) {
    if (env.GITHUB_ACTIONS === 'true') {
      throw new Error('Browser CI fixture recovery context is required.');
    }
    return undefined;
  }
  const attempt = Number(rawAttempt);
  if (!/^[1-9]\d{0,19}$/.test(workflowRunId ?? '')
    || !Number.isSafeInteger(attempt) || attempt < 1
    || !env.CLERK_SECRET_KEY?.startsWith('sk_test_')) {
    throw new Error('Invalid browser CI fixture recovery context.');
  }
  return { workflowRunId: workflowRunId!, attempt };
}

function ownershipDigest(secret: string, label: string, value: unknown): Buffer {
  return createHmac('sha256', secret)
    .update(`little-nest-browser-fixture-v1\0${label}\0${JSON.stringify(value)}`)
    .digest();
}

export function recoveryIdentity(
  context: RecoveryContext, scope: FixtureScope,
): { runId: string; name: string } {
  if (!/^[1-9]\d{0,19}$/.test(context.workflowRunId)
    || !Number.isSafeInteger(context.attempt) || context.attempt < 1) {
    throw new Error('Invalid browser fixture recovery identity inputs.');
  }
  // Keep the exact lookup stable across database changes so a stale marker is
  // found and refused, rather than appearing absent; the keyed proof binds its DB.
  const digest = createHash('sha256').update(
    `little-nest-browser-fixture-v1\0run-id\0${JSON.stringify([
    context.workflowRunId, context.attempt, scopeKey(scope),
    ])}`,
  ).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  const runId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { runId, name: `paste-browser-${runId}` };
}

export function recoveryProof(
  context: RecoveryContext, scope: FixtureScope,
  run: Pick<Run, 'runId' | 'database' | 'name' | 'createdAt' | 'expiresAt'>, secret: string,
): string {
  return ownershipDigest(secret, 'private-marker', [
    context.workflowRunId, context.attempt, scopeKey(scope), run.runId, run.database,
    run.name, run.createdAt, run.expiresAt,
  ]).toString('hex');
}

export function recoverRun(
  context: RecoveryContext, scope: FixtureScope, user: RecoveryUser, database: string, secret: string,
): Run {
  const identity = recoveryIdentity(context, scope);
  const actual = user.privateMetadata[markerKey] as Record<string, unknown> | undefined;
  const keys = ['version', 'runId', 'proof', 'database', 'name', 'createdAt', 'expiresAt'];
  if (!actual || Object.keys(actual).length !== keys.length
    || keys.some((key) => !Object.hasOwn(actual, key))
    || actual.version !== 1 || actual.runId !== identity.runId || actual.database !== database
    || actual.name !== identity.name || !Number.isSafeInteger(actual.createdAt)
    || !Number.isSafeInteger(actual.expiresAt)
    || (actual.expiresAt as number) - (actual.createdAt as number) !== ownershipLifetimeMs
    || typeof actual.proof !== 'string' || !/^[a-f0-9]{64}$/.test(actual.proof)) {
    throw new Error('Private ownership marker did not match this exact CI fixture.');
  }
  const expected = recoveryProof(context, scope, {
    runId: identity.runId, database, name: identity.name,
    createdAt: actual.createdAt as number, expiresAt: actual.expiresAt as number,
  }, secret);
  if (!timingSafeEqual(Buffer.from(actual.proof, 'hex'), Buffer.from(expected, 'hex'))) {
    throw new Error('Private ownership proof did not match this exact CI fixture.');
  }
  const run: Run = {
    version: 1, runId: identity.runId, proof: expected, database, name: identity.name,
    createdAt: actual.createdAt as number, expiresAt: actual.expiresAt as number,
    pid: process.pid, host: hostname(), phase: 'active', accountId: user.id,
  };
  validateUser(run, user);
  return run;
}

// The ephemeral CI database no longer exists when a completed run is manually
// recovered. Its fingerprint remains part of the keyed private marker, so the
// exact run/test scope and Clerk identity can still be authenticated without
// trusting a replacement database or searching account-name prefixes.
export function recoverEphemeralCiRun(
  context: RecoveryContext, scope: FixtureScope, user: RecoveryUser, secret: string,
): Run {
  const actual = user.privateMetadata[markerKey] as Record<string, unknown> | undefined;
  if (typeof actual?.database !== 'string' || !/^[a-f0-9]{32}$/.test(actual.database)) {
    throw new Error('Ephemeral CI fixture marker did not contain a valid database fingerprint.');
  }
  return recoverRun(context, scope, user, actual.database, secret);
}

export function assertDevelopment(env = process.env) {
  if (env.NODE_ENV === 'production' || env.REPLIT_DEPLOYMENT
    || !env.CLERK_SECRET_KEY?.startsWith('sk_test_')
    || [env.CLERK_PUBLISHABLE_KEY, env.VITE_CLERK_PUBLISHABLE_KEY].some((key) => key?.startsWith('pk_live_'))) {
    throw new Error('Refusing cleanup outside development or with non-test Clerk credentials.');
  }
}

export function assertEphemeralBrowserDatabase(env = process.env) {
  let url: URL;
  try {
    url = new URL(env.DATABASE_URL ?? '');
  } catch {
    throw new Error('Refusing an invalid ephemeral browser database URL.');
  }
  if (env.GITHUB_ACTIONS !== 'true'
    || env.BROWSER_TEST_DATABASE_MODE !== 'ephemeral-service'
    || url.protocol !== 'postgresql:'
    || url.hostname !== '127.0.0.1'
    || url.port !== '5432'
    || url.pathname !== '/little_nest_browser'
    || url.username !== 'browser_ci'
    || url.password !== 'browser-ci-ephemeral'
    || url.search || url.hash) {
    throw new Error('Refusing any database except the isolated GitHub browser-test service.');
  }
}

export function expectedDatabase(): string {
  const value = JSON.parse(readFileSync(databaseIdentityFile, 'utf8')) as { fingerprint: string; endpoint: string };
  if (!/^[a-f0-9]{32}$/.test(value.fingerprint)
    || !/^[a-f0-9]{64}$/.test(value.endpoint)
    || value.endpoint !== databaseEndpoint()) {
    throw new Error('Invalid trusted browser-fixture database identity or different connection endpoint.');
  }
  return value.fingerprint;
}

export function databaseEndpoint(connection = process.env.DATABASE_URL): string {
  if (!connection) throw new Error('Database connection required.');
  const url = new URL(connection);
  // No passwords or URL query credentials are stored. Endpoint pinning also
  // distinguishes a production clone that retained PostgreSQL's system ID.
  return createHash('sha256').update(JSON.stringify([
    url.protocol, url.hostname, url.port || '5432', url.pathname, url.username,
  ])).digest('hex');
}

export function marker(run: Run) {
  return {
    version: run.version, runId: run.runId, proof: run.proof, database: run.database,
    name: run.name, createdAt: run.createdAt, expiresAt: run.expiresAt,
  };
}

export function createRun(scope?: FixtureScope): Run {
  assertDevelopment();
  const context = recoveryContextFromEnv();
  const database = expectedDatabase();
  const now = Date.now();
  let runId: string = randomUUID();
  let name = `paste-browser-${runId}`;
  if (context) {
    if (!scope) throw new Error('A Playwright test scope is required for recoverable CI fixtures.');
    ({ runId, name } = recoveryIdentity(context, scope));
  }
  const run: Run = {
    version: 1, runId, proof: randomBytes(32).toString('hex'), database,
    name, createdAt: now, expiresAt: now + ownershipLifetimeMs,
    pid: process.pid, host: hostname(), phase: 'active',
  };
  if (context) run.proof = recoveryProof(context, scope!, run, process.env.CLERK_SECRET_KEY!);
  saveRun(run);
  return run;
}

export function runPath(id: string) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) {
    throw new Error('Invalid fixture run ID.');
  }
  return join(registry, `${id}.json`);
}

export function saveRun(run: Run) {
  mkdirSync(registry, { recursive: true, mode: 0o700 });
  const path = runPath(run.runId);
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(run), { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}

export function readRun(id: string): Run {
  const run = JSON.parse(readFileSync(runPath(id), 'utf8')) as Run;
  if (run.version !== 1 || run.runId !== id || run.name !== `paste-browser-${id}`
    || !/^[a-f0-9]{64}$/.test(run.proof) || run.database !== expectedDatabase()
    || !Number.isSafeInteger(run.createdAt) || !Number.isSafeInteger(run.expiresAt)
    || run.expiresAt <= run.createdAt || run.expiresAt - run.createdAt > 24 * 60 * 60 * 1000
    || !Number.isSafeInteger(run.pid) || run.pid <= 0 || typeof run.host !== 'string'
    || !['active', 'deleting'].includes(run.phase)
    || (run.accountId !== undefined && !/^user_[a-zA-Z0-9]+$/.test(run.accountId))
    || (run.householdId !== undefined && !/^[a-f0-9-]{36}$/.test(run.householdId))) {
    throw new Error('Invalid or foreign fixture ownership record.');
  }
  return run;
}

export function isOwnerAlive(run: Run) {
  // Never assume another host is dead. Its fixed 24-hour expiry is the lease.
  if (run.host !== hostname()) return false;
  try { process.kill(run.pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    return true; // Permissions/unknown errors are not proof of death.
  }
}

export function validateUser(run: Run, user: {
  id: string; externalId: string | null; createdAt: number;
  privateMetadata: Record<string, unknown>;
  emailAddresses: { emailAddress: string }[];
}) {
  const expected = marker(run);
  const actual = user.privateMetadata[markerKey] as Record<string, unknown> | undefined;
  if (!actual || Object.keys(actual).length !== Object.keys(expected).length
    || Object.entries(expected).some(([key, value]) => actual[key] !== value)
    || user.externalId !== run.name || (run.accountId && user.id !== run.accountId)
    || user.createdAt < run.createdAt || user.createdAt > run.expiresAt
    || user.emailAddresses.length !== 1 || user.emailAddresses[0]?.emailAddress !== `${run.name}@example.com`) {
    throw new Error('Clerk identity or private ownership marker did not match.');
  }
}

export function validateHousehold(run: Run, accountId: string, house: {
  id: string; name: string; createdAt: Date;
}, members: { householdId: string; authUserId: string | null; role: string; name: string }[],
memberships: { householdId: string }[]) {
  if (house.name !== run.name || (run.householdId && run.householdId !== house.id)
    || house.createdAt.getTime() < run.createdAt || house.createdAt.getTime() > run.expiresAt
    || memberships.length !== 1 || memberships[0]?.householdId !== house.id) {
    throw new Error('Household identity did not match owned account.');
  }
  const parents = members.filter((m) => m.role === 'parent' && m.authUserId === accountId && m.name === 'Browser Parent');
  const children = members.filter((m) => m.role === 'child' && m.authUserId === null && m.name === 'Browser Child');
  if (members.length < 1 || members.length > 2 || members.some((m) => m.householdId !== house.id)
    || parents.length !== 1 || members.some((m) => m !== parents[0] && m !== children[0])
    || (members.length === 2 && children.length !== 1) || (members.length === 1 && children.length !== 0)) {
    throw new Error('Household is no longer an isolated synthetic fixture.');
  }
}

export function validateRecoveredHousehold(run: Run, parentAccountId: string, linkedAccountId: string | undefined, house: {
  id: string; name: string; createdAt: Date;
}, members: { householdId: string; authUserId: string | null; role: string; name: string }[],
parentMemberships: { householdId: string }[], linkedMemberships: { householdId: string }[]) {
  if (house.name !== run.name || house.createdAt.getTime() < run.createdAt
    || house.createdAt.getTime() > run.expiresAt
    || parentMemberships.length !== 1 || parentMemberships[0]?.householdId !== house.id
    || linkedMemberships.length > 1
    || linkedMemberships.some((membership) => membership.householdId !== house.id)) {
    throw new Error('Recovered household identity or membership did not match.');
  }
  const parents = members.filter((member) => member.role === 'parent'
    && member.authUserId === parentAccountId && member.name === 'Browser Parent');
  const children = members.filter((member) => member.role === 'child' && member.name === 'Browser Child');
  const linkedChild = Boolean(linkedAccountId && children[0]?.authUserId === linkedAccountId);
  if (members.length < 1 || members.length > 2 || members.some((member) => member.householdId !== house.id)
    || parents.length !== 1 || members.some((member) => member !== parents[0] && member !== children[0])
    || (children.length === 1 && children[0]?.authUserId !== null
      && (!linkedAccountId || children[0]?.authUserId !== linkedAccountId))
    || (children.length === 0 && members.length !== 1)
    || (children.length === 1 && members.length !== 2)
    || (linkedChild && linkedMemberships.length !== 1)
    || (!linkedChild && linkedMemberships.length !== 0)) {
    throw new Error('Recovered household is no longer an isolated synthetic fixture.');
  }
}