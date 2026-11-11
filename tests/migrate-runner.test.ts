// Migrations run once per database. Regression for the replay-every-deploy
// runner, which re-ran one-off "purge" scripts against production each deploy.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newDb } from 'pg-mem';
import { runMigrations, type MigrationDb } from '../packages/database/migrate.js';

function memDb(): MigrationDb {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg() as unknown as { Pool: new () => MigrationDb };
  return new Pool();
}
function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'kendibo-mig-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}
const count = async (db: MigrationDb, sql: string) => Number((await db.query(sql)).rows[0].n);

const CORE = `CREATE SCHEMA identity; CREATE TABLE identity.users (id INT PRIMARY KEY, phone TEXT, email TEXT);`;
const PURGE = `DELETE FROM identity.users WHERE email IS NULL;`; // stands in for 019_purge_demo_content.sql

describe('tracked migrations', () => {
  it('fresh database: runs each file once; a purge script never runs again', async () => {
    const db = memDb();
    const dir = dirWith({ '001_core.sql': CORE, '002_purge.sql': PURGE });
    const first = await runMigrations(db, { dir });
    assert.deepEqual(first.applied, ['001_core.sql', '002_purge.sql']);

    // A real WhatsApp customer signs up with a phone number and no email.
    await db.query(`INSERT INTO identity.users (id, phone) VALUES (1, '2348030000000')`);
    const second = await runMigrations(db, { dir });
    assert.deepEqual(second.applied, [], 'nothing re-runs');
    assert.equal(second.alreadyApplied, 2);
    assert.equal(await count(db, `SELECT count(*) AS n FROM identity.users`), 1, 'the customer is still there');
  });

  it('applies only files added since the last run', async () => {
    const db = memDb();
    const dir = dirWith({ '001_core.sql': CORE });
    await runMigrations(db, { dir });
    writeFileSync(join(dir, '002_add.sql'), `ALTER TABLE identity.users ADD COLUMN name TEXT;`);
    const r = await runMigrations(db, { dir });
    assert.deepEqual(r.applied, ['002_add.sql']);
  });

  it('existing untracked database: refuses to run, then baselines without re-running', async () => {
    const db = memDb();
    await db.query(CORE);
    await db.query(`INSERT INTO identity.users (id, phone) VALUES (1, '2348030000000')`);
    const dir = dirWith({ '001_core.sql': CORE, '002_purge.sql': PURGE, '003_new.sql': `ALTER TABLE identity.users ADD COLUMN name TEXT;` });

    await assert.rejects(() => runMigrations(db, { dir }), /UNTRACKED_DATABASE/);
    assert.equal(await count(db, `SELECT count(*) AS n FROM identity.users`), 1, 'refusal changed nothing');

    const r = await runMigrations(db, { dir, baselineThrough: '002' });
    assert.deepEqual(r.baselined, ['001_core.sql', '002_purge.sql']);
    assert.deepEqual(r.applied, ['003_new.sql'], 'only the file after the baseline runs');
    assert.equal(await count(db, `SELECT count(*) AS n FROM identity.users`), 1, 'the purge was recorded, not run');

    const again = await runMigrations(db, { dir, baselineThrough: '002' });
    assert.deepEqual(again.applied, []);
    assert.deepEqual(again.baselined, [], 'baseline is ignored once tracked');
  });

  it('refuses a baseline on an empty database', async () => {
    const db = memDb();
    const dir = dirWith({ '001_core.sql': CORE });
    await assert.rejects(() => runMigrations(db, { dir, baselineThrough: '001' }), /BASELINE_ON_EMPTY/);
  });

  it('dry run lists pending files and changes nothing', async () => {
    const db = memDb();
    const dir = dirWith({ '001_core.sql': CORE });
    const r = await runMigrations(db, { dir, dryRun: true });
    assert.deepEqual(r.pending, ['001_core.sql']);
    assert.deepEqual(r.applied, []);
    await assert.rejects(() => db.query(`SELECT 1 FROM identity.users`), 'table was not created');
  });

  it('a failing file is not recorded and names itself', async () => {
    const db = memDb();
    const dir = dirWith({ '001_core.sql': CORE, '002_bad.sql': `ALTER TABLE identity.nope ADD COLUMN x INT;` });
    await assert.rejects(() => runMigrations(db, { dir }), /MIGRATION_FAILED 002_bad\.sql/);
    assert.equal(await count(db, `SELECT count(*) AS n FROM public.schema_migrations WHERE filename='002_bad.sql'`), 0);
  });

  it('rejects files without a number prefix', async () => {
    const db = memDb();
    const dir = dirWith({ 'core.sql': CORE });
    await assert.rejects(() => runMigrations(db, { dir }), /MIGRATION_NAME/);
  });
});
