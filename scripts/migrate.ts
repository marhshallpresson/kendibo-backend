// Migrate the LIVE database (Pxxl managed Postgres) through infra/postgres/*.sql
// in order. Idempotent: every object uses IF NOT EXISTS / conditional ADD COLUMN.
// Usage: npm run db:migrate  (requires DATABASE_URL)
import 'dotenv/config';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

const DIR = join(process.cwd(), 'infra', 'postgres');

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = readFileSync(join(DIR, f), 'utf-8');
    try {
      await pool.query(sql);
      console.log(`[migrate] ${f} OK`);
    } catch (err) {
      console.log(`[migrate] ${f} FAILED: ${(err as Error).message.split('\n')[0]}`);
      await pool.end();
      process.exitCode = 1;
      return;
    }
  }
  await pool.end();
  console.log('[migrate] done');
}
void main();
