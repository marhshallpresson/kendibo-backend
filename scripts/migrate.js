// Applies infra/postgres/*.sql in order to DATABASE_URL.
// Usage: node scripts/migrate.js (reads .env via dotenv/config convention:
// set DATABASE_URL in env or backend .env).
import 'dotenv/config';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'infra', 'postgres');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[migrate] DATABASE_URL is not set — refusing to run.');
  process.exit(1);
}
const u = new URL(url);
const remote = !/^(localhost|127\.0\.0\.1)$/i.test(u.hostname) && !/^\//.test(u.searchParams.get('host') || '');
const ssl = remote && process.env.DATABASE_SSL !== 'false' ? { rejectUnauthorized: false } : undefined;
const pool = new Pool({ connectionString: url, ssl, connectionTimeoutMillis: 20000 });
try {
  // PostGIS is optional (lat/lng are plain doubles); skip it where the server lacks it.
  const { rows: gis } = await pool.query(`SELECT 1 FROM pg_available_extensions WHERE name='postgis'`);
  for (const f of files) {
    let sql = readFileSync(join(dir, f), 'utf-8');
    if (!gis.length) sql = sql.replace(/^CREATE EXTENSION IF NOT EXISTS postgis;\s*$/gim, '');
    await pool.query(sql);
    console.log(`[migrate] applied ${f}`);
  }
  const { rows } = await pool.query(
    `SELECT schemaname, tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1,2`
  );
  console.log(`[migrate] tables present: ${rows.length}`);
  for (const r of rows) console.log(`  - ${r.schemaname}.${r.tablename}`);
  console.log('[migrate] OK');
} catch (err) {
  console.error('[migrate] FAILED:', err?.message || err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
