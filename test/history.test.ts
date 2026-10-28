import { describe, expect, it } from 'vitest';
import { useTestApp } from './helpers.js';

const ctx = useTestApp();

async function newAccount() {
  return (await ctx.app().inject({ method: 'POST', url: '/api/v1/accounts', payload: { name: 'H' } })).json()
    .id as string;
}

const post = (id: string, type: 'credit' | 'debit', amount: number, reference_id: string) =>
  ctx.app().inject({ method: 'POST', url: `/api/v1/accounts/${id}/transactions`, payload: { type, amount, reference_id } });

const history = (id: string, query = '') =>
  ctx.app().inject({ method: 'GET', url: `/api/v1/accounts/${id}/transactions${query}` });

/** credit 100 (r1), credit 50 (r2), debit 30 (r3), debit 20 (r4), credit 5 (r5) — in that order. */
async function seeded() {
  const id = await newAccount();
  await post(id, 'credit', 100, 'r1');
  await post(id, 'credit', 50, 'r2');
  await post(id, 'debit', 30, 'r3');
  await post(id, 'debit', 20, 'r4');
  await post(id, 'credit', 5, 'r5');
  return id;
}

describe('GET /api/v1/accounts/:id/transactions', () => {
  it('returns all transactions newest first with pagination metadata', async () => {
    const id = await seeded();
    const res = await history(id);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.map((t: { reference_id: string }) => t.reference_id)).toEqual(['r5', 'r4', 'r3', 'r2', 'r1']);
    expect(body.data.map((t: { balance_after: number }) => t.balance_after)).toEqual([105, 100, 120, 150, 100]);
    expect(body.pagination).toEqual({ page: 1, limit: 20, total_records: 5, total_pages: 1 });
  });

  it('filters by type', async () => {
    const id = await seeded();
    const credits = (await history(id, '?type=credit')).json();
    expect(credits.data.map((t: { reference_id: string }) => t.reference_id)).toEqual(['r5', 'r2', 'r1']);
    expect(credits.pagination.total_records).toBe(3);
    const debits = (await history(id, '?type=debit')).json();
    expect(debits.data.map((t: { reference_id: string }) => t.reference_id)).toEqual(['r4', 'r3']);
  });

  it('paginates with page and limit', async () => {
    const id = await seeded();
    const page2 = (await history(id, '?page=2&limit=2')).json();
    expect(page2.data.map((t: { reference_id: string }) => t.reference_id)).toEqual(['r3', 'r2']);
    expect(page2.pagination).toEqual({ page: 2, limit: 2, total_records: 5, total_pages: 3 });
    const page3 = (await history(id, '?page=3&limit=2')).json();
    expect(page3.data.map((t: { reference_id: string }) => t.reference_id)).toEqual(['r1']);
  });

  it('returns an empty page past the end, with correct totals', async () => {
    const id = await seeded();
    const res = await history(id, '?page=9&limit=2');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [], pagination: { page: 9, limit: 2, total_records: 5, total_pages: 3 } });
  });

  it('returns an empty list for an account with no transactions', async () => {
    const id = await newAccount();
    expect((await history(id)).json()).toEqual({
      data: [],
      pagination: { page: 1, limit: 20, total_records: 0, total_pages: 0 },
    });
  });

  it('does not include rejected debits', async () => {
    const id = await newAccount();
    await post(id, 'debit', 10, 'too-much');
    expect((await history(id)).json().data).toEqual([]);
  });

  it.each(['?page=0', '?page=-1', '?page=abc', '?limit=0', '?limit=101', '?limit=2.5'])(
    'returns 400 INVALID_PAGINATION for %s',
    async (query) => {
      const id = await newAccount();
      const res = await history(id, query);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_PAGINATION');
    },
  );

  it('returns 400 for an unknown type filter', async () => {
    const id = await newAccount();
    const res = await history(id, '?type=refund');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 for an unknown account', async () => {
    const res = await history('acc_missing');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('ACCOUNT_NOT_FOUND');
  });
});

describe('GET /api/v1/accounts/:id/attempts', () => {
  it('lists refused debits newest first with the reason, and nothing else', async () => {
    const id = await newAccount();
    await post(id, 'credit', 100, 'ok');
    await post(id, 'debit', 150, 'big-1');
    await post(id, 'debit', 999, 'big-2');
    await post(id, 'debit', -1, 'malformed'); // 400: not an attempt

    const res = await ctx.app().inject({ method: 'GET', url: `/api/v1/accounts/${id}/attempts` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.pagination).toEqual({ page: 1, limit: 20, total_records: 2, total_pages: 1 });
    expect(body.data[0]).toEqual({
      id: expect.stringMatching(/^att_/),
      account_id: id,
      type: 'debit',
      amount: 999,
      description: null,
      reference_id: 'big-2',
      reason_code: 'INSUFFICIENT_BALANCE',
      balance_at_attempt: 100,
      transfer_to_account_id: null,
      created_at: expect.any(String),
    });
    expect(body.data[1].reference_id).toBe('big-1');
  });

  it('returns 404 for an unknown account', async () => {
    const res = await ctx.app().inject({ method: 'GET', url: '/api/v1/accounts/acc_missing/attempts' });
    expect(res.statusCode).toBe(404);
  });
});
