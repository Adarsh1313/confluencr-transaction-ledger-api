import { describe, expect, it } from 'vitest';
import { useTestApp } from './helpers.js';

const ctx = useTestApp();

describe('health and errors', () => {
  it('reports ok when the database answers', async () => {
    const res = await ctx.app().inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('returns the standard error shape for unknown routes', async () => {
    const res = await ctx.app().inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: 'ROUTE_NOT_FOUND', message: expect.any(String), details: {} },
    });
  });

  it('serves the Swagger docs', async () => {
    const res = await ctx.app().inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    expect(res.json().info.title).toBe('Transaction Ledger API');
  });
});
