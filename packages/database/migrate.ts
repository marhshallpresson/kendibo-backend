// Tracked migrations: each infra/postgres/*.sql file runs exactly once per
// database and is recorded in public.schema_migrations.
//
// Before this, every deploy replayed every file. That included the one-off
// "purge demo data" scripts (017, 019, 020), which delete phone-only users with
// no app login trail: exactly a WhatsApp customer who skipped the email step.
//
// Rules:
// - Fresh database (no identity.users): run every file in order and record it.
// - Existing database that was never tracked: refuse to run. Record what it
//   already has with `baselineThrough` (e.g. "049"); those files are NOT re-run.
// - Tracked database: run only files that are not recorded yet.
// - Each file runs in its own transaction with its record, so a failed file
//   leaves no half-applied state and is retried on the next run.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface MigrationDb {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

export interface MigrateOptions {
  dir: string;
  /** One-time, for a database that predates tracking: record files numbered up to this as already applied. */
  baselineThrough?: string;
  /** Report what would run; change nothing (the tracking table is still created). */
  dryRun?: boolean;
  /** Rewrite a file's SQL before it runs (e.g. drop PostGIS where the server lacks it). */
  transform?: (sql: string, filename: string) => string;
  log?: (line: string) => void;
}

export interface MigrateResult {
  applied: string[];
  baselined: string[];
  pending: string[];
  alreadyApplied: number;
  changedSinceApplied: string[];
}

const numberOf = (filename: string): number => Number(/^(\d+)_/.exec(filename)?.[1] ?? NaN);
const checksum = (sql: string): string => createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');

async function exists(db: MigrationDb, probeSql: string): Promise<boolean> {
  try { await db.query(probeSql); return true; } catch { return false; }
}

export async function runMigrations(db: MigrationDb, opts: MigrateOptions): Promise<MigrateResult> {
  const log = opts.log ?? (() => undefined);
  const files = readdirSync(opts.dir).filter((f) => f.endsWith('.sql')).sort();
  const bad = files.filter((f) => Number.isNaN(numberOf(f)));
  if (bad.length) throw new Error(`MIGRATION_NAME: files must start with a number and underscore: ${bad.join(', ')}`);

  if (!(await exists(db, `SELECT 1 FROM public.schema_migrations LIMIT 1`))) {
    await db.query(
      `CREATE TABLE public.schema_migrations (
         filename TEXT PRIMARY KEY,
         checksum TEXT NOT NULL,
         baseline BOOLEAN NOT NULL DEFAULT false,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
  }
  const recordedRows = (await db.query(`SELECT filename, checksum FROM public.schema_migrations`)).rows;
  const recorded = new Map(recordedRows.map((r) => [String(r.filename), String(r.checksum)]));
  const result: MigrateResult = { applied: [], baselined: [], pending: [], alreadyApplied: 0, changedSinceApplied: [] };

  if (recorded.size === 0) {
    const existing = await exists(db, `SELECT 1 FROM identity.users LIMIT 1`);
    if (existing && !opts.baselineThrough) {
      throw new Error(
        'UNTRACKED_DATABASE: this database already has tables but no migration record. ' +
        'Nothing was run. Record what it already has first, e.g. MIGRATE_BASELINE_THROUGH=049 ' +
        '(the last migration known to be applied), then run again.',
      );
    }
    if (!existing && opts.baselineThrough) {
      throw new Error('BASELINE_ON_EMPTY: this database is empty, so there is nothing to baseline. Run without a baseline.');
    }
    if (existing && opts.baselineThrough) {
      const through = Number(opts.baselineThrough);
      if (Number.isNaN(through)) throw new Error(`BASELINE_INVALID: "${opts.baselineThrough}" is not a migration number`);
      for (const f of files.filter((x) => numberOf(x) <= through)) {
        const sum = checksum(readFileSync(join(opts.dir, f), 'utf-8'));
        if (!opts.dryRun) {
          await db.query(`INSERT INTO public.schema_migrations (filename, checksum, baseline) VALUES ($1,$2,true)`, [f, sum]);
        }
        recorded.set(f, sum);
        result.baselined.push(f);
      }
      log(`[migrate] baselined ${result.baselined.length} file(s) through ${opts.baselineThrough} (recorded, not run)`);
    }
  } else if (opts.baselineThrough) {
    log('[migrate] baseline ignored: this database is already tracked');
  }

  for (const f of files) {
    const raw = readFileSync(join(opts.dir, f), 'utf-8');
    const sum = checksum(raw);
    if (recorded.has(f)) {
      if (!result.baselined.includes(f)) result.alreadyApplied++;
      if (recorded.get(f) !== sum) {
        result.changedSinceApplied.push(f);
        log(`[migrate] note: ${f} changed after it was applied; it is not re-run. Put new changes in a new file.`);
      }
      continue;
    }
    if (opts.dryRun) { result.pending.push(f); log(`[migrate] would apply ${f}`); continue; }
    const sql = opts.transform ? opts.transform(raw, f) : raw;
    await db.query('BEGIN');
    try {
      await db.query(sql);
      await db.query(`INSERT INTO public.schema_migrations (filename, checksum) VALUES ($1,$2)`, [f, sum]);
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK').catch(() => undefined);
      throw new Error(`MIGRATION_FAILED ${f}: ${(err as Error).message.split('\n')[0]}`);
    }
    result.applied.push(f);
    log(`[migrate] applied ${f}`);
  }
  if (!result.applied.length && !result.pending.length) log('[migrate] nothing to apply');
  return result;
}
