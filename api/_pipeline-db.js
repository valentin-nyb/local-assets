import { Pool } from 'pg';

let pool;

export function getPipelineDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured for pipeline jobs');
  }

  if (!pool) {
    const databaseUrl = new URL(process.env.DATABASE_URL);
    const sslMode = databaseUrl.searchParams.get('sslmode');
    const ssl = process.env.DATABASE_SSL === 'disable' || sslMode === 'disable'
      ? false
      : sslMode
        ? undefined
        : { rejectUnauthorized: false };

    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl,
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
    });
  }

  return pool;
}