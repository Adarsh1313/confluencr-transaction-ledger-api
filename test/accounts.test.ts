import { describe, expect, it } from 'vitest';
import { useTestApp } from './helpers.js';

const ctx = useTestApp();

const createAccount = (payload: unknown) =>
  ctx.app().inject({ method: 'POST', url: '/api/v1/accounts', payload: payload as object });

describe('POST /api/v1/accounts', () => {
  it('creates an account with balance 0 and server-generated id and timestamp', async () => {
    const res = await createAccount({ name: 'Asha Rao' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toEqual({
      id: expect.stringMatching(/^acc_[0-9A-Za-z]{20}$/),
      name: 'Asha Rao',
      balance: 0,
      created_at: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(body.created_at))).toBe(false);
  });

  it('gives every account a unique id', async () => {
    const a = (await createAccount({ name: 'A' })).json();
    const b = (await createAccount({ name: 'B' })).json();
    expect(a.id).not.toBe(b.id);
  });

  it('trims the name', async () => {
    const res = await createAccount({ name: '  Ravi  ' });
    expect(res.json().name).toBe('Ravi');
  });

  it('rejects a client-supplied balance', async () => {
    const res = await createAccount({ name: 'Rich', balance: 1_000_000 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it.each([
    ['missing', {}],
    ['blank', { name: '   ' }],
    ['too long', { name: 'x'.repeat(101) }],
    ['not a string', { name: 42 }],
  ])('rejects a %s name', async (_label, payload) => {
    const res = await createAccount(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'VALIDATION_ERROR', details: { issues: expect.any(Array) } });
  });

  it('rejects malformed JSON', async () => {
    const res = await ctx.app().inject({
      method: 'POST',
      url: '/api/v1/accounts',
      headers: { 'content-type': 'application/json' },
      payload: '{"name": ',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_REQUEST_BODY');
  });
});

describe('GET /api/v1/accounts/:id/balance', () => {
  it('returns the balance of an existing account', async () => {
    const { id } = (await createAccount({ name: 'Meera' })).json();
    const res = await ctx.app().inject({ method: 'GET', url: `/api/v1/accounts/${id}/balance` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ account_id: id, balance: 0 });
  });

  it('returns 404 for an unknown account', async () => {
    const res = await ctx.app().inject({ method: 'GET', url: '/api/v1/accounts/acc_doesnotexist/balance' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: {
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Account acc_doesnotexist does not exist',
        details: { account_id: 'acc_doesnotexist' },
      },
    });
  });
});
