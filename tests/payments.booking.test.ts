// Booking payment contract: the charge amount is server-authoritative.
// The client may only confirm the price the pricing engine froze on the booking
// (or an accepted quote) — accepting a client-computed total would let the
// amount charged drift from booking.price_kobo. Ownership is enforced too.
import 'dotenv/config';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { bookingService } from '../modules/bookings/booking.service.js';
import { q } from '../packages/database/db.js';
import { signAccess } from '../packages/auth/auth.js';

type Verified = { psp: string; chargeId: string; reference: string; amountKobo: bigint; currency: string; status: string; code: string };
const fakePsp = {
  name: 'paga',
  createCheckout: async (input: { reference: string }) => ({
    psp: 'paga', checkoutId: `chk_test_${input.reference}`,
    checkoutUrl: 'https://pay.test/checkout', reference: input.reference, status: 'open',
  }),
  getCheckout: async (checkoutId: string, reference: string) => ({ psp: 'paga', checkoutId, checkoutUrl: 'https://pay.test/checkout', reference, status: 'open' }),
  verifyByReference: async (reference: string): Promise<Verified> => ({ psp: 'paga', chargeId: reference, reference, amountKobo: 0n, currency: 'NGN', status: 'pending', code: '1' }),
  verifyByChargeId: async (chargeId: string): Promise<Verified> => ({ psp: 'paga', chargeId, reference: chargeId, amountKobo: 0n, currency: 'NGN', status: 'pending', code: '1' }),
  refund: async () => ({ refundId: 'rf_test', status: 'processing' }),
  createPayout: async () => ({ payoutId: 'pay_test', status: 'pending' }),
  verifyWebhookSignature: () => true,
};
(globalThis as Record<string, unknown>).__PSP__ = { paga: fakePsp };

// Isolate BEFORE importing main.js (which loads dotenv + touches the DB).
process.env.NODE_ENV = 'test';

type InjectRes = { statusCode: number; json: () => any };
let app: { inject: (opts: any) => Promise<InjectRes>; close?: () => Promise<void> };
before(async () => {
  process.env.DATABASE_URL = '';
  process.env.REDIS_URL = '';
  ({ app } = await import('../apps/api/src/main.js'));
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
});
after(async () => {
  await app?.close?.().catch(() => {});
});

const auth = (sub: string) => ({ authorization: `Bearer ${signAccess(sub, [])}` });
const idem = () => ({ 'idempotency-key': `idem-${randomUUID()}` });

async function testUser(): Promise<string> {
  const rows = await q<{ id: string }>(
    `INSERT INTO identity.users (email) VALUES ($1) RETURNING id`,
    [`pay-${randomUUID()}@kendibo.local`],
  );
  return String(rows[0].id);
}

async function createBooking(userId: string) {
  return bookingService.create(userId, {
    serviceId: 'svc_ac_general',
    addressId: '',
    scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    idempotencyKey: `pay-${randomUUID()}`,
  });
}

describe('booking payments are server-priced', () => {
  it('creates a storefront WhatsApp link from a formatted business number', async () => {
    const { waConnect } = await import('../modules/storefront/storefront.service.js');
    const previous = process.env.WHATSAPP_BUSINESS_NUMBER;
    try {
      process.env.WHATSAPP_BUSINESS_NUMBER = '+234 800 123 4567';
      assert.match(waConnect({ name: 'Example business', slug: 'example-shop' }) ?? '', /^https:\/\/wa\.me\/2348001234567\?/);
      process.env.WHATSAPP_BUSINESS_NUMBER = 'invalid';
      assert.equal(waConnect({ name: 'Example business', slug: 'example-shop' }), null);
    } finally {
      if (previous === undefined) delete process.env.WHATSAPP_BUSINESS_NUMBER;
      else process.env.WHATSAPP_BUSINESS_NUMBER = previous;
    }
  });
  it('does not settle a payment reference we never issued', async () => {
    const { PaymentService } = await import('../modules/payments/payment.service.js');
    const { PaymentSettlement } = await import('../modules/payments/settlement.js');
    const settlement = new PaymentSettlement(new PaymentService({ paga: fakePsp as never }), { confirm: async () => {}, notify: async () => {}, track: () => {} });
    assert.equal((await settlement.settle(`kb_b_${randomUUID().replace(/-/g, '').slice(0, 24)}`)).status, 'not_found');
  });
  it('recovers a checkout on replay and rejects a changed amount', async () => {
    const { PaymentService } = await import('../modules/payments/payment.service.js');
    const payments = new PaymentService({ paga: fakePsp as never });
    const booking = await createBooking(await testUser());
    const input = { bookingId: booking.id, amountKobo: BigInt(booking.priceKobo), idempotencyKey: `idem_${randomUUID()}` };
    const first = await payments.createCheckout(input);
    const replay = await payments.createCheckout(input);
    assert.equal(replay.checkoutUrl, first.checkoutUrl);
    assert.equal(replay.checkoutId, first.checkoutId);
    await assert.rejects(() => payments.createCheckout({ ...input, amountKobo: input.amountKobo + 1n }), /PAYMENT_REFERENCE_CONFLICT/);
    const expired = new PaymentService({ paga: { ...fakePsp, getCheckout: async () => { throw new Error('CHECKOUT_NOT_OPEN'); } } as never });
    await assert.rejects(() => expired.createCheckout(input), /CHECKOUT_NOT_OPEN/);
  });
  it('charges the server price even when the client sends its own total', async () => {
    const owner = await testUser();
    const booking = await createBooking(owner);
    // A stale app bundle computes subtotal + VAT + flat fee — never trusted.
    const clientTotal = String(BigInt(booking.priceKobo) - 50000n);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/bookings/${booking.id}/payments`,
      headers: { ...auth(owner), ...idem() },
      payload: { amountKobo: clientTotal, email: 'buyer@kendibo.test' },
    });
    assert.equal(res.statusCode, 200, 'a mismatched client total must not strand the payment');
    assert.ok(res.json().data.checkoutUrl, 'pay page url is returned');

    // pg-mem misses indexed TEXT lookups; scan + filter in JS.
    const rows = await q<Record<string, unknown>>(`SELECT reference, amount_kobo, booking_id, user_id FROM payment.payment`);
    const intent = rows.find((r) => String(r.booking_id) === String(booking.id));
    assert.ok(intent, 'a payment intent was recorded');
    assert.match(String(intent!.reference), /^kb_b_[0-9a-f]{24}$/, 'server-minted reference');
    assert.equal(String(intent!.user_id), owner, 'payer is read from our booking, not the client');
    assert.equal(
      String(intent!.amount_kobo),
      String(booking.priceKobo),
      'the recorded charge is the booking price snapshot, not the client total',
    );
  });

  it('accepts the server-priced amount and returns a Paga checkout session', async () => {
    const owner = await testUser();
    const booking = await createBooking(owner);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/bookings/${booking.id}/payments`,
      headers: { ...auth(owner), ...idem() },
      payload: { amountKobo: String(booking.priceKobo), email: 'buyer@kendibo.test' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.psp, 'paga');
    assert.ok(res.json().data.checkoutUrl, 'pay page url is returned');
  });

  it('confirms a paid checkout without the webhook, settles once, and returns the customer', async () => {
    const owner = await testUser();
    const booking = await createBooking(owner);
    const start = await app.inject({
      method: 'POST', url: `/v1/bookings/${booking.id}/payments`,
      headers: { ...auth(owner), ...idem() },
      payload: { amountKobo: String(booking.priceKobo), email: 'buyer@kendibo.test' },
    });
    assert.equal(start.statusCode, 200);
    const reference = String(start.json().data.reference);

    const recorded = await q<{ amount_kobo: string; status: string; psp: string }>(`SELECT amount_kobo, status, psp FROM payment.payment WHERE reference=$1`, [reference]);
    assert.equal(recorded[0]?.status, 'pending', `intent recorded as pending (${JSON.stringify(recorded[0])})`);
    const original = fakePsp.verifyByReference;
    fakePsp.verifyByReference = async (ref: string) => ({ psp: 'paga', chargeId: ref, reference: ref, amountKobo: BigInt(String(recorded[0].amount_kobo)), currency: 'NGN', status: 'successful', code: '0' });
    try {
      // Paga's callback carries the amount; settle runs in the background after the 200.
      const cb = await app.inject({ method: 'POST', url: '/webhooks/payments/paga', headers: { 'content-type': 'application/json' }, payload: {
        notificationId: randomUUID(), statusCode: '0', externalReferenceNumber: reference, state: 'CONSUMED', outstandingBalance: 0,
        paymentAmount: Number(recorded[0].amount_kobo) / 100, cumulativePaymentAmount: Number(recorded[0].amount_kobo) / 100, hash: 'x',
      } });
      assert.equal(cb.statusCode, 200);
      assert.equal(cb.json().status, 'SUCCESS');
      for (let i = 0; i < 40; i++) { // the settlement runs after the acknowledgement
        if ((await q<{ status: string }>(`SELECT status FROM payment.payment WHERE reference=$1`, [reference]))[0]?.status === 'successful') break;
        await new Promise((r) => setTimeout(r, 25));
      }
      const page = await app.inject({ method: 'GET', url: `/w/payment-return?reference=${encodeURIComponent(reference)}` });
      assert.equal(page.statusCode, 200);
      assert.match((page as unknown as { body: string }).body, /Payment received/);
      assert.match((page as unknown as { body: string }).body, /kendibo:\/\/payment\/callback\?reference=/);

      const status = await app.inject({ method: 'GET', url: `/v1/payments/${encodeURIComponent(reference)}`, headers: auth(owner) });
      assert.equal(status.json().data.status, 'successful');
      assert.equal(status.json().data.receivedKobo, String(recorded[0].amount_kobo));
      const journals = await q(`SELECT 1 FROM ledger.journal WHERE reference=$1`, [reference]);
      assert.equal(journals.length, 1, 'collection is posted exactly once');
    } finally {
      fakePsp.verifyByReference = original;
    }
  });

  it('requires a session and refuses someone else\'s booking', async () => {
    const owner = await testUser();
    const stranger = await testUser();
    const booking = await createBooking(owner);
    const payload = { amountKobo: String(booking.priceKobo), email: 'buyer@kendibo.test' };

    const anon = await app.inject({
      method: 'POST', url: `/v1/bookings/${booking.id}/payments`,
      headers: idem(), payload,
    });
    assert.equal(anon.statusCode, 401);

    const intruder = await app.inject({
      method: 'POST', url: `/v1/bookings/${booking.id}/payments`,
      headers: { ...auth(stranger), ...idem() }, payload,
    });
    assert.equal(intruder.statusCode, 403);
  });
});
