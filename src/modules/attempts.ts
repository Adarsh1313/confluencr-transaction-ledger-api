import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Db, DbClient } from '../db.js';
import { newId } from '../ids.js';
import {
  accountIdParams,
  accountNotFoundExample,
  EXAMPLE_ACCOUNT_ID,
  errorResponse,
  ok,
  pageMeta,
  paginationErrorExample,
  paginationMeta,
  paginationQuery,
  transactionTypeSchema,
  type TransactionType,
} from '../schemas.js';
import { assertAccountExists } from './accounts.js';

// Attempts are the audit log of money movements the ledger refused. They never
// touch the balance and never appear in transaction history (like a bank's
// internal log vs. the official statement).

export const attemptSchema = z
  .object({
    id: z.string().describe('Unique attempt ID, prefixed `att_`'),
    account_id: z.string().describe('The account the money would have left'),
    type: transactionTypeSchema.describe('Always `debit` today: only debits can be refused for balance'),
    amount: z.number().describe('The refused amount, in paise'),
    description: z.string().nullable().describe('The note sent with the request, or null'),
    reference_id: z.string().describe('The reference_id sent with the request. It stays free to retry.'),
    reason_code: z.string().describe('Why it was refused, e.g. `INSUFFICIENT_BALANCE`'),
    balance_at_attempt: z.number().describe('The balance when it was refused, in paise'),
    transfer_to_account_id: z.string().nullable().describe('The destination, when the attempt was a transfer'),
    created_at: z.string().describe('When it was refused (ISO 8601, UTC)'),
  })
  .meta({ id: 'Attempt', description: 'A debit or transfer the ledger refused. Never affects a balance.' });

interface AttemptRow extends Omit<z.infer<typeof attemptSchema>, 'created_at'> {
  created_at: Date;
}

export async function recordAttempt(
  client: DbClient,
  attempt: {
    accountId: string;
    type: TransactionType;
    amount: number;
    referenceId: string;
    description?: string | null;
    reasonCode: string;
    balanceAtAttempt: number;
    transferToAccountId?: string;
  },
) {
  await client.query(
    `INSERT INTO transaction_attempts
       (id, account_id, type, amount, description, reference_id, reason_code, balance_at_attempt, transfer_to_account_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      newId('att'),
      attempt.accountId,
      attempt.type,
      attempt.amount,
      attempt.description ?? null,
      attempt.referenceId,
      attempt.reasonCode,
      attempt.balanceAtAttempt,
      attempt.transferToAccountId ?? null,
    ],
  );
}

export const attemptRoutes =
  (db: Db): FastifyPluginAsyncZod =>
  async (app) => {
    app.get(
      '/accounts/:id/attempts',
      {
        schema: {
          tags: ['Attempts'],
          operationId: 'listAttempts',
          summary: 'List an account’s refused debits',
          description:
            'The audit log of debits and transfers that were refused, newest first. Use it to show customers a “Failed” item, or for support and fraud checks. Malformed requests are not logged here.',
          params: accountIdParams,
          querystring: paginationQuery,
          response: {
            200: ok(
              'One page of attempts, newest first',
              z.object({ data: z.array(attemptSchema), pagination: paginationMeta }),
              {
                data: [
                  {
                    id: 'att_Xp5Cw9Rk2Dm7Hs0Fv3Jn',
                    account_id: EXAMPLE_ACCOUNT_ID,
                    type: 'debit',
                    amount: 15000,
                    description: 'November rent',
                    reference_id: 'rent-nov',
                    reason_code: 'INSUFFICIENT_BALANCE',
                    balance_at_attempt: 10000,
                    transfer_to_account_id: null,
                    created_at: '2026-10-28T12:41:09.002Z',
                  },
                ],
                pagination: { page: 1, limit: 20, total_records: 1, total_pages: 1 },
              },
            ),
            400: errorResponse('A query parameter is invalid', { pagination: paginationErrorExample }),
            404: errorResponse('The account does not exist', { notFound: accountNotFoundExample }),
          },
        },
      },
      async (request) => {
        const { id } = request.params;
        const { page, limit } = request.query;
        await assertAccountExists(db, id);
        const [{ rows }, count] = await Promise.all([
          db.query<AttemptRow>(
            `SELECT * FROM transaction_attempts WHERE account_id = $1
             ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
            [id, limit, (page - 1) * limit],
          ),
          db.query<{ total: number }>(
            'SELECT count(*)::bigint AS total FROM transaction_attempts WHERE account_id = $1',
            [id],
          ),
        ]);
        return {
          data: rows.map((row) => ({ ...row, created_at: row.created_at.toISOString() })),
          pagination: pageMeta(page, limit, count.rows[0].total),
        };
      },
    );
  };
