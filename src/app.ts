import Fastify from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from './db.js';
import { errorHandler } from './errors.js';
import { accountRoutes } from './modules/accounts.js';
import { attemptRoutes } from './modules/attempts.js';
import { transactionRoutes } from './modules/transactions.js';
import { transferRoutes } from './modules/transfers.js';

export interface AppOptions {
  db: Db;
  logLevel?: string;
}

export async function buildApp({ db, logLevel = 'silent' }: AppOptions) {
  const app = Fastify({ logger: { level: logLevel } }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: { code: 'ROUTE_NOT_FOUND', message: `Route ${request.method} ${request.url} not found`, details: {} },
    }),
  );

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'Transaction Ledger API',
        description:
          'Accounts, credits, debits and transfers. All amounts are integers in paise (100 paise = ₹1).',
        version: '1.0.0',
      },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(fastifySwaggerUi, { routePrefix: '/docs' });

  app.get(
    '/health',
    {
      schema: {
        tags: ['health'],
        summary: 'Liveness check that also pings the database',
        response: { 200: z.object({ status: z.literal('ok') }) },
      },
    },
    async () => {
      await db.query('SELECT 1');
      return { status: 'ok' as const };
    },
  );

  await app.register(
    async (api) => {
      await api.register(accountRoutes(db));
      await api.register(transactionRoutes(db));
      await api.register(attemptRoutes(db));
      await api.register(transferRoutes(db));
    },
    { prefix: '/api/v1' },
  );

  await app.ready();
  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
