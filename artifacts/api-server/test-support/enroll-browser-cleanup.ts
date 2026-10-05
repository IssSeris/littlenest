// Explicit one-time enrollment using a fingerprint from TRUSTED DEVELOPMENT tooling.
// Never derives authorization just from the supplied connection URL.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { sql } from 'drizzle-orm';
import { assertDevelopment, databaseEndpoint, databaseIdentityFile } from './browser-fixture-ownership';

assertDevelopment();
const [fingerprint, ...extra] = process.argv.slice(2);
if (!/^[a-f0-9]{32}$/.test(fingerprint ?? '') || extra.length) {
  throw new Error('Provide the fingerprint obtained explicitly from trusted DEVELOPMENT database tooling.');
}
const { db, pool } = await import('@workspace/db');
try {
  const identity = await db.execute(sql`SELECT md5(current_database() || ':' || system_identifier::text) AS fingerprint FROM pg_control_system()`);
  if (identity.rows[0]?.fingerprint !== fingerprint) throw new Error('Target does not match trusted development fingerprint.');
  mkdirSync(dirname(databaseIdentityFile), { recursive: true, mode: 0o700 });
  writeFileSync(databaseIdentityFile, JSON.stringify({ fingerprint, endpoint: databaseEndpoint() }), { mode: 0o600, flag: 'wx' });
  console.log('Trusted development database enrolled. Existing enrollment is never overwritten.');
} finally {
  await pool.end();
}