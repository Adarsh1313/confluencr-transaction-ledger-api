import Fastify from 'fastify';
import fastifySwagger from '@fastify/swagger';
import scalarApiReference from '@scalar/fastify-api-reference';
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from './db.js';
import { API_INTRODUCTION, API_TAGS } from './docs.js';
import { errorHandler } from './errors.js';
import { accountRoutes } from './modules/accounts.js';
import { attemptRoutes } from './modules/attempts.js';
import { transactionRoutes } from './modules/transactions.js';
import { transferRoutes } from './modules/transfers.js';
import { ok } from './schemas.js';

type MediaObject = { example?: unknown; examples?: unknown };
type ResponseMap = Record<string, { content?: Record<string, MediaObject> }>;

/**
 * Zod's OpenAPI transform keeps response schemas but drops the example bodies
 * attached next to them. Copy those examples back so the reference shows a
 * realistic response for every status code.
 */
const transformWithExamples: typeof jsonSchemaTransform = (input) => {
  const output = jsonSchemaTransform(input);
  const source = (input.schema as { response?: ResponseMap } | undefined)?.response;
  const target = (output.schema as { response?: ResponseMap } | undefined)?.response;
  for (const [status, response] of Object.entries(source ?? {})) {
    for (const [type, media] of Object.entries(response.content ?? {})) {
      const out = target?.[status]?.content?.[type];
      if (!out) continue;
      if (media.example !== undefined) out.example = media.example;
      if (media.examples !== undefined) out.examples = media.examples;
    }
  }
  return output;
};

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

  // The OpenAPI document is generated from the same Zod schemas that validate
  // requests, so the docs cannot drift from the code.
  await app.register(fastifySwagger, {
    openapi: {
      info: { title: 'Transaction Ledger API', version: '1.0.0', description: API_INTRODUCTION },
      servers: [{ url: 'http://localhost:3020', description: 'Local' }],
      tags: API_TAGS,
    },
    transform: transformWithExamples,
    transformObject: jsonSchemaTransformObject,
  });
  await app.register(scalarApiReference, {
    routePrefix: '/docs',
    logLevel: 'silent',
    configuration: {
      metaData: { title: 'Transaction Ledger API' },
      theme: 'default',
      layout: 'modern',
      defaultHttpClient: { targetKey: 'shell', clientKey: 'curl' },
      showSidebar: true,
      defaultOpenAllTags: true,
      // Every endpoint already shows its fields and examples; a separate models list repeats them.
      hideModels: true,
      documentDownloadType: 'json',
      // Keep the page about this API: no Scalar promo toolbar, AI chat, MCP or telemetry.
      showDeveloperTools: 'never',
      agent: { disabled: true },
      mcp: { disabled: true },
      telemetry: false,
      withDefaultFonts: true,
    },
  });

  app.get(
    '/health',
    {
      schema: {
        tags: ['Health'],
        operationId: 'health',
        summary: 'Check the service',
        description: 'Returns `ok` when the API is running and can reach its database.',
        response: { 200: ok('The service is healthy', z.object({ status: z.literal('ok') }), { status: 'ok' }) },
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
      await api.register(transferRoutes(db));
      await api.register(attemptRoutes(db));
    },
    { prefix: '/api/v1' },
  );

  await app.ready();
  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
