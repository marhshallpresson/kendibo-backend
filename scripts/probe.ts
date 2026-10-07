import 'dotenv/config';
import { Pool } from 'pg';

async function main(): Promise<void> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  try {
    const v = await pool.query('select version()');
    console.log('PG:', String(v.rows[0].version).split(' ').slice(0, 2).join(' '));
    const e = await pool.query(
      "select name, installed_version from pg_available_extensions where name in ('pgcrypto','postgis','uuid-ossp')",
    );
    console.log('EXT:', JSON.stringify(e.rows));
    const t = await pool.query(
      "select schemaname || '.' || tablename AS t from pg_tables where schemaname not in ('pg_catalog','information_schema') order by 1",
    );
    console.log('TABLES:', t.rows.map((r: { t: string }) => r.t).join(','));
  } catch (err) {
    console.log('PROBE_FAIL:', (err as Error).message);
  } finally {
    await pool.end();
  }
}
void main();
