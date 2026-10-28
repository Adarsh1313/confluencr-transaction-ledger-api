import 'dotenv/config';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import { createPool, type Db } from '../src/db.js';

/**
 * Builds the real app against the `ledger_test` schema and wipes all tables
 * before each test. Returns getters because the app is created in beforeAll.
 */
export function useTestApp() {
  let app: App;
  let db: Db;

  beforeAll(async () => {
    db = createPool(process.env.DATABASE_URL!, 'ledger_test');
    app = await buildApp({ db });
  });

  beforeEach(async () => {
    const { rows } = await db.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'ledger_test' AND tablename <> 'schema_migrations'",
    );
    if (rows.length > 0) {
      await db.query(`TRUNCATE ${rows.map((r) => r.tablename).join(', ')} CASCADE`);
    }
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  return { app: () => app, db: () => db };
}
