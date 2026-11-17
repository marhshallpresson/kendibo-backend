// Test isolation: scrubbed in before() AFTER main.js import (main loads dotenv
// which would otherwise restore the live DATABASE_URL from .env).
// Wallet tests (node:test). Service-level tests hit modules/wallet directly;
// route tests use the real Fastify app via app.inject.
// main.ts only listens when NODE_ENV !== 'test', so set it before importing the app.
// A fake PSP adapter is injected via globalThis.__PSP__ (no network calls).
import 'dotenv/config';
import { describe, it, before, after } from 'node:test';
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
(globalThis as Record<string, unknown>).__PSP__ = { bachs: fakePsp };

let app: { inject: (opts: unknown) => Promise<{ statusCode: number; json: () => Record<string, any> }>; close?: () => Promise<void> };
before(async () => {
  // Isolate BEFORE main.js import (main loads dotenv + touches DB at import):
  // force test so main never listens on :3000, neutralize URLs to '' so
  // dotenv cannot restore the live URL and openPeriod uses pg-mem.
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = '';
  process.env.REDIS_URL = '';
  ({ app } = await import('../apps/api/src/main.js'));
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
});
after(async () => {
  await app?.close?.().catch(() => {});
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
  it('allows production top-ups now that checkout callbacks credit the wallet', async () => {
    const u = await realUser();
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/wallet/topup', headers: { ...auth(u), ...idem() }, payload: { amountKobo: 5000 } });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().data.psp, 'bachs');
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
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

async function makeBooking(userId: string) {
  const { q } = await import('../packages/database/db.js');
  const svc = await q(`SELECT id FROM catalog.service LIMIT 1`);
  if (!svc[0]) throw new Error('no catalog.service row available for wallet test');
  const rows = await q<{ id: string; price_kobo: string | number }>(
    `INSERT INTO booking.booking (user_id, service_id, address_id, status, price_kobo, price_snapshot, scheduled_at, idempotency_key)
     VALUES ($1, $2, NULL, 'REQUESTED', 5000, '{}'::jsonb, now(), $3) RETURNING id, price_kobo`,
    [userId, svc[0].id, `kt_${randomUUID()}`],
  );
  return { id: String(rows[0].id), priceKobo: Number(rows[0].price_kobo) };
}

describe('pay booking from wallet', () => {
  it('requires auth', async () => {
    const g = await app.inject({ method: 'POST', url: '/v1/bookings/x/pay-with-wallet' });
    assert.equal(g.statusCode, 401);
    assert.equal(g.json().error.code, 'UNAUTHENTICATED');
  });

  it('requires an Idempotency-Key header', async () => {
    const u = await realUser();
    const b = await makeBooking(u);
    const r = await app.inject({ method: 'POST', url: `/v1/bookings/${b.id}/pay-with-wallet`, headers: auth(u) });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error.code, 'IDEMPOTENCY_REQUIRED');
  });

  it('402 when balance is insufficient; balance untouched', async () => {
    const u = await realUser();
    const b = await makeBooking(u);
    await walletService.credit(u, 1000, `TOPUP-${randomUUID()}`, 'topup');
    const r = await app.inject({
      method: 'POST', url: `/v1/bookings/${b.id}/pay-with-wallet`,
      headers: { ...auth(u), ...idem() }, payload: {},
    });
    assert.equal(r.statusCode, 402);
    assert.equal(r.json().error.code, 'INSUFFICIENT_FUNDS');
    assert.equal(await walletService.getBalance(u), 1000);
  });

  it('debits wallet, charges the SERVER price, and is idempotent on retry', async () => {
    const u = await realUser();
    const b = await makeBooking(u);
    await walletService.credit(u, b.priceKobo + 5000, `TOPUP-${randomUUID()}`, 'topup');
    const key = `idem-${randomUUID()}`;

    const first = await app.inject({
      method: 'POST', url: `/v1/bookings/${b.id}/pay-with-wallet`,
      headers: { ...auth(u), 'idempotency-key': key }, payload: { amountKobo: '1' },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().data.status, 'successful');
    assert.equal(first.json().data.method, 'WALLET');
    assert.equal(Number(first.json().data.amountKobo), b.priceKobo); // client-sent 1 is ignored
    const afterFirst = b.priceKobo + 5000 - b.priceKobo;

    // Retry with the SAME key must not charge again.
    const second = await app.inject({
      method: 'POST', url: `/v1/bookings/${b.id}/pay-with-wallet`,
      headers: { ...auth(u), 'idempotency-key': key }, payload: {},
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().data.reference, first.json().data.reference);
    assert.equal(await walletService.getBalance(u), afterFirst);

    const pays = await (await import('../packages/database/db.js')).q(
      `SELECT count(*)::int AS n FROM payment.payment WHERE booking_id=$1 AND status='successful'`, [b.id],
    );
    assert.equal(pays[0].n, 1);
  });

  it('a different Idempotency-Key on an already-paid booking does not double charge', async () => {
    const u = await realUser();
    const b = await makeBooking(u);
    await walletService.credit(u, b.priceKobo * 3, `TOPUP-${randomUUID()}`, 'topup');
    const pay = async (key: string) => app.inject({
      method: 'POST', url: `/v1/bookings/${b.id}/pay-with-wallet`,
      headers: { ...auth(u), 'idempotency-key': key }, payload: {},
    });
    assert.equal((await pay(`idem-${randomUUID()}`)).statusCode, 200);
    const balAfterFirst = await walletService.getBalance(u);
    const retry = await pay(`idem-${randomUUID()}`);
    assert.equal(retry.statusCode, 200); // settled booking replays as paid
    assert.equal(await walletService.getBalance(u), balAfterFirst);
  });

  it("cannot pay someone else's booking", async () => {
    const owner = await realUser();
    const stranger = await realUser();
    const b = await makeBooking(owner);
    await walletService.credit(stranger, 100000, `TOPUP-${randomUUID()}`, 'topup');
    const r = await app.inject({
      method: 'POST', url: `/v1/bookings/${b.id}/pay-with-wallet`,
      headers: { ...auth(stranger), ...idem() }, payload: {},
    });
    assert.equal(r.statusCode, 403);
    assert.equal(r.json().error.code, 'FORBIDDEN');
    assert.equal(await walletService.getBalance(stranger), 100000);
  });
});
