import 'dotenv/config';
import pg from 'pg';
import { migrate } from '../src/migrate.js';

export const TEST_SCHEMA = 'ledger_test';

/** Rebuilds the isolated test schema from scratch once per test run. */
export default async function setup() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must be set to run tests');
  const local = /@(localhost|127\.0\.0\.1|postgres)(:|\/)/.test(url);
  const client = new pg.Client({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false } });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
  await client.end();
  await migrate(url, TEST_SCHEMA, () => {});
}
