import { describe, it } from 'node:test';
import assert from 'node:assert';
import { localDb } from '../packages/database/local.js';

// Test isolation: never touch a real DATABASE_URL/REDIS_URL from the machine env.
// @ts-ignore
if (typeof globalThis.Kendibo_TEST_ISOLATION === 'undefined') { (globalThis as any).Kendibo_TEST_ISOLATION = true; delete process.env.DATABASE_URL; delete process.env.REDIS_URL; }
describe('schema (PRD Appendix B, local pg-mem)', () => {
  it('reference data seeded', () => {
    const db = localDb();
    const count = (t: string) => (db.public.query(`SELECT count(*) c FROM ${t}`) as unknown as { rows: { c: number }[] }).rows[0].c;
    assert.equal(count('geo.city'), 3);
    assert.equal(count('geo.zone'), 6);
    assert.ok(count('catalog.category') >= 66, 'full catalogue (58 landing categories + products) is seeded');
    assert.equal(count('catalog.service'), 5);
    assert.equal(count('ledger.account'), 12);
    assert.equal(count('configuration.flag'), 10);
  });
  it('money guards enforced: kobo>0, unique reference', async () => {
    const db = localDb();
    const bad = () =>
      db.public.query(
        `INSERT INTO payment.payment (booking_id, psp, reference, amount_kobo) VALUES (gen_random_uuid(),'paga','dup-ref-test',0)`,
      );
    assert.throws(bad, /check constraint/i);
    db.public.query(
      `INSERT INTO payment.payment (booking_id, psp, reference, amount_kobo) VALUES (gen_random_uuid(),'paga','dup-ref-test',100000)`,
    );
    assert.throws(
      () =>
        db.public.query(
          `INSERT INTO payment.payment (booking_id, psp, reference, amount_kobo) VALUES (gen_random_uuid(),'paga','dup-ref-test',100000)`,
        ),
      /duplicate/i,
    );
    void bad;
  });
  it('review ratings bounded 1-5, ledger lines DR-xor-CR', () => {
    const db = localDb();
    assert.throws(
      () =>
        db.public.query(
          `INSERT INTO payment.review (booking_id, provider, quality, punctuality, professionalism, result) VALUES (gen_random_uuid(),6,5,5,5,5)`,
        ),
      /check constraint/i,
    );
    const j = (
      db.public.query(
        `INSERT INTO ledger.journal (reference, period) VALUES ('t-schema-1','2026-10') RETURNING id`,
      ) as unknown as { rows: { id: string }[] }
    ).rows[0].id;
    assert.throws(
      () =>
        db.public.query(
          `INSERT INTO ledger.entry (journal_id, account_code, debit_kobo, credit_kobo) VALUES ('${j}','1000',5000,5000)`,
        ),
      /check constraint/i,
    );
  });
});
