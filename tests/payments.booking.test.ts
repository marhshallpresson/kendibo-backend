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

const fakePsp = {
  name: 'bachs',
  createCheckout: async (input: { reference: string }) => ({
    psp: 'bachs', checkoutId: `chk_test_${input.reference}`,
    checkoutUrl: 'https://pay.test/checkout', reference: input.reference, status: 'open',
  }),
  verifyByReference: async (reference: string) => ({ psp: 'bachs', chargeId: `ch_${reference}`, reference, amountKobo: 0n, currency: 'NGN', status: 'pending' }),
  verifyByChargeId: async (chargeId: string) => ({ psp: 'bachs', chargeId, reference: chargeId, amountKobo: 0n, currency: 'NGN', status: 'pending' }),
  refund: async () => ({ refundId: 'rf_test', status: 'processing' }),
  createPayout: async () => ({ payoutId: 'pay_test', status: 'pending' }),
  verifyWebhookSignature: () => true,
};
(globalThis as Record<string, unknown>).__PSP__ = { bachs: fakePsp, flutterwave: fakePsp };

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
  it('rejects an amount that does not match the booking price snapshot', async () => {
    const owner = await testUser();
    const booking = await createBooking(owner);
    const wrong = String(BigInt(booking.priceKobo) + 1n);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/bookings/${booking.id}/payments`,
      headers: { ...auth(owner), ...idem() },
      payload: { amountKobo: wrong, email: 'buyer@kendibo.test' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'AMOUNT_MISMATCH');
    assert.match(res.json().error.message, new RegExp(String(booking.priceKobo)));
  });

  it('accepts the server-priced amount and returns a Bachs checkout session', async () => {
    const owner = await testUser();
    const booking = await createBooking(owner);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/bookings/${booking.id}/payments`,
      headers: { ...auth(owner), ...idem() },
      payload: { amountKobo: String(booking.priceKobo), email: 'buyer@kendibo.test' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.psp, 'bachs');
    assert.ok(res.json().data.checkoutUrl, 'hosted checkout url is returned');
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
