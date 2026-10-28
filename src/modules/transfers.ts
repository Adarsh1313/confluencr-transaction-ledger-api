import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { withDatabaseTransaction, type Db, type DbClient } from '../db.js';
import { AppError, insufficientBalance } from '../errors.js';
import { newId } from '../ids.js';
import { amountSchema, descriptionSchema, errorResponseSchema, referenceIdSchema } from '../schemas.js';
import { lockAccount } from './accounts.js';
import { recordAttempt } from './attempts.js';
import { insertTransaction } from './transactions.js';

export const transferSchema = z.object({
  id: z.string(),
  from_account_id: z.string(),
  to_account_id: z.string(),
  amount: z.number().describe('Amount in paise'),
  description: z.string().nullable(),
  reference_id: z.string(),
  debit_transaction_id: z.string().describe('The debit on the source account'),
  credit_transaction_id: z.string().describe('The credit on the destination account'),
  created_at: z.string(),
});

type Transfer = z.infer<typeof transferSchema>;

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

const UNIQUE_VIOLATION = '23505';

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
 * Moves money between two accounts in ONE database transaction: the transfer
 * record, the debit on the source and the credit on the destination either all
 * commit or none do, so a partial transfer is impossible.
 */
async function createTransfer(db: Db, input: TransferInput): Promise<Transfer> {
  if (input.fromAccountId === input.toAccountId) {
    throw new AppError(422, 'SAME_ACCOUNT_TRANSFER', 'Source and destination accounts must be different', {
      account_id: input.fromAccountId,
    });
  }

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
        balanceAfter: from.balance - input.amount,
        referenceId: legReference,
        description: input.description,
        transferId,
      });
      await insertTransaction(client, {
        accountId: to.id,
        type: 'credit',
        amount: input.amount,
        balanceAfter: to.balance + input.amount,
        referenceId: legReference,
        description: input.description,
        transferId,
      });

      return { kind: 'created', transfer: (await findTransfer(client, 't.id = $1', [transferId]))! };
    });
  } catch (error) {
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
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
          tags: ['transfers'],
          summary: 'Transfer money from one account to another, atomically',
          description:
            'Debits the source and credits the destination in one database transaction. If anything fails, nothing changes. reference_id is unique per source account.',
          body: z.strictObject({
            from_account_id: z.string().min(1),
            to_account_id: z.string().min(1),
            amount: amountSchema,
            reference_id: referenceIdSchema,
            description: descriptionSchema,
          }),
          response: {
            201: transferSchema,
            400: errorResponseSchema,
            404: errorResponseSchema,
            409: errorResponseSchema,
            422: errorResponseSchema,
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
          tags: ['transfers'],
          summary: 'Get a transfer by id',
          params: z.object({ id: z.string().min(1).describe('Transfer ID, e.g. trf_…') }),
          response: { 200: transferSchema, 404: errorResponseSchema },
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
