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
    const real = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
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
  const r = await db().query(text, params);
  return r.rows as T[];
}

/** Transactional outbox insert — same DB txn as domain write in production. */
export async function insertOutbox(client: { query: (t: string, p: unknown[]) => Promise<unknown> }, topic: string, payload: unknown) {
  await client.query('INSERT INTO outbox_event(topic, payload) VALUES ($1, $2)', [topic, JSON.stringify(payload)]);
}
