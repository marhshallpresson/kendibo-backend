// Same tracked runner as scripts/migrate.js, run straight from source with tsx
// (no build needed): npm run db:migrate -- [--dry-run] [--baseline=049]
// Each file runs once per database; see packages/database/migrate.ts.
import 'dotenv/config';
import { join } from 'node:path';
import pg from 'pg';
import { runMigrations } from '../packages/database/migrate.js';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const local = /[?&]host=\//.test(url) || /@(localhost|127\.0\.0\.1)[:/]/.test(url) || process.env.DATABASE_SSL === 'false';
  const client = new pg.Client({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [74119510]);
    const gis = (await client.query(`SELECT 1 FROM pg_available_extensions WHERE name='postgis'`)).rows;
    const r = await runMigrations(client, {
      dir: join(process.cwd(), 'infra', 'postgres'),
      baselineThrough: arg('baseline') || process.env.MIGRATE_BASELINE_THROUGH || undefined,
      dryRun: process.argv.includes('--dry-run'),
      transform: (sql) => (gis.length ? sql : sql.replace(/^CREATE EXTENSION IF NOT EXISTS postgis;\s*$/gim, '')),
      log: (line) => console.log(line),
    });
    console.log(`[migrate] OK (${r.applied.length} applied, ${r.baselined.length} baselined, ${r.alreadyApplied} already applied)`);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [74119510]).catch(() => undefined);
    await client.end();
  }
}
main().catch((err) => { console.error('[migrate] FAILED:', (err as Error).message); process.exitCode = 1; });
