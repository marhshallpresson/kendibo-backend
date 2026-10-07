// Database pool — ONE source of truth, no demo stores.
// Production (Pxxl managed Postgres): DATABASE_URL set -> node-postgres Pool.
// Local/dev (no Docker needed): pg-mem running the real migration SQL,
// exposed through a pg-compatible Pool so every query below is real SQL.
import { Pool } from 'pg';
import { localDb } from './local.js';

type PgPool = { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
let pool: PgPool | null = null;

export function db(): PgPool {
  if (pool) return pool;
  if (process.env.DATABASE_URL) {
    const real = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      // Pxxl managed Postgres terminates TLS with a self-signed chain.
      // Encryption stays on; chain validation off (same as ?sslmode=require).
      ssl: { rejectUnauthorized: false },
    });
    real.on('error', () => {});
    pool = real as unknown as PgPool;
    return pool;
  }
  const mem = localDb();
  const { Pool: MemPool } = mem.adapters.createPg() as unknown as { Pool: new () => PgPool };
  pool = new MemPool();
  return pool;
}

/** Parameterised query. BIGINT comes back as string — wrap with BigInt()/String() at use. */
export async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const t0 = process.hrtime.bigint();
  try {
    const r = await db().query(text, params);
    return r.rows as T[];
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
