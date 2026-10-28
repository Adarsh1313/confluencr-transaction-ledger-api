import pg from 'pg';

// Postgres returns BIGINT as a string because it can exceed JavaScript's exact
// integer range. Our amounts are capped well inside that range, so parse them
// as numbers.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;

export function createPool(connectionString: string, schema: string): Db {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`Invalid schema name: ${schema}`);
  return new pg.Pool({
    connectionString,
    ssl: isLocal(connectionString) ? false : { rejectUnauthorized: false },
    max: 10,
    options: `-c search_path=${schema}`,
  });
}

function isLocal(connectionString: string): boolean {
  return /@(localhost|127\.0\.0\.1|postgres)(:|\/)/.test(connectionString);
}

/**
 * Runs `work` inside one database transaction: everything commits together,
 * or on any error everything rolls back.
 */
export async function withDatabaseTransaction<T>(
  db: Db,
  work: (client: DbClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
