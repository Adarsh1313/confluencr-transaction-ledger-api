import { describe, expect, it } from 'vitest';
import { useTestApp } from './helpers.js';

const ctx = useTestApp();

// These tests talk to Postgres directly on purpose: they prove the database
// itself enforces the rules, even for someone bypassing the API.
describe('database-level integrity', () => {
  async function seedTransaction() {
    const db = ctx.db();
    await db.query("INSERT INTO accounts (id, name) VALUES ('acc_seed', 'Seed')");
    await db.query(
      `INSERT INTO transactions (id, account_id, type, amount, reference_id, balance_after)
       VALUES ('txn_seed', 'acc_seed', 'credit', 100, 'ref-1', 100)`,
    );
  }

  it('refuses to UPDATE a transaction', async () => {
    await seedTransaction();
    await expect(ctx.db().query("UPDATE transactions SET amount = 999 WHERE id = 'txn_seed'")).rejects.toThrow(
      /immutable/,
    );
  });

  it('refuses to DELETE a transaction', async () => {
    await seedTransaction();
    await expect(ctx.db().query("DELETE FROM transactions WHERE id = 'txn_seed'")).rejects.toThrow(/immutable/);
  });

  it('refuses a negative account balance', async () => {
    await ctx.db().query("INSERT INTO accounts (id, name) VALUES ('acc_neg', 'Neg')");
    await expect(ctx.db().query("UPDATE accounts SET balance = -1 WHERE id = 'acc_neg'")).rejects.toThrow(
      /balance_non_negative/,
    );
  });

  it('refuses a duplicate reference_id on the same account', async () => {
    await seedTransaction();
    await expect(
      ctx.db().query(
        `INSERT INTO transactions (id, account_id, type, amount, reference_id, balance_after)
         VALUES ('txn_dup', 'acc_seed', 'credit', 5, 'ref-1', 105)`,
      ),
    ).rejects.toThrow(/transactions_account_reference_unique/);
  });

  it('refuses a non-positive amount and an unknown type', async () => {
    await ctx.db().query("INSERT INTO accounts (id, name) VALUES ('acc_x', 'X')");
    const insert = (type: string, amount: number) =>
      ctx.db().query(
        `INSERT INTO transactions (id, account_id, type, amount, reference_id, balance_after)
         VALUES ($1, 'acc_x', $2, $3, $1, 0)`,
        [`txn_${type}_${amount}`, type, amount],
      );
    await expect(insert('credit', 0)).rejects.toThrow(/amount_positive/);
    await expect(insert('refund', 10)).rejects.toThrow(/type_valid/);
  });
});
