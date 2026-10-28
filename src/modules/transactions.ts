import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { isUniqueViolation, withDatabaseTransaction, type Db, type DbClient } from '../db.js';
import { AppError, insufficientBalance } from '../errors.js';
import { newId } from '../ids.js';
import {
  accountIdParams,
  accountNotFoundExample,
  amountSchema,
  descriptionSchema,
  EXAMPLE_ACCOUNT_ID,
  errorResponse,
  ok,
  pageMeta,
  paginationErrorExample,
  paginationMeta,
  paginationQuery,
  referenceIdSchema,
  transactionTypeSchema,
  type TransactionType,
} from '../schemas.js';
import { assertAccountExists, lockAccount } from './accounts.js';
import { recordAttempt } from './attempts.js';

export const transactionSchema = z
  .object({
    id: z.string().describe('Unique transaction ID, prefixed `txn_`'),
    account_id: z.string().describe('The account this transaction belongs to'),
    type: transactionTypeSchema.describe('`credit` adds to the balance, `debit` subtracts from it'),
    amount: z.number().describe('Amount in paise'),
    description: z.string().nullable().describe('Your note, or null'),
    reference_id: z.string().describe('Your idempotency key, unique per account'),
    balance_after: z.number().describe('The account balance right after this transaction, in paise'),
    transfer_id: z.string().nullable().describe('The transfer this is one half of, or null'),
    created_at: z.string().describe('When it was recorded (ISO 8601, UTC)'),
  })
  .meta({ id: 'Transaction', description: 'One credit or debit on one account. Never edited or deleted.' });

const EXAMPLE_TRANSACTION: Transaction = {
  id: 'txn_8Hq3ZkW1nVb6RtY0pLs2',
  account_id: EXAMPLE_ACCOUNT_ID,
  type: 'credit',
  amount: 15050,
  description: 'October salary',
  reference_id: 'salary-oct',
  balance_after: 15050,
  transfer_id: null,
  created_at: '2026-10-28T10:06:50.781Z',
};

export type Transaction = z.infer<typeof transactionSchema>;

interface TransactionRow extends Omit<Transaction, 'created_at'> {
  created_at: Date;
}

export const toTransaction = (row: TransactionRow): Transaction => ({
  ...row,
  created_at: row.created_at.toISOString(),
});

/** The one balance rule: a Credit adds the amount, a Debit subtracts it. */
export const applyToBalance = (balance: number, type: TransactionType, amount: number) =>
  type === 'credit' ? balance + amount : balance - amount;

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

/** Inserts one Transaction and moves the account balance. Caller must hold the account lock. */
export async function insertTransaction(
  client: DbClient,
  input: {
    accountId: string;
    type: TransactionType;
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
      input.accountId,
      input.type,
      input.amount,
      input.description ?? null,
      input.referenceId,
      input.balanceAfter,
      input.transferId ?? null,
    ],
  );
  await client.query('UPDATE accounts SET balance = $1 WHERE id = $2', [input.balanceAfter, input.accountId]);
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
  input: { accountId: string; type: TransactionType; amount: number; referenceId: string; description?: string },
): Promise<Transaction> {
  let result: PostResult;
  try {
    result = await withDatabaseTransaction(db, async (client): Promise<PostResult> => {
      const account = await lockAccount(client, input.accountId);

      const existing = await findByReference(client, input.accountId, input.referenceId);
      if (existing) return { kind: 'duplicate', transaction: existing };

      const balanceAfter = applyToBalance(account.balance, input.type, input.amount);
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
    if (isUniqueViolation(error)) {
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
          tags: ['Transactions'],
          operationId: 'createTransaction',
          summary: 'Record a credit or debit',
          description: [
            'A **credit** adds the amount to the balance; a **debit** subtracts it. The transaction and the new balance are saved together, or not at all.',
            '',
            '- **Not enough money:** a debit larger than the balance returns `422 INSUFFICIENT_BALANCE`. Nothing changes, and the refusal is logged under attempts.',
            '- **Retries are safe:** sending the same `reference_id` to the same account again returns `409 DUPLICATE_TRANSACTION` with the original transaction. Nothing changes.',
            '- **Simultaneous requests** on one account are processed one at a time, so two debits can never spend the same money.',
          ].join('\n'),
          params: accountIdParams,
          body: z
            .strictObject({
              type: transactionTypeSchema.describe('`credit` or `debit`'),
              amount: amountSchema,
              reference_id: referenceIdSchema,
              description: descriptionSchema,
            })
            .meta({
              examples: [{ type: 'credit', amount: 15050, reference_id: 'salary-oct', description: 'October salary' }],
            }),
          response: {
            201: ok('The recorded transaction, with the new balance in `balance_after`', transactionSchema, EXAMPLE_TRANSACTION),
            400: errorResponse('The request body is invalid', {
              badAmount: {
                summary: 'Amount is zero, negative or not whole',
                code: 'VALIDATION_ERROR',
                message: 'Invalid body',
                details: { issues: [{ field: 'amount', message: 'amount must be greater than 0' }] },
              },
              badType: {
                summary: 'Type is not credit or debit',
                code: 'VALIDATION_ERROR',
                message: 'Invalid body',
                details: { issues: [{ field: 'type', message: 'Invalid option: expected one of "credit"|"debit"' }] },
              },
              malformed: { summary: 'Body is not valid JSON', code: 'INVALID_REQUEST_BODY', message: 'Body is not valid JSON but content-type is set to \'application/json\'' },
            }),
            404: errorResponse('The account does not exist', { notFound: accountNotFoundExample }),
            409: errorResponse('This reference_id was already used on this account. Nothing changed.', {
              duplicate: {
                summary: 'Retry of a recorded transaction',
                code: 'DUPLICATE_TRANSACTION',
                message: 'A transaction with reference_id "salary-oct" already exists for this account',
                details: { transaction: EXAMPLE_TRANSACTION },
              },
            }),
            422: errorResponse('The debit is larger than the balance. Nothing changed.', {
              insufficient: {
                summary: 'Not enough money',
                code: 'INSUFFICIENT_BALANCE',
                message: 'Balance 10000 is less than debit 15000',
                details: { account_id: EXAMPLE_ACCOUNT_ID, balance: 10000, amount: 15000 },
              },
              limit: {
                summary: 'Credit would exceed the maximum balance',
                code: 'BALANCE_LIMIT_EXCEEDED',
                message: 'This credit would take the balance above the maximum allowed',
              },
            }),
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
          tags: ['Transactions'],
          operationId: 'listTransactions',
          summary: 'List an account’s transactions',
          description:
            'Returns the account’s transactions **newest first**, one page at a time. Filter with `type`, page with `page` and `limit`. Refused debits are not included; see attempts.',
          params: accountIdParams,
          querystring: paginationQuery.extend({
            type: transactionTypeSchema.optional().describe('Only `credit` or only `debit`. Omit for both.'),
          }),
          response: {
            200: ok(
              'One page of transactions, newest first',
              z.object({ data: z.array(transactionSchema), pagination: paginationMeta }),
              {
                data: [
                  { ...EXAMPLE_TRANSACTION, id: 'txn_Qm2Lr7Vx0Ny4Tz8Bc1Ks', type: 'debit', amount: 3000, description: 'Groceries', reference_id: 'groceries-1', balance_after: 12050, created_at: '2026-10-28T11:20:04.310Z' },
                  EXAMPLE_TRANSACTION,
                ],
                pagination: { page: 1, limit: 20, total_records: 2, total_pages: 1 },
              },
            ),
            400: errorResponse('A query parameter is invalid', {
              pagination: paginationErrorExample,
              badType: {
                summary: 'Unknown type filter',
                code: 'VALIDATION_ERROR',
                message: 'Invalid querystring',
                details: { issues: [{ field: 'type', message: 'Invalid option: expected one of "credit"|"debit"' }] },
              },
            }),
            404: errorResponse('The account does not exist', { notFound: accountNotFoundExample }),
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
