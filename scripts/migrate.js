// Applies new infra/postgres/*.sql files to DATABASE_URL, once each (tracked in
// public.schema_migrations). Needs a build first: it uses the compiled runner.
//   npm run build && node scripts/migrate.js [--dry-run] [--baseline=049]
// First run on a database that predates tracking: pass --baseline=<last applied
// number> (or MIGRATE_BASELINE_THROUGH); those files are recorded, not re-run.
import 'dotenv/config';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const compiled = join(root, 'dist', 'packages', 'database', 'migrate.js');
if (!existsSync(compiled)) {
  console.error('[migrate] FAILED: dist/packages/database/migrate.js is missing. Run "npm run build" first.');
  process.exit(1);
}
const { runMigrations } = await import(pathToFileURL(compiled).href);

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[migrate] FAILED: DATABASE_URL is not set; refusing to run.');
  process.exit(1);
}
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const baselineThrough = arg('baseline') || process.env.MIGRATE_BASELINE_THROUGH || undefined;
const dryRun = process.argv.includes('--dry-run');

const u = new URL(url);
const remote = !/^(localhost|127\.0\.0\.1)$/i.test(u.hostname) && !/^\//.test(u.searchParams.get('host') || '');
const ssl = remote && process.env.DATABASE_SSL !== 'false' ? { rejectUnauthorized: false } : undefined;
const client = new pg.Client({ connectionString: url, ssl, connectionTimeoutMillis: 20000 });
const LOCK = 74119510; // one migration run at a time per database

try {
  await client.connect();
  await client.query('SELECT pg_advisory_lock($1)', [LOCK]);
  // PostGIS is optional (lat/lng are plain doubles); skip it where the server lacks it.
  const { rows: gis } = await client.query(`SELECT 1 FROM pg_available_extensions WHERE name='postgis'`);
  const result = await runMigrations(client, {
    dir: join(root, 'infra', 'postgres'),
    baselineThrough,
    dryRun,
    transform: (sql) => (gis.length ? sql : sql.replace(/^CREATE EXTENSION IF NOT EXISTS postgis;\s*$/gim, '')),
    log: (line) => console.log(line),
  });
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')`,
  );
  console.log(`[migrate] tables present: ${rows[0].n}`);
  console.log(`[migrate] OK (${result.applied.length} applied, ${result.baselined.length} baselined, ${result.alreadyApplied} already applied${dryRun ? `, ${result.pending.length} pending (dry run)` : ''})`);
} catch (err) {
  console.error('[migrate] FAILED:', err?.message || err);
  process.exitCode = 1;
} finally {
  await client.query('SELECT pg_advisory_unlock($1)', [LOCK]).catch(() => undefined);
  await client.end().catch(() => undefined);
}
