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

  it('serves the API reference and its OpenAPI document', async () => {
    const page = await ctx.app().inject({ method: 'GET', url: '/docs/' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);

    const spec = (await ctx.app().inject({ method: 'GET', url: '/docs/openapi.json' })).json();
    expect(spec.info.title).toBe('Transaction Ledger API');
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining(['/api/v1/accounts', '/api/v1/accounts/{id}/transactions', '/api/v1/transfers']),
    );
    // Every documented error response carries a realistic example body.
    const created = spec.paths['/api/v1/accounts/{id}/transactions'].post.responses;
    expect(created['409'].content['application/json'].examples.duplicate.value.error.code).toBe('DUPLICATE_TRANSACTION');
  });
});
