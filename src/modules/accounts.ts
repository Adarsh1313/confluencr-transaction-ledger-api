import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Db, DbClient } from '../db.js';
import { accountNotFound } from '../errors.js';
import { newId } from '../ids.js';
import { accountIdParams, errorResponseSchema } from '../schemas.js';

export const accountSchema = z.object({
  id: z.string(),
  name: z.string(),
  balance: z.number().describe('Current balance in paise'),
  created_at: z.string().describe('ISO 8601 timestamp'),
});

export interface AccountRow {
  id: string;
  name: string;
  balance: number;
  created_at: Date;
}

export const toAccount = (row: AccountRow) => ({ ...row, created_at: row.created_at.toISOString() });

/**
 * Locks the account row until the surrounding database transaction ends, so
 * concurrent money movements on the same account wait their turn.
 */
export async function lockAccount(client: DbClient, accountId: string): Promise<AccountRow> {
  const { rows } = await client.query<AccountRow>('SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
  if (rows.length === 0) throw accountNotFound(accountId);
  return rows[0];
}

/** Throws 404 unless the account exists. */
export async function assertAccountExists(db: Db, accountId: string) {
  const { rowCount } = await db.query('SELECT 1 FROM accounts WHERE id = $1', [accountId]);
  if (rowCount === 0) throw accountNotFound(accountId);
}

export const accountRoutes =
  (db: Db): FastifyPluginAsyncZod =>
  async (app) => {
    app.post(
      '/accounts',
      {
        schema: {
          tags: ['accounts'],
          summary: 'Create an account (balance always starts at 0)',
          body: z.strictObject({
            name: z.string().trim().min(1, 'name is required').max(100).describe('Account holder name'),
          }),
          response: { 201: accountSchema, 400: errorResponseSchema },
        },
      },
      async (request, reply) => {
        const { rows } = await db.query<AccountRow>('INSERT INTO accounts (id, name) VALUES ($1, $2) RETURNING *', [
          newId('acc'),
          request.body.name,
        ]);
        return reply.status(201).send(toAccount(rows[0]));
      },
    );

    app.get(
      '/accounts/:id/balance',
      {
        schema: {
          tags: ['accounts'],
          summary: 'Get the current balance of an account',
          params: accountIdParams,
          response: {
            200: z.object({ account_id: z.string(), balance: z.number().describe('Balance in paise') }),
            404: errorResponseSchema,
          },
        },
      },
      async (request) => {
        const { rows } = await db.query<{ balance: number }>('SELECT balance FROM accounts WHERE id = $1', [
          request.params.id,
        ]);
        if (rows.length === 0) throw accountNotFound(request.params.id);
        return { account_id: request.params.id, balance: rows[0].balance };
      },
    );
  };
