import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { isUniqueViolation, withDatabaseTransaction, type Db, type DbClient } from '../db.js';
import { AppError, insufficientBalance } from '../errors.js';
import { newId } from '../ids.js';
import {
  accountNotFoundExample,
  amountSchema,
  descriptionSchema,
  EXAMPLE_ACCOUNT_ID,
  errorResponse,
  ok,
  referenceIdSchema,
} from '../schemas.js';
import { lockAccount } from './accounts.js';
import { recordAttempt } from './attempts.js';
import { applyToBalance, insertTransaction } from './transactions.js';

export const transferSchema = z
  .object({
    id: z.string().describe('Unique transfer ID, prefixed `trf_`'),
    from_account_id: z.string().describe('The account the money left'),
    to_account_id: z.string().describe('The account the money went to'),
    amount: z.number().describe('Amount in paise'),
    description: z.string().nullable().describe('Your note, or null'),
    reference_id: z.string().describe('Your idempotency key, unique per source account'),
    debit_transaction_id: z.string().describe('The debit recorded on the source account'),
    credit_transaction_id: z.string().describe('The credit recorded on the destination account'),
    created_at: z.string().describe('When it was recorded (ISO 8601, UTC)'),
  })
  .meta({ id: 'Transfer', description: 'Money moved between two accounts: one debit and one credit, recorded together.' });

type Transfer = z.infer<typeof transferSchema>;

const EXAMPLE_DESTINATION_ID = 'acc_9Tn6Bq2Wy8Lc4Mx1Pz7G';

const EXAMPLE_TRANSFER: Transfer = {
  id: 'trf_2Vk8Ns5Qa1Hd9Jy3Rw6E',
  from_account_id: EXAMPLE_ACCOUNT_ID,
  to_account_id: EXAMPLE_DESTINATION_ID,
  amount: 3000,
  description: 'Dinner split',
  reference_id: 'split-dinner',
  debit_transaction_id: 'txn_5Gm1Xc8Rt3Vb0Lp6Qz9W',
  credit_transaction_id: 'txn_7Kd4Yh2Ns9Fq1Wm5Tc8B',
  created_at: '2026-10-28T13:02:44.517Z',
};

interface TransferRow extends Omit<Transfer, 'created_at'> {
  created_at: Date;
}

const SELECT_TRANSFER = `
  SELECT t.*,
         (SELECT id FROM transactions WHERE transfer_id = t.id AND type = 'debit')  AS debit_transaction_id,
         (SELECT id FROM transactions WHERE transfer_id = t.id AND type = 'credit') AS credit_transaction_id
  FROM transfers t`;

async function findTransfer(client: DbClient | Db, where: string, params: unknown[]) {
  const { rows } = await client.query<TransferRow>(`${SELECT_TRANSFER} WHERE ${where}`, params);
  return rows[0] ? { ...rows[0], created_at: rows[0].created_at.toISOString() } : undefined;
}

const duplicateTransfer = (existing: Transfer) =>
  new AppError(
    409,
    'DUPLICATE_TRANSFER',
    `A transfer with reference_id "${existing.reference_id}" already exists for this source account`,
    { transfer: existing },
  );

type TransferResult =
  | { kind: 'created'; transfer: Transfer }
  | { kind: 'duplicate'; transfer: Transfer }
  | { kind: 'insufficient'; balance: number };

interface TransferInput {
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  referenceId: string;
  description?: string;
}

/**
 * Moves money between two accounts in ONE database transaction: the Transfer
 * row, the Debit on the source and the Credit on the destination either all
 * commit or none do, so a partial Transfer is impossible.
 */
async function createTransfer(db: Db, input: TransferInput): Promise<Transfer> {
  let result: TransferResult;
  try {
    result = await withDatabaseTransaction(db, async (client): Promise<TransferResult> => {
      // Always lock in the same (sorted) order. If A→B locked A then B while
      // B→A locked B then A, each could wait for the other forever (deadlock).
      const [firstId, secondId] = [input.fromAccountId, input.toAccountId].sort();
      const locked = new Map([
        [firstId, await lockAccount(client, firstId)],
        [secondId, await lockAccount(client, secondId)],
      ]);
      const from = locked.get(input.fromAccountId)!;
      const to = locked.get(input.toAccountId)!;

      // Checked after locking so a missing account is reported as 404 first.
      if (from.id === to.id) {
        throw new AppError(422, 'SAME_ACCOUNT_TRANSFER', 'Source and destination accounts must be different', {
          account_id: from.id,
        });
      }

      const existing = await findTransfer(client, 't.from_account_id = $1 AND t.reference_id = $2', [
        input.fromAccountId,
        input.referenceId,
      ]);
      if (existing) return { kind: 'duplicate', transfer: existing };

      if (from.balance < input.amount) {
        await recordAttempt(client, {
          accountId: from.id,
          type: 'debit',
          amount: input.amount,
          referenceId: input.referenceId,
          description: input.description,
          reasonCode: 'INSUFFICIENT_BALANCE',
          balanceAtAttempt: from.balance,
          transferToAccountId: to.id,
        });
        return { kind: 'insufficient', balance: from.balance };
      }

      const transferId = newId('trf');
      await client.query(
        `INSERT INTO transfers (id, from_account_id, to_account_id, amount, description, reference_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [transferId, from.id, to.id, input.amount, input.description ?? null, input.referenceId],
      );
      // Each half gets a reserved, per-account reference so it can never clash with a client's own.
      const legReference = `transfer:${transferId}`;
      await insertTransaction(client, {
        accountId: from.id,
        type: 'debit',
        amount: input.amount,
        balanceAfter: applyToBalance(from.balance, 'debit', input.amount),
        referenceId: legReference,
        description: input.description,
        transferId,
      });
      await insertTransaction(client, {
        accountId: to.id,
        type: 'credit',
        amount: input.amount,
        balanceAfter: applyToBalance(to.balance, 'credit', input.amount),
        referenceId: legReference,
        description: input.description,
        transferId,
      });

      return { kind: 'created', transfer: (await findTransfer(client, 't.id = $1', [transferId]))! };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await findTransfer(db, 't.from_account_id = $1 AND t.reference_id = $2', [
        input.fromAccountId,
        input.referenceId,
      ]);
      if (existing) throw duplicateTransfer(existing);
    }
    throw error;
  }

  if (result.kind === 'duplicate') throw duplicateTransfer(result.transfer);
  if (result.kind === 'insufficient') throw insufficientBalance(input.fromAccountId, result.balance, input.amount);
  return result.transfer;
}

export const transferRoutes =
  (db: Db): FastifyPluginAsyncZod =>
  async (app) => {
    app.post(
      '/transfers',
      {
        schema: {
          tags: ['Transfers'],
          operationId: 'createTransfer',
          summary: 'Transfer money between accounts',
          description: [
            'Moves `amount` from one account to another. A debit on the source and a credit on the destination are recorded **together or not at all**: a half-finished transfer is impossible.',
            '',
            'Both transactions appear in each account’s history with the same `transfer_id`. The `reference_id` is unique per source account, so retrying a transfer never moves money twice.',
          ].join('\n'),
          body: z
            .strictObject({
              from_account_id: z.string().min(1).describe('The account to take money from'),
              to_account_id: z.string().min(1).describe('The account to send money to. Must be different.'),
              amount: amountSchema,
              reference_id: referenceIdSchema.describe('Your idempotency key, unique per source account'),
              description: descriptionSchema,
            })
            .meta({
              examples: [
                {
                  from_account_id: EXAMPLE_ACCOUNT_ID,
                  to_account_id: EXAMPLE_DESTINATION_ID,
                  amount: 3000,
                  reference_id: 'split-dinner',
                  description: 'Dinner split',
                },
              ],
            }),
          response: {
            201: ok('The completed transfer, with both transaction IDs', transferSchema, EXAMPLE_TRANSFER),
            400: errorResponse('The request body is invalid', {
              missingField: {
                summary: 'A required field is missing',
                code: 'VALIDATION_ERROR',
                message: 'Invalid body',
                details: { issues: [{ field: 'to_account_id', message: 'Invalid input: expected string, received undefined' }] },
              },
            }),
            404: errorResponse('One of the accounts does not exist. Nothing changed.', { notFound: accountNotFoundExample }),
            409: errorResponse('This reference_id was already used for a transfer from this account. Nothing changed.', {
              duplicate: {
                summary: 'Retry of a completed transfer',
                code: 'DUPLICATE_TRANSFER',
                message: 'A transfer with reference_id "split-dinner" already exists for this source account',
                details: { transfer: EXAMPLE_TRANSFER },
              },
            }),
            422: errorResponse('The transfer cannot be made. Nothing changed.', {
              insufficient: {
                summary: 'Source has too little money',
                code: 'INSUFFICIENT_BALANCE',
                message: 'Balance 2000 is less than debit 3000',
                details: { account_id: EXAMPLE_ACCOUNT_ID, balance: 2000, amount: 3000 },
              },
              sameAccount: {
                summary: 'Source and destination are the same',
                code: 'SAME_ACCOUNT_TRANSFER',
                message: 'Source and destination accounts must be different',
                details: { account_id: EXAMPLE_ACCOUNT_ID },
              },
            }),
          },
        },
      },
      async (request, reply) => {
        const transfer = await createTransfer(db, {
          fromAccountId: request.body.from_account_id,
          toAccountId: request.body.to_account_id,
          amount: request.body.amount,
          referenceId: request.body.reference_id,
          description: request.body.description,
        });
        return reply.status(201).send(transfer);
      },
    );

    app.get(
      '/transfers/:id',
      {
        schema: {
          tags: ['Transfers'],
          operationId: 'getTransfer',
          summary: 'Get a transfer',
          description: 'Returns one transfer, including the IDs of its debit and credit transactions.',
          params: z.object({ id: z.string().min(1).describe('The transfer ID, e.g. `trf_2Vk8Ns5Qa1Hd9Jy3Rw6E`') }),
          response: {
            200: ok('The transfer', transferSchema, EXAMPLE_TRANSFER),
            404: errorResponse('The transfer does not exist', {
              notFound: {
                summary: 'Transfer does not exist',
                code: 'TRANSFER_NOT_FOUND',
                message: 'Transfer trf_doesNotExist0000000 does not exist',
                details: { transfer_id: 'trf_doesNotExist0000000' },
              },
            }),
          },
        },
      },
      async (request) => {
        const transfer = await findTransfer(db, 't.id = $1', [request.params.id]);
        if (!transfer) {
          throw new AppError(404, 'TRANSFER_NOT_FOUND', `Transfer ${request.params.id} does not exist`, {
            transfer_id: request.params.id,
          });
        }
        return transfer;
      },
    );
  };
