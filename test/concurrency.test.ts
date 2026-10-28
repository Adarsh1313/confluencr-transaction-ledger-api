import { describe, expect, it } from 'vitest';
import { useTestApp } from './helpers.js';

const ctx = useTestApp();

async function accountWith(balance: number) {
  const id = (await ctx.app().inject({ method: 'POST', url: '/api/v1/accounts', payload: { name: 'C' } })).json()
    .id as string;
  if (balance > 0) {
    await ctx.app().inject({
      method: 'POST',
      url: `/api/v1/accounts/${id}/transactions`,
      payload: { type: 'credit', amount: balance, reference_id: 'opening' },
    });
  }
  return id;
}

const balanceOf = async (id: string) =>
  (await ctx.app().inject({ method: 'GET', url: `/api/v1/accounts/${id}/balance` })).json().balance as number;

/** Independent check: recompute the balance from the ledger rows themselves. */
async function ledgerSum(id: string) {
  const { rows } = await ctx.db().query<{ sum: number }>(
    `SELECT COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE -amount END), 0)::bigint AS sum
     FROM transactions WHERE account_id = $1`,
    [id],
  );
  return rows[0].sum;
}

describe('concurrency and consistency', () => {
  it('20 simultaneous debits of 10 against a balance of 100: exactly 10 succeed, balance ends at 0', async () => {
    const id = await accountWith(100);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        ctx.app().inject({
          method: 'POST',
          url: `/api/v1/accounts/${id}/transactions`,
          payload: { type: 'debit', amount: 10, reference_id: `burst-${i}` },
        }),
      ),
    );
    const statuses = results.map((r) => r.statusCode);
    expect(statuses.filter((s) => s === 201)).toHaveLength(10);
    expect(statuses.filter((s) => s === 422)).toHaveLength(10);
    expect(await balanceOf(id)).toBe(0);
    expect(await ledgerSum(id)).toBe(0);
  });

  it('the same reference_id sent 10 times at once creates exactly one transaction', async () => {
    const id = await accountWith(0);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        ctx.app().inject({
          method: 'POST',
          url: `/api/v1/accounts/${id}/transactions`,
          payload: { type: 'credit', amount: 50, reference_id: 'retry-storm' },
        }),
      ),
    );
    const statuses = results.map((r) => r.statusCode);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(9);
    expect(await balanceOf(id)).toBe(50);
  });

  it('opposite transfers between two accounts at the same time never deadlock and conserve money', async () => {
    const a = await accountWith(1_000);
    const b = await accountWith(1_000);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        ctx.app().inject({
          method: 'POST',
          url: '/api/v1/transfers',
          payload:
            i % 2 === 0
              ? { from_account_id: a, to_account_id: b, amount: 30, reference_id: `ab-${i}` }
              : { from_account_id: b, to_account_id: a, amount: 20, reference_id: `ba-${i}` },
        }),
      ),
    );
    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    // 10 × 30 went A→B and 10 × 20 went B→A.
    expect(await balanceOf(a)).toBe(1_000 - 300 + 200);
    expect(await balanceOf(b)).toBe(1_000 + 300 - 200);
    expect((await balanceOf(a)) + (await balanceOf(b))).toBe(2_000);
  });

  it('after a mixed burst, every stored balance equals the sum of its transactions', async () => {
    const a = await accountWith(500);
    const b = await accountWith(500);
    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) =>
        ctx.app().inject({
          method: 'POST',
          url: `/api/v1/accounts/${a}/transactions`,
          payload: { type: i % 2 ? 'credit' : 'debit', amount: 70, reference_id: `mix-a-${i}` },
        }),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        ctx.app().inject({
          method: 'POST',
          url: '/api/v1/transfers',
          payload: { from_account_id: i % 2 ? a : b, to_account_id: i % 2 ? b : a, amount: 90, reference_id: `mix-t-${i}` },
        }),
      ),
    ]);
    for (const id of [a, b]) {
      const balance = await balanceOf(id);
      expect(balance).toBeGreaterThanOrEqual(0);
      expect(balance).toBe(await ledgerSum(id));
    }
  });
});
