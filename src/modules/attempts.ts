import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Db, DbClient } from '../db.js';
import { newId } from '../ids.js';
import {
  accountIdParams,
  errorResponseSchema,
  pageMeta,
  paginationMeta,
  paginationQuery,
  transactionTypeSchema,
} from '../schemas.js';
import { assertAccountExists } from './accounts.js';

// Attempts are the audit log of money movements the ledger refused. They never
// touch the balance and never appear in transaction history (like a bank's
// internal log vs. the official statement).

export const attemptSchema = z.object({
  id: z.string(),
  account_id: z.string(),
  type: transactionTypeSchema,
  amount: z.number(),
  description: z.string().nullable(),
  reference_id: z.string(),
  reason_code: z.string().describe('Why it was refused, e.g. INSUFFICIENT_BALANCE'),
  balance_at_attempt: z.number().describe('Account balance when the attempt was refused'),
  transfer_to_account_id: z.string().nullable().describe('Destination account when the attempt was a transfer'),
  created_at: z.string(),
});

interface AttemptRow extends Omit<z.infer<typeof attemptSchema>, 'created_at'> {
  created_at: Date;
}

export async function recordAttempt(
  client: DbClient,
  attempt: {
    accountId: string;
    type: 'credit' | 'debit';
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
          tags: ['attempts'],
          summary: 'List refused money movements (audit log) for an account, newest first',
          params: accountIdParams,
          querystring: paginationQuery,
          response: {
            200: z.object({ data: z.array(attemptSchema), pagination: paginationMeta }),
            400: errorResponseSchema,
            404: errorResponseSchema,
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
