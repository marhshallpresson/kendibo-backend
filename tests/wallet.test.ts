// Test isolation: never touch a real DATABASE_URL/REDIS_URL from the machine env.
// @ts-ignore
if (typeof globalThis.KENDIBO_TEST_ISOLATION === 'undefined') { (globalThis as any).KENDIBO_TEST_ISOLATION = true; delete process.env.DATABASE_URL; delete process.env.REDIS_URL; }
// Wallet tests (node:test). Service-level tests hit modules/wallet directly;
// route tests use the real Fastify app via app.inject.
// main.ts only listens when NODE_ENV !== 'test', so set it before importing the app.
// A fake PSP adapter is injected via globalThis.__PSP__ (no network calls).
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { walletService } from '../modules/wallet/wallet.service.js';
import { signAccess } from '../packages/auth/auth.js';

const fakePsp = {
  name: 'bachs',
  createCheckout: async (input: { reference: string }) => ({ psp: 'bachs', checkoutId: `chk_test_${input.reference}`, checkoutUrl: 'https://pay.test/checkout', reference: input.reference, status: 'open' }),
  verifyByReference: async (reference: string) => ({ psp: 'bachs', chargeId: `ch_${reference}`, reference, amountKobo: 0n, currency: 'NGN', status: 'pending' }),
  verifyByChargeId: async (chargeId: string) => ({ psp: 'bachs', chargeId, reference: chargeId, amountKobo: 0n, currency: 'NGN', status: 'pending' }),
  refund: async () => ({ refundId: 'rf_test', status: 'processing' }),
  createPayout: async () => ({ payoutId: 'pay_test', status: 'pending' }),
  verifyWebhookSignature: () => true,
};
(globalThis as Record<string, unknown>).__PSP__ = { bachs: fakePsp, flutterwave: fakePsp };

let app: { inject: (opts: unknown) => Promise<{ statusCode: number; json: () => { error: { code: string }; data: { psp: string; balanceKobo: number; txns: { kind: string }[] } } }> };
before(async () => {
  process.env.NODE_ENV ??= 'test';
  ({ app } = await import('../apps/api/src/main.js'));
});

const freshUser = () => `test_${randomUUID()}`;
const auth = (sub: string) => ({ authorization: `Bearer ${signAccess(sub, [])}` });
const idem = () => ({ 'idempotency-key': `idem-${randomUUID()}` });

async function realUser() {
  const { q } = await import('../packages/database/db.js');
  const rows = await q(`INSERT INTO identity.users (email) VALUES ($1) RETURNING id`, [`w-${randomUUID()}@kendibo.local`]);
  return String(rows[0].id);
}

describe('wallet service (Postgres per-user ledger)', () => {
  it('topup credits and is visible in balance + history', async () => {
    const u = freshUser();
    assert.equal(await walletService.getBalance(u), 0);
    const txn = await walletService.credit(u, 10000, `TOPUP-test-1-${randomUUID()}`, 'topup');
    assert.equal(txn.kind, 'topup');
    assert.equal(txn.amountKobo, 10000);
    assert.equal(await walletService.getBalance(u), 10000);
    assert.deepStrictEqual((await walletService.txns(u)).map((t) => t.id), [txn.id]);
  });

  it('balance reflects payment debit + refund credit', async () => {
    const u = freshUser();
    await walletService.credit(u, 10000, `TOPUP-test-2-${randomUUID()}`, 'topup');
    await walletService.debit(u, 2500, `bk_test_pay_${randomUUID()}`, 'payment', 'bk_test');
    assert.equal(await walletService.getBalance(u), 7500);
    await walletService.credit(u, 2500, `ref_test_${randomUUID()}`, 'refund', 'bk_test');
    assert.equal(await walletService.getBalance(u), 10000);
    assert.deepStrictEqual((await walletService.txns(u)).map((t) => t.kind), ['topup', 'payment', 'refund']);
  });

  it('debit beyond balance is rejected, balance untouched', async () => {
    const u = freshUser();
    await walletService.credit(u, 500, `TOPUP-test-3-${randomUUID()}`, 'topup');
    await assert.rejects(() => walletService.debit(u, 501, `bk_test_broke_${randomUUID()}`, 'payment'), /INSUFFICIENT_FUNDS/);
    assert.equal(await walletService.getBalance(u), 500);
  });

  it('duplicate ref replays return the original txn', async () => {
    const u = freshUser();
    const ref = `TOPUP-dup-${randomUUID()}`;
    const a = await walletService.credit(u, 1000, ref, 'topup');
    const b = await walletService.credit(u, 1000, ref, 'topup');
    assert.equal(a.id, b.id);
    assert.equal(await walletService.getBalance(u), 1000);
  });
});

describe('wallet routes', () => {
  it('unauthenticated requests get 401', async () => {
    const g = await app.inject({ method: 'GET', url: '/v1/wallet' });
    assert.equal(g.statusCode, 401);
    assert.equal(g.json().error.code, 'UNAUTHENTICATED');
    const p = await app.inject({ method: 'POST', url: '/v1/wallet/topup', payload: { amountKobo: 1000 } });
    assert.equal(p.statusCode, 401);
    assert.equal(p.json().error.code, 'UNAUTHENTICATED');
  });

  it('topup initiates PSP checkout; webhook credit lands in wallet', async () => {
    const u = await realUser();
    const top = await app.inject({
      method: 'POST', url: '/v1/wallet/topup',
      headers: { ...auth(u), ...idem() },
      payload: { amountKobo: 5000 },
    });
    assert.equal(top.statusCode, 200);
    assert.equal(top.json().data.psp, 'bachs');
    const w = await app.inject({ method: 'GET', url: '/v1/wallet', headers: auth(u) });
    assert.equal(w.statusCode, 200);
    assert.equal(w.json().data.balanceKobo, 0); // nothing credited until webhook verifies
  });

  it('topup rejects out-of-range amounts with 400', async () => {
    const u = await realUser();
    for (const amountKobo of [0, 99, 50000001, 12.5, '1000', null]) {
      const r = await app.inject({
        method: 'POST', url: '/v1/wallet/topup', headers: { ...auth(u), ...idem() }, payload: { amountKobo },
      });
      assert.equal(r.statusCode, 400, `amountKobo=${JSON.stringify(amountKobo)}`);
      assert.equal(r.json().error.code, 'BAD_AMOUNT');
    }
    assert.equal(await walletService.getBalance(u), 0);
  });
});
