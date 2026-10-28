import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Db, DbClient } from '../db.js';
import { accountNotFound } from '../errors.js';
import { newId } from '../ids.js';
import { accountIdParams, accountNotFoundExample, EXAMPLE_ACCOUNT_ID, errorResponse, ok } from '../schemas.js';

export const accountSchema = z
  .object({
    id: z.string().describe('Unique account ID, prefixed `acc_`'),
    name: z.string().describe('Account holder name'),
    balance: z.number().describe('Current balance in paise'),
    created_at: z.string().describe('When the account was opened (ISO 8601, UTC)'),
  })
  .meta({ id: 'Account', description: 'A named holder of money. Its balance changes only through transactions.' });

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
          tags: ['Accounts'],
          operationId: 'createAccount',
          summary: 'Create an account',
          description:
            'Opens a new account for a holder. The server generates the `id` and `created_at`, and the balance always starts at `0`. Sending a `balance` (or any field other than `name`) is rejected, so no account can start with money it was never credited.',
          body: z
            .strictObject({
              name: z.string().trim().min(1, 'name is required').max(100).describe('Account holder name, 1–100 characters'),
            })
            .meta({ examples: [{ name: 'Asha Rao' }] }),
          response: {
            201: ok('The new account', accountSchema, {
              id: EXAMPLE_ACCOUNT_ID,
              name: 'Asha Rao',
              balance: 0,
              created_at: '2026-10-28T10:06:50.106Z',
            }),
            400: errorResponse('The request body is invalid', {
              missingName: {
                summary: 'Name missing or blank',
                code: 'VALIDATION_ERROR',
                message: 'Invalid body',
                details: { issues: [{ field: 'name', message: 'name is required' }] },
              },
              balanceSent: {
                summary: 'Tried to set a balance',
                code: 'VALIDATION_ERROR',
                message: 'Invalid body',
                details: { issues: [{ field: null, message: 'Unrecognized key: "balance"' }] },
              },
            }),
          },
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
          tags: ['Accounts'],
          operationId: 'getBalance',
          summary: 'Get an account balance',
          description:
            'Returns the current balance in paise. The balance always equals the sum of the account’s credits minus its debits.',
          params: accountIdParams,
          response: {
            200: ok(
              'The current balance',
              z.object({ account_id: z.string(), balance: z.number().describe('Balance in paise') }),
              { account_id: EXAMPLE_ACCOUNT_ID, balance: 15050 },
            ),
            404: errorResponse('The account does not exist', { notFound: accountNotFoundExample }),
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
