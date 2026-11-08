import { describe, it } from 'node:test';
import assert from 'node:assert';
import { pgEnv, backupNow } from '../modules/backup/db-backup.js';

describe('daily database backup', () => {
  it('reads a local Unix-socket URL (LiteHost) into PG* settings', () => {
    const e = pgEnv('postgresql://appuser:test-password@localhost/kendibo_db?host=/run/postgresql');
    assert.deepEqual(e, { PGHOST: '/run/postgresql', PGDATABASE: 'kendibo_db', PGUSER: 'appuser', PGPASSWORD: 'p@ss:w0rd' });
  });

  it('keeps TLS for a managed host and maps no-verify to require', () => {
    const e = pgEnv('postgres://u:pw@pg.example.com:12345/defaultdb?sslmode=no-verify');
    assert.equal(e.PGHOST, 'pg.example.com');
    assert.equal(e.PGPORT, '12345');
    assert.equal(e.PGSSLMODE, 'require');
  });

  it('does nothing unless BACKUP_DIR is set', async () => {
    const before = process.env.BACKUP_DIR;
    delete process.env.BACKUP_DIR;
    assert.deepEqual(await backupNow(), []);
    if (before !== undefined) process.env.BACKUP_DIR = before;
  });
});
