import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db.js';
import { useTestApp } from './helpers.js';

const ctx = useTestApp();

const MAX_BALANCE = 9_007_199_254_740_991; // the accounts_balance_max ceiling

async function accountWith(balance: number) {
  const id = (await ctx.app().inject({ method: 'POST', url: '/api/v1/accounts', payload: { name: 'R' } })).json()
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

/** Setup only: reaching the ceiling through the API would take ~9,000 maximum credits. */
async function accountAtCeiling() {
  const id = await accountWith(0);
  await ctx.db().query('UPDATE accounts SET balance = $1 WHERE id = $2', [MAX_BALANCE, id]);
  return id;
}

const balanceOf = async (id: string) =>
  (await ctx.app().inject({ method: 'GET', url: `/api/v1/accounts/${id}/balance` })).json().balance;

const historyOf = async (id: string, query = '') =>
  (await ctx.app().inject({ method: 'GET', url: `/api/v1/accounts/${id}/transactions${query}` })).json();

describe('balance ceiling and transfer rollback', () => {
  it('rejects a credit that would exceed the balance ceiling with 422, changing nothing', async () => {
    const id = await accountAtCeiling();
    const res = await ctx.app().inject({
      method: 'POST',
      url: `/api/v1/accounts/${id}/transactions`,
      payload: { type: 'credit', amount: 1, reference_id: 'one-too-many' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('BALANCE_LIMIT_EXCEEDED');
    expect(await balanceOf(id)).toBe(MAX_BALANCE);
    expect((await historyOf(id)).data).toEqual([]);
  });

  it('rolls back the whole transfer when the credit half fails after the debit half was written', async () => {
    const source = await accountWith(100);
    const destination = await accountAtCeiling();

    const res = await ctx.app().inject({
      method: 'POST',
      url: '/api/v1/transfers',
      payload: { from_account_id: source, to_account_id: destination, amount: 30, reference_id: 'half-way' },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('BALANCE_LIMIT_EXCEEDED');
    // The debit on the source was inserted before the credit failed. Rollback undid it.
    expect(await balanceOf(source)).toBe(100);
    expect((await historyOf(source)).data.map((t: { reference_id: string }) => t.reference_id)).toEqual(['opening']);
    expect(await balanceOf(destination)).toBe(MAX_BALANCE);
    const { rows } = await ctx.db().query('SELECT count(*)::int AS n FROM transfers');
    expect(rows[0].n).toBe(0);
  });
});

describe('ordering', () => {
  it('keeps a stable order (by id) when two transactions share a timestamp', async () => {
    const id = await accountWith(0);
    const at = '2026-10-28T12:00:00.000Z';
    for (const txnId of ['txn_AAAA', 'txn_ZZZZ', 'txn_MMMM']) {
      await ctx.db().query(
        `INSERT INTO transactions (id, account_id, type, amount, reference_id, balance_after, created_at)
         VALUES ($1, $2, 'credit', 1, $1, 1, $3)`,
        [txnId, id, at],
      );
    }
    const ids = (await historyOf(id)).data.map((t: { id: string }) => t.id);
    expect(ids).toEqual(['txn_ZZZZ', 'txn_MMMM', 'txn_AAAA']);
    const paged = [1, 2, 3].map(async (page) => (await historyOf(id, `?limit=1&page=${page}`)).data[0].id);
    expect(await Promise.all(paged)).toEqual(ids);
  });
});

describe('remaining validation paths', () => {
  it.each(['?page=0', '?limit=101'])('rejects bad pagination on /attempts (%s)', async (query) => {
    const id = await accountWith(0);
    const res = await ctx.app().inject({ method: 'GET', url: `/api/v1/accounts/${id}/attempts${query}` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_PAGINATION');
  });

  it('rejects a transfer description over 255 characters', async () => {
    const a = await accountWith(100);
    const b = await accountWith(0);
    const res = await ctx.app().inject({
      method: 'POST',
      url: '/api/v1/transfers',
      payload: { from_account_id: a, to_account_id: b, amount: 1, reference_id: 'd', description: 'x'.repeat(256) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('reports a missing account (404) before same-account (422) on a self-transfer', async () => {
    const res = await ctx.app().inject({
      method: 'POST',
      url: '/api/v1/transfers',
      payload: { from_account_id: 'acc_missing', to_account_id: 'acc_missing', amount: 1, reference_id: 's' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('ACCOUNT_NOT_FOUND');
  });
});

describe('unexpected errors', () => {
  it('returns 500 INTERNAL_ERROR without leaking internals when the database is unreachable', async () => {
    const brokenDb = createPool('postgresql://nobody:nothing@127.0.0.1:1/none', 'ledger_test');
    const app = await buildApp({ db: brokenDb });
    try {
      const res = await app.inject({ method: 'POST', url: '/api/v1/accounts', payload: { name: 'X' } });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong', details: {} } });
      expect(res.body).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|stack/i);
    } finally {
      await app.close();
      await brokenDb.end();
    }
  });
});
