// Daily database backups on hosts without cron (LiteHost containers): the API
// runs pg_dump itself once a day and keeps the last BACKUP_KEEP_DAYS dumps.
// Off unless BACKUP_DIR is set. Dumps DATABASE_URL plus any extra databases in
// BACKUP_EXTRA_URLS (comma-separated, e.g. the waitlist database).
import { execFile } from 'node:child_process';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { emit } from '../../packages/observability/emit.js';
import { observability } from '../../packages/observability/watchup.adapter.js';

const run = promisify(execFile);
const DAY_MS = 24 * 3600_000;

const dbName = (url: string) => {
  try { return new URL(url).pathname.replace(/^\//, '') || 'db'; } catch { return 'db'; }
};

/** libpq settings for pg_dump, passed as PG* environment variables (never argv). */
export function pgEnv(url: string): Record<string, string> {
  const u = new URL(url);
  const env: Record<string, string> = {
    PGHOST: u.searchParams.get('host') || u.hostname || 'localhost',
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, '')),
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
  };
  if (u.port) env.PGPORT = u.port;
  const ssl = u.searchParams.get('sslmode');
  if (ssl) env.PGSSLMODE = ssl === 'no-verify' ? 'require' : ssl;
  return env;
}

/** One dump per database, as custom-format files (`pg_restore` reads them). */
export async function backupNow(now = new Date()): Promise<string[]> {
  const dir = process.env.BACKUP_DIR;
  if (!dir) return [];
  const urls = [process.env.DATABASE_URL, ...(process.env.BACKUP_EXTRA_URLS || '').split(',')]
    .map((u) => (u || '').trim()).filter(Boolean);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[:.]/g, '').slice(0, 15);
  const written: string[] = [];
  for (const url of urls) {
    const file = path.join(dir, `${dbName(url)}-${stamp}Z.dump`);
    try {
      // The URL goes in an environment variable, never on the command line (ps would show it).
      await run(process.env.PG_DUMP_BIN || 'pg_dump', ['--format=custom', '--no-owner', '--no-acl', `--file=${file}`], {
        env: { ...process.env, ...pgEnv(url) }, timeout: 10 * 60_000,
      });
      written.push(file);
    } catch (e) {
      observability.captureException(e, { source: 'db-backup', db: dbName(url) });
    }
  }
  await prune(dir, now);
  emit('ops.db_backup', { files: written.length, of: urls.length });
  return written;
}

async function prune(dir: string, now: Date) {
  const keepMs = Number(process.env.BACKUP_KEEP_DAYS || 14) * DAY_MS;
  for (const f of await readdir(dir)) {
    if (!f.endsWith('.dump')) continue;
    const p = path.join(dir, f);
    const s = await stat(p).catch(() => null);
    if (s && now.getTime() - s.mtimeMs > keepMs) await rm(p, { force: true });
  }
}

/** Skip the run when a dump younger than a day already exists (restarts don't re-dump). */
async function dueNow(): Promise<boolean> {
  const dir = process.env.BACKUP_DIR;
  if (!dir) return false;
  const files = await readdir(dir).catch(() => [] as string[]);
  for (const f of files) {
    if (!f.endsWith('.dump')) continue;
    const s = await stat(path.join(dir, f)).catch(() => null);
    if (s && Date.now() - s.mtimeMs < DAY_MS - 3600_000) return false;
  }
  return true;
}

let timer: NodeJS.Timeout | null = null;
export function startBackupSweeper(everyMs = 3600_000) {
  if (timer || !process.env.BACKUP_DIR) return;
  const tick = () => { void dueNow().then((due) => (due ? backupNow() : undefined)).catch((e) => observability.captureException(e)); };
  setTimeout(tick, 60_000).unref?.(); // first check a minute after boot
  timer = setInterval(tick, everyMs);
  timer.unref?.();
}
