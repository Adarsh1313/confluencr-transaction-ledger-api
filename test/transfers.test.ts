import { describe, expect, it } from 'vitest';
import { useTestApp } from './helpers.js';

const ctx = useTestApp();

async function accountWith(balance: number) {
  const id = (await ctx.app().inject({ method: 'POST', url: '/api/v1/accounts', payload: { name: 'T' } })).json()
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

const transfer = (payload: object) => ctx.app().inject({ method: 'POST', url: '/api/v1/transfers', payload });

const balanceOf = async (id: string) =>
  (await ctx.app().inject({ method: 'GET', url: `/api/v1/accounts/${id}/balance` })).json().balance;

describe('POST /api/v1/transfers', () => {
  it('moves 30 from A (100) to B (50): A=70, B=80 (brief example)', async () => {
    const a = await accountWith(100);
    const b = await accountWith(50);
    const res = await transfer({ from_account_id: a, to_account_id: b, amount: 30, reference_id: 't-1' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      id: expect.stringMatching(/^trf_/),
      from_account_id: a,
      to_account_id: b,
      amount: 30,
      description: null,
      reference_id: 't-1',
      debit_transaction_id: expect.stringMatching(/^txn_/),
      credit_transaction_id: expect.stringMatching(/^txn_/),
      created_at: expect.any(String),
    });
    expect(await balanceOf(a)).toBe(70);
    expect(await balanceOf(b)).toBe(80);
  });

  it('shows both halves in each account history, linked by transfer_id', async () => {
    const a = await accountWith(100);
    const b = await accountWith(0);
    const t = (await transfer({ from_account_id: a, to_account_id: b, amount: 40, reference_id: 'link' })).json();

    const aLatest = (await ctx.app().inject({ method: 'GET', url: `/api/v1/accounts/${a}/transactions` })).json()
      .data[0];
    const bLatest = (await ctx.app().inject({ method: 'GET', url: `/api/v1/accounts/${b}/transactions` })).json()
      .data[0];
    expect(aLatest).toMatchObject({ id: t.debit_transaction_id, type: 'debit', amount: 40, transfer_id: t.id });
    expect(bLatest).toMatchObject({ id: t.credit_transaction_id, type: 'credit', amount: 40, transfer_id: t.id });
  });

  it('rejects an insufficient balance, changes neither account and records an attempt', async () => {
    const a = await accountWith(20);
    const b = await accountWith(0);
    const res = await transfer({ from_account_id: a, to_account_id: b, amount: 30, reference_id: 't-poor' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('INSUFFICIENT_BALANCE');
    expect(await balanceOf(a)).toBe(20);
    expect(await balanceOf(b)).toBe(0);

    const attempts = (await ctx.app().inject({ method: 'GET', url: `/api/v1/accounts/${a}/attempts` })).json();
    expect(attempts.data[0]).toMatchObject({
      type: 'debit',
      amount: 30,
      reference_id: 't-poor',
      reason_code: 'INSUFFICIENT_BALANCE',
      transfer_to_account_id: b,
    });
  });

  it('returns 409 with the original transfer when the reference_id is reused, moving money once', async () => {
    const a = await accountWith(100);
    const b = await accountWith(0);
    const first = await transfer({ from_account_id: a, to_account_id: b, amount: 10, reference_id: 'same' });
    const again = await transfer({ from_account_id: a, to_account_id: b, amount: 10, reference_id: 'same' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatchObject({ code: 'DUPLICATE_TRANSFER', details: { transfer: first.json() } });
    expect(await balanceOf(a)).toBe(90);
    expect(await balanceOf(b)).toBe(10);
  });

  it('rejects a transfer to the same account', async () => {
    const a = await accountWith(100);
    const res = await transfer({ from_account_id: a, to_account_id: a, amount: 10, reference_id: 'self' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('SAME_ACCOUNT_TRANSFER');
    expect(await balanceOf(a)).toBe(100);
  });

  it.each(['source', 'destination'])('returns 404 when the %s account does not exist', async (side) => {
    const real = await accountWith(100);
    const payload =
      side === 'source'
        ? { from_account_id: 'acc_missing', to_account_id: real, amount: 10, reference_id: 'x' }
        : { from_account_id: real, to_account_id: 'acc_missing', amount: 10, reference_id: 'x' };
    const res = await transfer(payload);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatchObject({ code: 'ACCOUNT_NOT_FOUND', details: { account_id: 'acc_missing' } });
    expect(await balanceOf(real)).toBe(100);
  });

  it.each([
    ['amount is 0', { amount: 0 }],
    ['amount is fractional', { amount: 1.5 }],
    ['reference_id is missing', { reference_id: undefined }],
    ['to_account_id is missing', { to_account_id: undefined }],
  ])('returns 400 when %s', async (_label, override) => {
    const a = await accountWith(100);
    const b = await accountWith(0);
    const res = await transfer({ from_account_id: a, to_account_id: b, amount: 10, reference_id: 'v', ...override });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/v1/transfers/:id', () => {
  it('returns a transfer by id', async () => {
    const a = await accountWith(100);
    const b = await accountWith(0);
    const created = (await transfer({ from_account_id: a, to_account_id: b, amount: 25, reference_id: 'g' })).json();
    const res = await ctx.app().inject({ method: 'GET', url: `/api/v1/transfers/${created.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(created);
  });

  it('returns 404 for an unknown transfer', async () => {
    const res = await ctx.app().inject({ method: 'GET', url: '/api/v1/transfers/trf_missing' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('TRANSFER_NOT_FOUND');
  });
});
