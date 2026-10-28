import { buildApp } from './app.js';
import { config } from './config.js';
import { createPool } from './db.js';
import { migrate } from './migrate.js';

// Create or update the tables before serving, so `npm run dev` is the only setup step.
await migrate(config.databaseUrl, config.dbSchema);

const db = createPool(config.databaseUrl, config.dbSchema);
const app = await buildApp({ db, logLevel: config.logLevel });

const shutdown = async () => {
  await app.close();
  await db.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: config.host });
app.log.info(`API docs at http://localhost:${config.port}/docs`);
