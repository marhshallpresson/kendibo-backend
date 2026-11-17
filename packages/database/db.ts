// Database pool — ONE source of truth, no demo stores.
// Production (Pxxl managed Postgres): DATABASE_URL set -> node-postgres Pool.
// Local/dev (no Docker needed): pg-mem running the real migration SQL,
// exposed through a pg-compatible Pool so every query below is real SQL.
import { Pool } from 'pg';
import { localDb } from './local.js';

type PgPool = { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
let pool: PgPool | null = null;
let memPool: PgPool | null = null;

function getMemPool(): PgPool {
  if (memPool) return memPool;
  const mem = localDb();
  const { Pool: MemPool } = mem.adapters.createPg() as unknown as { Pool: new () => PgPool };
  memPool = new MemPool();
  return memPool;
}

export function db(): PgPool {
  if (pool) return pool;
  if (process.env.DATABASE_URL) {
    const real = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      connectionTimeoutMillis: 5000,
      // Managed Postgres (Aiven/Pxxl) terminates TLS with a self-signed chain:
      // encryption on, chain validation off (same as ?sslmode=require). A local
      // Unix socket (?host=/run/postgresql) has no TLS, nor does DATABASE_SSL=false.
      ssl: process.env.DATABASE_SSL === 'false' || /[?&]host=\//.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
    });
    real.on('error', () => {});
    pool = real as unknown as PgPool;
    return pool;
  }
  pool = getMemPool();
  return pool;
}

function isConnectionOutage(err: unknown): boolean {
  const code = String((err as { code?: string })?.code ?? '');
  const msg = String((err as Error)?.message ?? '');
  return (
    ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'].includes(code) ||
    /getaddrinfo ENOTFOUND|connect ECONNREFUSED|Connection terminated/i.test(msg)
  );
}

/**
 * The in-memory fallback is for local development only. In production a
 * database outage must fail loudly: switching to memory would accept sign-ups,
 * bookings and payments and lose them all on the next restart.
 */
const memoryFallbackAllowed = () =>
  process.env.NODE_ENV !== 'production' && process.env.DB_MEMORY_FALLBACK !== 'false';

/** Which database queries are going to right now. */
export function databaseMode(): 'postgres' | 'memory-fallback' | 'local' {
  if (!process.env.DATABASE_URL) return 'local';
  return pool && pool === memPool ? 'memory-fallback' : 'postgres';
}

/** True when the database answers a trivial query (used by /health/ready). */
export async function pingDb(): Promise<boolean> {
  try {
    await db().query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/** Parameterised query. BIGINT comes back as string — wrap with BigInt()/String() at use. */
export async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const t0 = process.hrtime.bigint();
  try {
    try {
      const r = await db().query(text, params);
      return r.rows as T[];
    } catch (err) {
      if (!process.env.DATABASE_URL || !isConnectionOutage(err) || pool === memPool) throw err;
      if (!memoryFallbackAllowed()) {
        // A sleeping or restarting database often answers a second later:
        // retry once, then let the request fail rather than lose the write.
        console.error(`[db] Postgres unreachable (${(err as Error).message}); retrying once.`);
        await new Promise((res) => setTimeout(res, 1000));
        const r = await db().query(text, params);
        return r.rows as T[];
      }
      console.warn(
        `[db] Remote Postgres unreachable (${(err as Error).message}); switching to embedded pg-mem fallback (development only).`,
      );
      pool = getMemPool();
      const r = await pool.query(text, params);
      return r.rows as T[];
    }
  } finally {
    // Slow-query trace (>1s) without importing the client (avoids a cycle):
    // dynamic import keeps db.ts dependency-free at module load.
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms > 1000 && process.env.WATCHUP_API_KEY) {
      void import('../observability/watchup/client.js').then(async ({ Watchup }) => {
        try {
          const w = new Watchup({ service: 'db' });
          w.trace('db.slow_query', ms, 200, { sql: text.slice(0, 200) });
          await w.flush();
          await w.shutdown();
        } catch { /* fail open */ }
      });
    }
  }
}

/** Transactional outbox insert — same DB txn as domain write in production. */
export async function insertOutbox(client: { query: (t: string, p: unknown[]) => Promise<unknown> }, topic: string, payload: unknown) {
  await client.query('INSERT INTO outbox_event(topic, payload) VALUES ($1, $2)', [topic, JSON.stringify(payload)]);
}

/**
 * Run `fn` only if a Postgres advisory lock for `key` is free (pg_try_advisory_lock).
 * The lock is session-level, so it is taken, used and released on ONE dedicated
 * connection; if the process dies Postgres drops it with the connection. Returns
 * { acquired: false } without running `fn` when another process/call holds it.
 */
export async function withAdvisoryLock<T>(key: string, fn: () => Promise<T>): Promise<{ acquired: boolean; value?: T }> {
  // Each lock holds one pooled connection while fn() needs others; cap holders so a burst
  // of settles cannot take the whole pool (max 10) and starve the queries inside them.
  if (lockHolders >= LOCK_HOLDERS_MAX) await new Promise<void>((r) => lockWaiters.push(r));
  lockHolders++;
  try { return await advisoryLockInner(key, fn); }
  finally { lockHolders--; lockWaiters.shift()?.(); }
}

const LOCK_HOLDERS_MAX = 5;
let lockHolders = 0;
const lockWaiters: Array<() => void> = [];

async function advisoryLockInner<T>(key: string, fn: () => Promise<T>): Promise<{ acquired: boolean; value?: T }> {
  const { createHash } = await import('node:crypto');
  const id = Number(BigInt('0x' + createHash('sha256').update(key).digest('hex').slice(0, 12))); // 48-bit, exact as a JS number
  const base = db() as PgPool & { connect?: () => Promise<{ query: PgPool['query']; release: () => void }> };
  const client = typeof base.connect === 'function' ? await base.connect() : null;
  const run = (text: string) => (client ?? base).query(text, [id]);
  try {
    const got = await run('SELECT pg_try_advisory_lock($1) AS ok');
    if (!(got.rows[0] as { ok?: boolean } | undefined)?.ok) return { acquired: false };
    try { return { acquired: true, value: await fn() }; }
    finally { await run('SELECT pg_advisory_unlock($1) AS ok').catch(() => {}); }
  } finally { client?.release(); }
}
