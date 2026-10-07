import 'dotenv/config';
import { Pool } from 'pg';

async function main(): Promise<void> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const checks: [string, string][] = [
    ['uuid', 'SELECT gen_random_uuid() AS id'],
    ['nickname', "SELECT column_name FROM information_schema.columns WHERE table_schema='identity' AND table_name='users' AND column_name='nickname'"],
    ['dob', "SELECT column_name FROM information_schema.columns WHERE table_schema='identity' AND table_name='users' AND column_name='dob'"],
    ['bank_changed_at', "SELECT column_name FROM information_schema.columns WHERE table_schema='provider' AND table_name='provider' AND column_name='bank_changed_at'"],
    ['quote_provider_text', "SELECT data_type FROM information_schema.columns WHERE table_schema='booking' AND table_name='quote' AND column_name='provider_id'"],
    ['request_tables', "SELECT count(*) c FROM information_schema.tables WHERE table_schema='booking' AND table_name IN ('service_request','request_offer')"],
    ['wallet_ref_unique', "SELECT count(*) c FROM pg_indexes WHERE schemaname='payment' AND tablename='wallet_txn'"],
    ['categories', 'SELECT count(*) c FROM catalog.category'],
    ['services', 'SELECT count(*) c FROM catalog.service'],
    ['accounts', 'SELECT count(*) c FROM ledger.account'],
    ['flags', 'SELECT count(*) c FROM configuration.flag'],
    ['cities', 'SELECT count(*) c FROM geo.city'],
  ];
  for (const [name, sql] of checks) {
    try {
      const r = await pool.query(sql);
      console.log(`${name}:`, JSON.stringify(r.rows));
    } catch (err) {
      console.log(`${name}: FAIL`, (err as Error).message.split('\n')[0]);
    }
  }
  await pool.end();
}
void main();
