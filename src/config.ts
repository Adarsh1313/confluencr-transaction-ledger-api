import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export const config = {
  databaseUrl: required('DATABASE_URL'),
  // Tables live in a dedicated schema, not Supabase's `public`, which is exposed
  // to the internet through Supabase's auto-generated REST API.
  dbSchema: process.env.DB_SCHEMA ?? 'ledger',
  port: Number(process.env.PORT ?? 3020),
  host: process.env.HOST ?? '0.0.0.0',
  logLevel: process.env.LOG_LEVEL ?? 'info',
};
