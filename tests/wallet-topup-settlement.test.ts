// Wallet top-up settlement: a verified, amount-matched Bachs charge for a wt_ payment
// credits the paying user's wallet exactly once (webhook retries, return page and
// status polls all converge on one credit). Mismatches, failures and non-top-up
// payments never touch the wallet.
import 'dotenv/config';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { walletService } from '../modules/wallet/wallet.service.js';
import { q } from '../packages/database/db.js';
import { signAccess } from '../packages/auth/auth.js';

type Verified = { psp: string; chargeId: string; reference: string; amountKobo: bigint; currency: string; status: string };
const charges = new Map<string, Verified>();
const fakePsp = {
  name: 'bachs',
  createCheckout: async (input: { reference: string }) => ({
    psp: 'bachs', checkoutId: `chk_${input.reference}`, checkoutUrl: 'https://pay.test/checkout', reference: input.reference, status: 'open',
  }),
  getCheckout: async (checkoutId: string, reference: string) => ({ psp: 'bachs', checkoutId, checkoutUrl: 'https://pay.test/checkout', reference, status: 'open' }),
  verifyByReference: async (reference: string): Promise<Verified> =>
    [...charges.values()].find((c) => c.reference === reference) ?? { psp: 'bachs', chargeId: `ch_${reference}`, reference, amountKobo: 0n, currency: 'NGN', status: 'pending' },
  verifyByChargeId: async (chargeId: string): Promise<Verified> =>
    charges.get(chargeId) ?? { psp: 'bachs', chargeId, reference: chargeId, amountKobo: 0n, currency: 'NGN', status: 'pending' },
  refund: async () => ({ refundId: 'rf_test', status: 'processing' }),
  createPayout: async () => ({ payoutId: 'pay_test', status: 'pending' }),
  verifyWebhookSignature: () => true,
};
(globalThis as Record<string, unknown>).__PSP__ = { bachs: fakePsp };

type InjectRes = { statusCode: number; json: () => any };
let app: { inject: (opts: any) => Promise<InjectRes>; close?: () => Promise<void> };
before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = '';
  process.env.REDIS_URL = '';
  ({ app } = await import('../apps/api/src/main.js'));
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
});
after(async () => { await app?.close?.().catch(() => {}); });

const auth = (sub: string) => ({ authorization: `Bearer ${signAccess(sub, [])}` });
const idem = () => ({ 'idempotency-key': `idem-${randomUUID()}` });

async function testUser(): Promise<string> {
  const rows = await q<{ id: string }>(`INSERT INTO identity.users (email) VALUES ($1) RETURNING id`, [`wt-${randomUUID()}@kendibo.local`]);
  return String(rows[0].id);
}

async function startTopup(userId: string, amountKobo: number) {
  const res = await app.inject({ method: 'POST', url: '/v1/wallet/topup', headers: { ...auth(userId), ...idem() }, payload: { amountKobo } });
  assert.equal(res.statusCode, 200);
  return String(res.json().data.reference);
}

/** Register what Bachs will report for this payment, and return the charge id. */
function setCharge(reference: string, amountKobo: number, status: string): string {
  const chargeId = `ch_${randomUUID()}`;
  charges.set(chargeId, { psp: 'bachs', chargeId, reference, amountKobo: BigInt(amountKobo), currency: 'NGN', status });
  return chargeId;
}

const sendWebhook = (chargeId: string, eventId = `evt_${randomUUID()}`) =>
  app.inject({
    method: 'POST', url: '/webhooks/payments/bachs',
    headers: { 'content-type': 'application/json' },
    payload: { id: eventId, data: { charge_id: chargeId } },
  });

describe('wallet top-up settlement', () => {
  it('stores the paying user on the payment row (not parsed from the reference)', async () => {
    const u = await testUser();
    const reference = await startTopup(u, 7500);
    const row = await q<{ user_id: string; booking_id: string; status: string }>(`SELECT user_id, booking_id, status FROM payment.payment WHERE reference=$1`, [reference]);
    assert.equal(row[0].user_id, u);
    assert.equal(row[0].booking_id, '00000000-0000-0000-0000-000000000000');
    assert.equal(row[0].status, 'pending');
    assert.equal(await walletService.getBalance(u), 0);
  });

  it('a successful webhook credits the wallet once; duplicate and retried webhooks do not double-credit', async () => {
    const u = await testUser();
    const reference = await startTopup(u, 12_000);
    const chargeId = setCharge(reference, 12_000, 'successful');

    const eventId = `evt_${randomUUID()}`;
    assert.equal((await sendWebhook(chargeId, eventId)).statusCode, 200);
    assert.equal(await walletService.getBalance(u), 12_000);

    // Same event replayed, and a fresh event id for the same charge (PSP re-send).
    assert.equal((await sendWebhook(chargeId, eventId)).statusCode, 200);
    assert.equal((await sendWebhook(chargeId)).statusCode, 200);
    assert.equal(await walletService.getBalance(u), 12_000);

    // Customer returns to the app: return page and status poll are no-ops for the balance.
    const page = await app.inject({ method: 'GET', url: `/w/payment-return?reference=${encodeURIComponent(reference)}` });
    assert.equal(page.statusCode, 200);
    const status = await app.inject({ method: 'GET', url: `/v1/payments/${encodeURIComponent(reference)}`, headers: auth(u) });
    assert.equal(status.json().data.status, 'successful');
    assert.equal(await walletService.getBalance(u), 12_000);

    const credits = await q(`SELECT 1 FROM payment.wallet_txn WHERE ref=$1`, [reference]);
    assert.equal(credits.length, 1);
  });

  it('the return/verify path credits instantly when the webhook has not arrived, then the late webhook adds nothing', async () => {
    const u = await testUser();
    const reference = await startTopup(u, 3_000);
    const chargeId = setCharge(reference, 3_000, 'successful');

    const status = await app.inject({ method: 'GET', url: `/v1/payments/${encodeURIComponent(reference)}`, headers: auth(u) });
    assert.equal(status.json().data.status, 'successful');
    assert.equal(await walletService.getBalance(u), 3_000);

    assert.equal((await sendWebhook(chargeId)).statusCode, 200);
    await app.inject({ method: 'GET', url: `/w/payment-return?reference=${encodeURIComponent(reference)}` });
    assert.equal(await walletService.getBalance(u), 3_000);
  });

  it('repairs a payment marked successful whose credit never landed, still only once', async () => {
    const u = await testUser();
    const reference = await startTopup(u, 4_000);
    await q(`UPDATE payment.payment SET status='successful' WHERE reference=$1`, [reference]); // crash after the flip, before the credit
    assert.equal(await walletService.getBalance(u), 0);
    for (let i = 0; i < 3; i++) await app.inject({ method: 'GET', url: `/v1/payments/${encodeURIComponent(reference)}`, headers: auth(u) });
    assert.equal(await walletService.getBalance(u), 4_000);
  });

  it('an amount mismatch is rejected and never credits', async () => {
    const u = await testUser();
    const reference = await startTopup(u, 10_000);
    const chargeId = setCharge(reference, 1_000, 'successful'); // PSP says less than recorded
    const res = await sendWebhook(chargeId);
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, 'AMOUNT_MISMATCH');
    await app.inject({ method: 'GET', url: `/v1/payments/${encodeURIComponent(reference)}`, headers: auth(u) });
    assert.equal(await walletService.getBalance(u), 0);
    const row = await q<{ status: string }>(`SELECT status FROM payment.payment WHERE reference=$1`, [reference]);
    assert.equal(row[0].status, 'pending');
  });

  it('a failed charge never credits', async () => {
    const u = await testUser();
    const reference = await startTopup(u, 5_000);
    const chargeId = setCharge(reference, 5_000, 'failed');
    assert.equal((await sendWebhook(chargeId)).statusCode, 200);
    await app.inject({ method: 'GET', url: `/v1/payments/${encodeURIComponent(reference)}`, headers: auth(u) });
    assert.equal(await walletService.getBalance(u), 0);
  });

  it('a top-up with no stored owner is flagged, not credited', async () => {
    const { settleWalletTopup } = await import('../modules/payments/wallet-topup.js');
    const u = await testUser();
    const reference = await startTopup(u, 2_000);
    await q(`UPDATE payment.payment SET status='successful', user_id=NULL WHERE reference=$1`, [reference]);
    assert.deepEqual(await settleWalletTopup(reference), { credited: false, reason: 'no_owner' });
    assert.equal(await walletService.getBalance(u), 0);
  });

  it('non-top-up payments do not touch the wallet', async () => {
    const { bookingService } = await import('../modules/bookings/booking.service.js');
    const owner = await testUser();
    const booking = await bookingService.create(owner, {
      serviceId: 'svc_ac_general', addressId: '',
      scheduledAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(), idempotencyKey: `wt-${randomUUID()}`,
    });
    const start = await app.inject({
      method: 'POST', url: `/v1/bookings/${booking.id}/payments`,
      headers: { ...auth(owner), ...idem() }, payload: { amountKobo: String(booking.priceKobo), email: 'buyer@kendibo.test' },
    });
    assert.equal(start.statusCode, 200);
    const reference = String(start.json().data.reference);
    const recorded = await q<{ amount_kobo: string; user_id: string | null }>(`SELECT amount_kobo, user_id FROM payment.payment WHERE reference=$1`, [reference]);
    assert.equal(recorded[0].user_id, null);
    const chargeId = setCharge(reference, Number(recorded[0].amount_kobo), 'successful');
    assert.equal((await sendWebhook(chargeId)).statusCode, 200);
    const paid = await q<{ status: string }>(`SELECT status FROM payment.payment WHERE reference=$1`, [reference]);
    assert.equal(paid[0].status, 'successful');
    assert.equal(await walletService.getBalance(owner), 0);
    assert.equal((await q(`SELECT 1 FROM payment.wallet_txn WHERE ref=$1`, [reference])).length, 0);
  });
});
