import { describe, it } from 'node:test';
import assert from 'node:assert';
import { koboToBachsDecimal, bachsDecimalToKobo, koboToFlutterwaveMajor } from '../modules/payments/money.js';
import { postCollection, postSettlement, trialBalance, openPeriod, reverseJournal } from '../modules/ledger/ledger.service.js';
import { transition } from '../modules/job-engine/job.machine.js';

// Test isolation: never touch a real DATABASE_URL/REDIS_URL from the machine env.
// @ts-ignore
if (typeof globalThis.KENDIBO_TEST_ISOLATION === 'undefined') { (globalThis as any).KENDIBO_TEST_ISOLATION = true; delete process.env.DATABASE_URL; delete process.env.REDIS_URL; }
describe('money boundaries', () => {
  it('kobo <-> bachs decimal', () => {
    assert.equal(koboToBachsDecimal(700000n), '7000.00');
    assert.equal(bachsDecimalToKobo('7000.00'), 700000n);
  });
  it('kobo -> flutterwave major', () => {
    assert.equal(koboToFlutterwaveMajor(200000n), 2000);
  });
});

describe('ledger (Commerce General Ledger pattern)', () => {
  it('collection + settlement balance', async () => {
    await openPeriod('2026-10-test');
    await postCollection('t1', 1000000n, '2026-10-test');
    await postSettlement('t1-settle', 1000000n, 700000n, '2026-10-test');
    assert.equal((await trialBalance()).balanced, true);
  });
  it('reversal balances', async () => {
    await openPeriod('2026-10-rev');
    const j = await postCollection('r1', 50000n, '2026-10-rev');
    await reverseJournal(j, '2026-10-rev');
    assert.equal((await trialBalance()).balanced, true);
  });
});

describe('adversarial', () => {
  it('same webhook twice -> one posting (idempotent ref)', async () => {
    await openPeriod('2026-10-idem');
    await postCollection('dup-ref', 100000n, '2026-10-idem');
    await postCollection('dup-ref', 100000n, '2026-10-idem');
    assert.equal((await trialBalance()).balanced, true);
  });
  it('illegal job transition rejected', async () => {
    await assert.rejects(() => transition('j1', 'DRAFT', 'COMPLETED', 't'), /ILLEGAL_TRANSITION/);
  });
});
