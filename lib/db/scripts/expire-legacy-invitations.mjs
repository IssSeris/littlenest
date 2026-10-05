import { readFile } from "node:fs/promises";
import pg from "pg";

if (process.env.REPLIT_DEPLOYMENT || process.env.NODE_ENV !== "development") {
  throw new Error("Set NODE_ENV=development and run this data migration outside a published deployment.");
}
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required to expire legacy household invitations.");
}

const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL });
try {
  await client.connect();
  const migration = await readFile(new URL("../migrations/0001_expire_unbound_nest_invitations.sql", import.meta.url), "utf8");
  await client.query(migration);
} finally {
  await client.end();
}