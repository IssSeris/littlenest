// Establish identity only for the fresh, loopback-only PostgreSQL service
// declared by the protected GitHub browser workflow.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { sql } from 'drizzle-orm';
import {
  assertDevelopment, assertEphemeralBrowserDatabase, databaseEndpoint, databaseIdentityFile,
} from './browser-fixture-ownership';

assertDevelopment();
assertEphemeralBrowserDatabase();
if (!process.env.CLERK_PUBLISHABLE_KEY?.startsWith('pk_test_')
  || process.env.CLERK_PUBLISHABLE_KEY !== process.env.VITE_CLERK_PUBLISHABLE_KEY) {
  throw new Error('Refusing browser database setup without matching test-instance Clerk keys.');
}

const { db, pool } = await import('@workspace/db');
try {
  const tables = await db.execute(sql`
    SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public'
  `);
  if (tables.rows.length !== 0) {
    throw new Error('Refusing a browser database that is not fresh and empty.');
  }
  const identity = await db.execute(sql`
    SELECT md5(current_database() || ':' || system_identifier::text) AS fingerprint
    FROM pg_control_system()
  `);
  const fingerprint = identity.rows[0]?.fingerprint;
  if (typeof fingerprint !== 'string' || !/^[a-f0-9]{32}$/.test(fingerprint)) {
    throw new Error('Could not verify the ephemeral browser database identity.');
  }

  mkdirSync(dirname(databaseIdentityFile), { recursive: true, mode: 0o700 });
  writeFileSync(
    databaseIdentityFile,
    JSON.stringify({ fingerprint, endpoint: databaseEndpoint() }),
    { mode: 0o600, flag: 'wx' },
  );
  console.log('Fresh ephemeral browser database verified and pinned.');
} finally {
  await pool.end();
}