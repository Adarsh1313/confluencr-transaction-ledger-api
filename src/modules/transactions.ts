import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withDatabaseTransaction, type Db, type DbClient } from '../db.js';
import { AppError, insufficientBalance } from '../errors.js';
import { newId } from '../ids.js';
import {
  accountIdParams,
  amountSchema,
  descriptionSchema,
  errorResponseSchema,
  pageMeta,
  paginationMeta,
  paginationQuery,
  referenceIdSchema,
  transactionTypeSchema,
} from '../schemas.js';
import { assertAccountExists, lockAccount } from './accounts.js';
import { recordAttempt } from './attempts.js';

export const transactionSchema = z.object({
  id: z.string(),
  account_id: z.string(),
  type: transactionTypeSchema,
  amount: z.number().describe('Amount in paise'),
  description: z.string().nullable(),
  reference_id: z.string(),
  balance_after: z.number().describe('Account balance right after this transaction, in paise'),
  transfer_id: z.string().nullable().describe('Set when this transaction is one half of a transfer'),
  created_at: z.string(),
});

export type Transaction = z.infer<typeof transactionSchema>;

interface TransactionRow extends Omit<Transaction, 'created_at'> {
  created_at: Date;
}

export const toTransaction = (row: TransactionRow): Transaction => ({
  ...row,
  created_at: row.created_at.toISOString(),
});

const UNIQUE_VIOLATION = '23505';

const duplicateTransaction = (existing: Transaction) =>
  new AppError(
    409,
    'DUPLICATE_TRANSACTION',
    `A transaction with reference_id "${existing.reference_id}" already exists for this account`,
    { transaction: existing },
  );

async function findByReference(client: DbClient | Db, accountId: string, referenceId: string) {
  const { rows } = await client.query<TransactionRow>(
    'SELECT * FROM transactions WHERE account_id = $1 AND reference_id = $2',
    [accountId, referenceId],
  );
  return rows[0] ? toTransaction(rows[0]) : undefined;
}

/** Inserts one ledger entry and moves the account balance. Caller must hold the account lock. */
export async function insertTransaction(
  client: DbClient,
  entry: {
    accountId: string;
    type: 'credit' | 'debit';
    amount: number;
    balanceAfter: number;
    referenceId: string;
    description?: string | null;
    transferId?: string | null;
  },
): Promise<Transaction> {
  const { rows } = await client.query<TransactionRow>(
    `INSERT INTO transactions (id, account_id, type, amount, description, reference_id, balance_after, transfer_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      newId('txn'),
      entry.accountId,
      entry.type,
      entry.amount,
      entry.description ?? null,
      entry.referenceId,
      entry.balanceAfter,
      entry.transferId ?? null,
    ],
  );
  await client.query('UPDATE accounts SET balance = $1 WHERE id = $2', [entry.balanceAfter, entry.accountId]);
  return toTransaction(rows[0]);
}

type PostResult =
  | { kind: 'created'; transaction: Transaction }
  | { kind: 'duplicate'; transaction: Transaction }
  | { kind: 'insufficient'; balance: number };

/**
 * Posts a credit or debit. Everything happens inside one database transaction
 * while holding the account's row lock, so concurrent requests on the same
 * account run one after another ("one teller per account").
 */
async function postTransaction(
  db: Db,
  input: { accountId: string; type: 'credit' | 'debit'; amount: number; referenceId: string; description?: string },
): Promise<Transaction> {
  let result: PostResult;
  try {
    result = await withDatabaseTransaction(db, async (client): Promise<PostResult> => {
      const account = await lockAccount(client, input.accountId);

      const existing = await findByReference(client, input.accountId, input.referenceId);
      if (existing) return { kind: 'duplicate', transaction: existing };

      const balanceAfter = input.type === 'credit' ? account.balance + input.amount : account.balance - input.amount;
      if (balanceAfter < 0) {
        // Not a money movement: record it in the audit log and commit only that.
        await recordAttempt(client, {
          accountId: input.accountId,
          type: input.type,
          amount: input.amount,
          referenceId: input.referenceId,
          description: input.description,
          reasonCode: 'INSUFFICIENT_BALANCE',
          balanceAtAttempt: account.balance,
        });
        return { kind: 'insufficient', balance: account.balance };
      }

      const transaction = await insertTransaction(client, { ...input, balanceAfter });
      return { kind: 'created', transaction };
    });
  } catch (error) {
    // Last line of defence: the UNIQUE constraint caught a duplicate that slipped past the check.
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
      const existing = await findByReference(db, input.accountId, input.referenceId);
      if (existing) throw duplicateTransaction(existing);
    }
    throw error;
  }

  if (result.kind === 'duplicate') throw duplicateTransaction(result.transaction);
  if (result.kind === 'insufficient') throw insufficientBalance(input.accountId, result.balance, input.amount);
  return result.transaction;
}

export const transactionRoutes =
  (db: Db): FastifyPluginAsyncZod =>
  async (app) => {
    app.post(
      '/accounts/:id/transactions',
      {
        schema: {
          tags: ['transactions'],
          summary: 'Post a credit or debit to an account',
          description:
            'Credit increases the balance, debit decreases it. A debit larger than the balance is rejected (422) and recorded as an attempt. Re-sending the same reference_id for the same account returns 409 with the original transaction and changes nothing.',
          params: accountIdParams,
          body: z.strictObject({
            type: transactionTypeSchema,
            amount: amountSchema,
            reference_id: referenceIdSchema,
            description: descriptionSchema,
          }),
          response: {
            201: transactionSchema,
            400: errorResponseSchema,
            404: errorResponseSchema,
            409: errorResponseSchema,
            422: errorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const transaction = await postTransaction(db, {
          accountId: request.params.id,
          type: request.body.type,
          amount: request.body.amount,
          referenceId: request.body.reference_id,
          description: request.body.description,
        });
        return reply.status(201).send(transaction);
      },
    );

    app.get(
      '/accounts/:id/transactions',
      {
        schema: {
          tags: ['transactions'],
          summary: 'List transactions for an account, newest first',
          params: accountIdParams,
          querystring: paginationQuery.extend({
            type: transactionTypeSchema.optional().describe('Filter by credit or debit; omit for both'),
          }),
          response: {
            200: z.object({ data: z.array(transactionSchema), pagination: paginationMeta }),
            400: errorResponseSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (request) => {
        const { id } = request.params;
        const { page, limit, type } = request.query;
        await assertAccountExists(db, id);

        const filter = type ? 'AND type = $2' : '';
        const filterParams = type ? [id, type] : [id];
        const [{ rows }, count] = await Promise.all([
          db.query<TransactionRow>(
            `SELECT * FROM transactions WHERE account_id = $1 ${filter}
             ORDER BY created_at DESC, id DESC
             LIMIT $${filterParams.length + 1} OFFSET $${filterParams.length + 2}`,
            [...filterParams, limit, (page - 1) * limit],
          ),
          db.query<{ total: number }>(
            `SELECT count(*)::bigint AS total FROM transactions WHERE account_id = $1 ${filter}`,
            filterParams,
          ),
        ]);
        return { data: rows.map(toTransaction), pagination: pageMeta(page, limit, count.rows[0].total) };
      },
    );
  };
