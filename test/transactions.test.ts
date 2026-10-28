import { describe, expect, it } from 'vitest';
import { useTestApp } from './helpers.js';

const ctx = useTestApp();

async function newAccount(name = 'Test') {
  const res = await ctx.app().inject({ method: 'POST', url: '/api/v1/accounts', payload: { name } });
  return res.json().id as string;
}

const post = (accountId: string, payload: object) =>
  ctx.app().inject({ method: 'POST', url: `/api/v1/accounts/${accountId}/transactions`, payload });

const balanceOf = async (accountId: string) =>
  (await ctx.app().inject({ method: 'GET', url: `/api/v1/accounts/${accountId}/balance` })).json().balance;

let refCounter = 0;
const ref = () => `ref-${++refCounter}`;
const credit = (id: string, amount: number) => post(id, { type: 'credit', amount, reference_id: ref() });
const debit = (id: string, amount: number) => post(id, { type: 'debit', amount, reference_id: ref() });

describe('POST /api/v1/accounts/:id/transactions', () => {
  it('records a credit and returns the transaction with the new balance', async () => {
    const id = await newAccount();
    const res = await post(id, { type: 'credit', amount: 100, reference_id: 'salary-oct', description: 'Salary' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      id: expect.stringMatching(/^txn_[0-9A-Za-z]{20}$/),
      account_id: id,
      type: 'credit',
      amount: 100,
      description: 'Salary',
      reference_id: 'salary-oct',
      balance_after: 100,
      transfer_id: null,
      created_at: expect.any(String),
    });
  });

  it('credit: 100 + 50 = 150 (brief example)', async () => {
    const id = await newAccount();
    await credit(id, 100);
    await credit(id, 50);
    expect(await balanceOf(id)).toBe(150);
  });

  it('debit: 100 - 30 = 70 (brief example)', async () => {
    const id = await newAccount();
    await credit(id, 100);
    const res = await debit(id, 30);
    expect(res.statusCode).toBe(201);
    expect(res.json().balance_after).toBe(70);
    expect(await balanceOf(id)).toBe(70);
  });

  it('rejects a debit over the balance and leaves the balance at 100 (brief example)', async () => {
    const id = await newAccount();
    await credit(id, 100);
    const res = await debit(id, 150);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
      details: { account_id: id, balance: 100, amount: 150 },
    });
    expect(await balanceOf(id)).toBe(100);
  });

  it('allows a debit of exactly the balance', async () => {
    const id = await newAccount();
    await credit(id, 100);
    expect((await debit(id, 100)).statusCode).toBe(201);
    expect(await balanceOf(id)).toBe(0);
  });

  it('balance consistency: 0 +100 +50 -30 -20 = 100 (brief example)', async () => {
    const id = await newAccount();
    await credit(id, 100);
    await credit(id, 50);
    await debit(id, 30);
    await debit(id, 20);
    expect(await balanceOf(id)).toBe(100);
  });

  describe('duplicate reference_id', () => {
    it('returns 409 with the original transaction and does not change the balance', async () => {
      const id = await newAccount();
      const first = await post(id, { type: 'credit', amount: 100, reference_id: 'dup-1' });
      const second = await post(id, { type: 'credit', amount: 100, reference_id: 'dup-1' });
      expect(second.statusCode).toBe(409);
      expect(second.json().error).toEqual({
        code: 'DUPLICATE_TRANSACTION',
        message: expect.any(String),
        details: { transaction: first.json() },
      });
      expect(await balanceOf(id)).toBe(100);
    });

    it('returns 409 even when the duplicate has a different amount', async () => {
      const id = await newAccount();
      await post(id, { type: 'credit', amount: 100, reference_id: 'dup-2' });
      const res = await post(id, { type: 'debit', amount: 5, reference_id: 'dup-2' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.details.transaction.amount).toBe(100);
      expect(await balanceOf(id)).toBe(100);
    });

    it('allows the same reference_id on a different account', async () => {
      const a = await newAccount('A');
      const b = await newAccount('B');
      expect((await post(a, { type: 'credit', amount: 10, reference_id: 'shared' })).statusCode).toBe(201);
      expect((await post(b, { type: 'credit', amount: 10, reference_id: 'shared' })).statusCode).toBe(201);
    });

    it('lets a reference_id from a rejected debit be retried after topping up', async () => {
      const id = await newAccount();
      const first = await post(id, { type: 'debit', amount: 50, reference_id: 'rent' });
      expect(first.statusCode).toBe(422);
      await credit(id, 80);
      const retry = await post(id, { type: 'debit', amount: 50, reference_id: 'rent' });
      expect(retry.statusCode).toBe(201);
      expect(await balanceOf(id)).toBe(30);
    });
  });

  describe('validation', () => {
    it('returns 404 for an unknown account', async () => {
      const res = await post('acc_missing', { type: 'credit', amount: 10, reference_id: 'r' });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('ACCOUNT_NOT_FOUND');
    });

    it.each([
      ['type is not credit/debit', { type: 'refund', amount: 10, reference_id: 'r' }],
      ['type is missing', { amount: 10, reference_id: 'r' }],
      ['amount is 0', { type: 'credit', amount: 0, reference_id: 'r' }],
      ['amount is negative', { type: 'credit', amount: -5, reference_id: 'r' }],
      ['amount is fractional', { type: 'credit', amount: 10.5, reference_id: 'r' }],
      ['amount is a string', { type: 'credit', amount: '10', reference_id: 'r' }],
      ['amount is too large', { type: 'credit', amount: 1_000_000_000_001, reference_id: 'r' }],
      ['reference_id is missing', { type: 'credit', amount: 10 }],
      ['reference_id is blank', { type: 'credit', amount: 10, reference_id: '  ' }],
      ['reference_id uses the reserved prefix', { type: 'credit', amount: 10, reference_id: 'transfer:x' }],
      ['description is too long', { type: 'credit', amount: 10, reference_id: 'r', description: 'x'.repeat(256) }],
      ['an unknown field is sent', { type: 'credit', amount: 10, reference_id: 'r', balance: 5 }],
    ])('returns 400 when %s', async (_label, payload) => {
      const id = await newAccount();
      const res = await post(id, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
      expect(await balanceOf(id)).toBe(0);
    });
  });

  it('has no route to edit or delete a transaction', async () => {
    const id = await newAccount();
    const txn = (await credit(id, 10)).json();
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      const res = await ctx.app().inject({ method, url: `/api/v1/accounts/${id}/transactions/${txn.id}` });
      expect(res.statusCode).toBe(404);
    }
    expect(await balanceOf(id)).toBe(10);
  });
});
