// Local DB boot — pg-mem in-process Postgres for machines without Docker.
// Runs 001_core.sql + 002_seed.sql so every constraint the app relies on
// (UNIQUE refs, kobo CHECKs, one-accepted-per-job) is enforced locally.
// Production: set DATABASE_URL to RDS and this module is bypassed.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newDb, type IMemoryDb } from 'pg-mem';

let mem: IMemoryDb | null = null;

export function useLocalDb(): boolean {
  return !process.env.DATABASE_URL;
}

export function localDb(): IMemoryDb {
  if (mem) return mem;
  mem = newDb({ autoCreateForeignKeyIndices: true });
  // pg-mem has no pgcrypto: impure => fresh value per row (else multi-row
  // INSERTs share one id and violate PKs).
  mem.public.registerFunction({
    name: 'gen_random_uuid', returns: 'uuid', impure: true,
    implementation: () =>
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      }),
  } as never);
  const run = (f: string) => {
    try {
      let sql = readFileSync(join(process.cwd(), 'infra', 'postgres', f), 'utf-8')
        .split('\n')
        .filter((l) => !l.startsWith('CREATE EXTENSION'))
        .join('\n');
      // pg-mem shims: no ON CONFLICT, native gen_random_uuid() is built in.
      sql = sql.replace(/ON CONFLICT[^\n;]*DO NOTHING/gi, '');
      mem!.public.none(sql);
    } catch (e) {
      console.warn(`[localdb] ${f}: ${(e as Error).message.split('\n')[0]}`);
    }
  };
  run('001_core.sql');
  run('002_seed.sql');
  run('003_prd_entities.sql');
  run('004_reference_data.sql');
  run('005_ops.sql');
  run('006_checklist.sql');
  run('007_requests.sql');
  run('008_checker.sql');
  run('009_profile.sql');
  console.log('[localdb] pg-mem ready (001-009)');
  return mem;
}

/** pg-compatible query helper for local mode (parameterless; use for boots/checks). */
export async function localQuery<T = Record<string, unknown>>(text: string): Promise<T[]> {
  const db = localDb();
  const res = await db.public.query(text);
  return res.rows as T[];
}
