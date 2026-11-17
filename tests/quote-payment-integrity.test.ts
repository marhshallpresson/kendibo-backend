// Payment correctness: the amount charged for a booking is always the agreed price.
//  - the accepted quote total is what checkout charges (and what the booking row holds)
//  - a re-quote supersedes any open Paga request for the old amount; the stale one never confirms
//  - a second checkout after payment is refused (409 ALREADY_PAID)
//  - the WhatsApp pay link uses the same expected charge
//  - settlement moves the booking forward so the vendor sees it as paid
// Paga's HTTP is a fake adapter; callbacks are persisted and settled like production (only the hash is faked).
import 'dotenv/config';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { walletService } from '../modules/wallet/wallet.service.js';
import { bookingService } from '../modules/bookings/booking.service.js';
import { quoteService } from '../modules/quotes/quote.service.js';
import { expectedChargeKobo } from '../modules/payments/expected-charge.js';
import { q } from '../packages/database/db.js';
import { signAccess } from '../packages/auth/auth.js';

type Verified = { psp: string; chargeId: string; reference: string; amountKobo: bigint; currency: string; status: string; code: string };
const pagaSays = new Map<string, { status: string; code: string }>();
const requested = new Map<string, bigint>();
const verifyFake = async (reference: string): Promise<Verified> => ({
  psp: 'paga', chargeId: reference, reference, amountKobo: requested.get(reference) ?? 0n, currency: 'NGN',
  ...(pagaSays.get(reference) ?? { status: 'pending', code: '1' }),
});
const fakePsp = {
  name: 'paga',
  createCheckout: async (input: { reference: string; amountKobo: bigint }) => {
    requested.set(input.reference, input.amountKobo);
    return { psp: 'paga', checkoutId: input.reference, checkoutUrl: `https://pay.test/${input.reference}`, reference: input.reference, status: 'open' };
  },
  getCheckout: async (checkoutId: string, reference: string) => ({ psp: 'paga', checkoutId, checkoutUrl: `https://pay.test/${reference}`, reference, status: 'open' }),
  verifyByReference: verifyFake,
  verifyByChargeId: verifyFake,
  refund: async () => ({ refundId: 'rf_test', status: 'processing' }),
  createPayout: async () => ({ payoutId: 'pay_test', status: 'pending' }),
  verifyWebhookSignature: () => true,
};
(globalThis as Record<string, unknown>).__PSP__ = { paga: fakePsp };

type InjectRes = { statusCode: number; json: () => any; body: string };
let app: { inject: (opts: any) => Promise<InjectRes>; close?: () => Promise<void> };
let payLinkTarget: (waId: string, bookingId: string) => Promise<{ url: string } | { done: string }>;
let payLinkPreview: (waId: string, bookingId: string) => Promise<{ preview: { amount: string } } | { done: string }>;
before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = '';
  process.env.REDIS_URL = '';
  ({ app } = await import('../apps/api/src/main.js'));
  ({ payLinkTarget, payLinkPreview } = await import('../modules/whatsapp/whatsapp.bot.js') as never);
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
});
after(async () => { await app?.close?.().catch(() => {}); });

const auth = (sub: string) => ({ authorization: `Bearer ${signAccess(sub, [])}` });
const naira = (kobo: number | bigint) => Number(kobo) / 100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check: () => Promise<boolean>, ms = 2000) {
  for (let t = 0; t < ms; t += 25) { if (await check()) return true; await sleep(25); }
  return false;
}
const rowOf = async (reference: string) => (await q<Record<string, any>>(`SELECT * FROM payment.payment WHERE reference=$1`, [reference]))[0];
const statusOfBooking = async (id: string) => String((await q<{ status: string }>(`SELECT status FROM booking.booking WHERE id=$1`, [id]))[0]?.status);
const priceOfBooking = async (id: string) => String((await q<{ price_kobo: string }>(`SELECT price_kobo FROM booking.booking WHERE id=$1`, [id]))[0]?.price_kobo);
const credits = async (reference: string) => q<{ ref: string; amount_kobo: string }>(`SELECT ref, amount_kobo FROM payment.wallet_txn WHERE ref >= $1 AND ref < $2 ORDER BY created_at`, [`${reference}:`, `${reference};`]);

const phoneNo = () => `23481${Math.floor(1e7 + Math.random() * 8e7)}`;
async function testUser(phone?: string): Promise<string> {
  const rows = await q<{ id: string }>(`INSERT INTO identity.users (email, phone) VALUES ($1,$2) RETURNING id`, [`qp-${randomUUID()}@kendibo.local`, phone ? `+${phone}` : null]);
  return String(rows[0].id);
}
async function newBooking(owner: string) {
  return bookingService.create(owner, {
    serviceId: 'svc_ac_general', addressId: '',
    scheduledAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(), idempotencyKey: `qp-${randomUUID()}`,
  });
}
/** Raw checkout call (any idempotency key). */
const checkout = (owner: string, bookingId: string, amountKobo: string, key = `idem-${randomUUID()}`) =>
  app.inject({ method: 'POST', url: `/v1/bookings/${bookingId}/payments`, headers: { ...auth(owner), 'idempotency-key': key }, payload: { amountKobo, email: 'buyer@kendibo.test' } });
async function startPayment(owner: string, bookingId: string, amountKobo: string, key?: string) {
  const res = await checkout(owner, bookingId, amountKobo, key);
  assert.equal(res.statusCode, 200, res.body);
  return String(res.json().data.reference);
}
function callback(reference: string, cumulativeKobo: number) {
  pagaSays.set(reference, { status: 'successful', code: '0' });
  return app.inject({
    method: 'POST', url: '/webhooks/payments/paga', headers: { 'content-type': 'application/json' },
    payload: {
      notificationId: randomUUID(), statusCode: '0', externalReferenceNumber: reference, state: 'CONSUMED',
      outstandingBalance: 0, paymentAmount: naira(cumulativeKobo), cumulativePaymentAmount: naira(cumulativeKobo), hash: 'fake',
    },
  });
}
const settledRow = (reference: string) => waitFor(async () => Boolean((await rowOf(reference))?.settled_at));
async function agree(bookingId: string, totalKobo: bigint) {
  const proposed = await quoteService.propose(bookingId, { amountKobo: totalKobo });
  return quoteService.accept(bookingId, proposed.version);
}

describe('the accepted quote is what is charged', () => {
  it('checkout charges the accepted quote total even when the client sends the old price', async () => {
    const owner = await testUser();
    const booking = await newBooking(owner);
    const old = Number(booking.priceKobo);
    const total = BigInt(old) + 250_000n;
    await agree(String(booking.id), total);
    assert.equal(await priceOfBooking(String(booking.id)), String(total), 'booking price follows the accepted quote');
    assert.equal(await expectedChargeKobo(String(booking.id), String(old)), total);
    const ref = await startPayment(owner, String(booking.id), String(old));
    assert.equal(String((await rowOf(ref)).amount_kobo), String(total));
    assert.equal(requested.get(ref), total, 'the Paga request is for the accepted total');
  });

  it('accept refuses a zero-total quote and leaves the booking price alone', async () => {
    const owner = await testUser();
    const booking = await newBooking(owner);
    const empty = await quoteService.propose(String(booking.id), {}); // a quote request with no amount yet
    await assert.rejects(() => quoteService.accept(String(booking.id), empty.version), /QUOTE_AMOUNT_INVALID/);
    assert.equal(await priceOfBooking(String(booking.id)), String(booking.priceKobo));
  });

  it('expectedChargeKobo throws instead of silently falling back when the booking cannot be read', async () => {
    await assert.rejects(() => expectedChargeKobo(randomUUID()), /BOOKING_NOT_FOUND/);
  });
});

describe('a re-quote supersedes the open request', () => {
  it('accepting a new price retires the pending request; money sent for the old amount goes to the wallet, never to the booking', async () => {
    const owner = await testUser();
    const booking = await newBooking(owner);
    const id = String(booking.id);
    const oldPrice = Number(booking.priceKobo);
    const stale = await startPayment(owner, id, String(oldPrice));
    assert.equal((await rowOf(stale)).status, 'pending');

    await agree(id, BigInt(oldPrice) + 100_000n);
    assert.equal((await rowOf(stale)).status, 'superseded');
    assert.equal((await rowOf(stale)).next_check_at, null);

    // The customer still pays the old request: Paga reports it paid in full.
    assert.equal((await callback(stale, oldPrice)).statusCode, 200);
    assert.ok(await settledRow(stale));
    assert.equal((await rowOf(stale)).status, 'superseded', 'a stale request never confirms');
    assert.equal((await rowOf(stale)).confirmed_at, null);
    assert.equal(await walletService.getBalance(owner), oldPrice, 'what was received is in the payer wallet');
    assert.equal((await credits(stale)).length, 1);
    assert.equal((await q(`SELECT 1 FROM payment.payment WHERE booking_id=$1 AND status='successful'`, [id])).length, 0);
    assert.equal((await q(`SELECT 1 FROM ledger.journal WHERE reference=$1`, [stale])).length, 0);
    assert.notEqual(await statusOfBooking(id), 'CONFIRMED');

    // A repeated callback and a reconciler pass change nothing.
    await callback(stale, oldPrice);
    await sleep(100);
    assert.equal(await walletService.getBalance(owner), oldPrice);
    assert.equal((await credits(stale)).length, 1);
  });

  it('checkout marks a pending request for a different amount superseded and mints a new reference', async () => {
    const owner = await testUser();
    const booking = await newBooking(owner);
    const id = String(booking.id);
    const oldPrice = Number(booking.priceKobo);
    const key = `idem-${randomUUID()}`;
    const first = await startPayment(owner, id, String(oldPrice), key);
    // The price changed behind the open request (not through quote accept).
    await q(`UPDATE booking.booking SET price_kobo=$2 WHERE id=$1`, [id, String(oldPrice + 70_000)]);
    const second = await startPayment(owner, id, String(oldPrice), key);
    assert.notEqual(second, first, 'same idempotency key, new amount: new reference');
    assert.equal((await rowOf(first)).status, 'superseded');
    assert.equal((await rowOf(first)).next_check_at, null);
    assert.equal((await rowOf(second)).status, 'pending');
    assert.equal(String((await rowOf(second)).amount_kobo), String(oldPrice + 70_000));

    // The current request settles and confirms; the stale one cannot.
    assert.equal((await callback(second, oldPrice + 70_000)).statusCode, 200);
    assert.ok(await settledRow(second));
    assert.equal((await rowOf(second)).status, 'successful');
    assert.equal((await rowOf(first)).status, 'superseded');
  });

  it('when the price goes back to the earlier amount the untouched earlier request is reopened', async () => {
    const owner = await testUser();
    const booking = await newBooking(owner);
    const id = String(booking.id);
    const price = Number(booking.priceKobo);
    const key = `idem-${randomUUID()}`;
    const first = await startPayment(owner, id, String(price), key);
    await q(`UPDATE booking.booking SET price_kobo=$2 WHERE id=$1`, [id, String(price + 10_000)]);
    await startPayment(owner, id, String(price), key);
    assert.equal((await rowOf(first)).status, 'superseded');
    await q(`UPDATE booking.booking SET price_kobo=$2 WHERE id=$1`, [id, String(price)]);
    assert.equal(await startPayment(owner, id, String(price), key), first);
    assert.equal((await rowOf(first)).status, 'pending');
  });

  it('a retry with the same key and the same amount reuses the open request', async () => {
    const owner = await testUser();
    const booking = await newBooking(owner);
    const key = `idem-${randomUUID()}`;
    const a = await startPayment(owner, String(booking.id), String(booking.priceKobo), key);
    const b = await startPayment(owner, String(booking.id), String(booking.priceKobo), key);
    assert.equal(a, b);
  });
});

describe('a paid booking cannot be charged again', () => {
  it('a second checkout after payment answers 409 ALREADY_PAID and creates nothing', async () => {
    const owner = await testUser();
    const booking = await newBooking(owner);
    const id = String(booking.id);
    const price = Number(booking.priceKobo);
    const ref = await startPayment(owner, id, String(price));
    assert.equal((await callback(ref, price)).statusCode, 200);
    assert.ok(await settledRow(ref));
    const before = (await q(`SELECT 1 FROM payment.payment WHERE booking_id=$1`, [id])).length;
    const again = await checkout(owner, id, String(price));
    assert.equal(again.statusCode, 409, again.body);
    assert.equal(again.json().error.code, 'ALREADY_PAID');
    assert.equal((await q(`SELECT 1 FROM payment.payment WHERE booking_id=$1`, [id])).length, before);
  });

  it('a paid booking cannot be re-quoted or have its price changed by an old proposal', async () => {
    const owner = await testUser();
    const booking = await newBooking(owner);
    const id = String(booking.id);
    const price = Number(booking.priceKobo);
    const pending = await quoteService.propose(id, { amountKobo: BigInt(price) + 5_000n }); // proposed before payment
    const ref = await startPayment(owner, id, String(price));
    assert.equal((await callback(ref, price)).statusCode, 200);
    assert.ok(await settledRow(ref));
    await assert.rejects(() => quoteService.propose(id, { amountKobo: 1_000n }), (e: any) => e.statusCode === 409 && /CONFLICT/.test(e.message));
    await assert.rejects(() => quoteService.accept(id, pending.version), (e: any) => e.statusCode === 409 && /CONFLICT/.test(e.message));
    assert.equal(await priceOfBooking(id), String(price));
  });
});

describe('WhatsApp pay link', () => {
  it('previews and charges the accepted quote, not a stale booking price', async () => {
    const wa = phoneNo();
    const owner = await testUser(wa);
    const booking = await newBooking(owner);
    const id = String(booking.id);
    const total = BigInt(booking.priceKobo) + 330_000n;
    await agree(id, total);
    // Even if the booking row were stale, the link follows the accepted quote.
    await q(`UPDATE booking.booking SET price_kobo=$2 WHERE id=$1`, [id, String(booking.priceKobo)]);

    const preview = await payLinkPreview(wa, id);
    assert.ok('preview' in preview, JSON.stringify(preview));
    assert.equal(preview.preview.amount, `₦${(Number(total) / 100).toLocaleString('en-NG', { maximumFractionDigits: 0 })}`);

    const target = await payLinkTarget(wa, id);
    assert.ok('url' in target, JSON.stringify(target));
    const ref = target.url.split('/').pop() as string;
    assert.equal(String((await rowOf(ref)).amount_kobo), String(total));
  });

  it('a link opened after a re-quote retires the old request and charges the new price', async () => {
    const wa = phoneNo();
    const owner = await testUser(wa);
    const booking = await newBooking(owner);
    const id = String(booking.id);
    const first = await payLinkTarget(wa, id);
    assert.ok('url' in first);
    const firstRef = first.url.split('/').pop() as string;
    await agree(id, BigInt(booking.priceKobo) + 120_000n);
    const second = await payLinkTarget(wa, id);
    assert.ok('url' in second);
    const secondRef = second.url.split('/').pop() as string;
    assert.notEqual(secondRef, firstRef);
    assert.equal((await rowOf(firstRef)).status, 'superseded');
    assert.equal(String((await rowOf(secondRef)).amount_kobo), String(BigInt(booking.priceKobo) + 120_000n));
  });
});

describe('settlement moves the booking forward', () => {
  it('a paid booking becomes CONFIRMED through the state machine (vendor sees it as paid)', async () => {
    const owner = await testUser();
    const booking = await newBooking(owner);
    const id = String(booking.id);
    const price = Number(booking.priceKobo);
    assert.equal(await statusOfBooking(id), 'REQUESTED');
    const ref = await startPayment(owner, id, String(price));
    assert.equal((await callback(ref, price)).statusCode, 200);
    assert.ok(await settledRow(ref));
    assert.ok(await waitFor(async () => (await statusOfBooking(id)) === 'CONFIRMED'));
    const trail = await q<{ from_status: string; to_status: string; actor: string }>(`SELECT from_status, to_status, actor FROM booking.job_event WHERE job_id=$1 ORDER BY created_at`, [id]);
    assert.deepEqual(trail.map((t) => `${t.from_status}>${t.to_status}`), ['REQUESTED>PAYMENT_PENDING', 'PAYMENT_PENDING>CONFIRMED']);
    assert.ok(trail.every((t) => t.actor === 'system'));
  });

  it('a booking already past payment states is left as it is', async () => {
    const owner = await testUser();
    const booking = await newBooking(owner);
    const id = String(booking.id);
    const price = Number(booking.priceKobo);
    const ref = await startPayment(owner, id, String(price));
    await bookingService.setStatus(id, 'MATCHING', 'system');
    assert.equal((await callback(ref, price)).statusCode, 200);
    assert.ok(await settledRow(ref));
    assert.equal((await rowOf(ref)).status, 'successful');
    assert.equal(await statusOfBooking(id), 'MATCHING');
  });

  it('a partial payment does not move the booking', async () => {
    const owner = await testUser();
    const booking = await newBooking(owner);
    const id = String(booking.id);
    const price = Number(booking.priceKobo);
    const ref = await startPayment(owner, id, String(price));
    pagaSays.set(ref, { status: 'partial', code: '2' });
    await app.inject({
      method: 'POST', url: '/webhooks/payments/paga', headers: { 'content-type': 'application/json' },
      payload: { notificationId: randomUUID(), statusCode: '2', externalReferenceNumber: ref, state: 'PARTIALLY_PAID', outstandingBalance: 10, paymentAmount: naira(price - 1000), cumulativePaymentAmount: naira(price - 1000), hash: 'fake' },
    });
    assert.ok(await waitFor(async () => (await rowOf(ref)).status === 'partial'));
    assert.equal(await statusOfBooking(id), 'REQUESTED');
  });
});

describe('change orders', () => {
  it('a change order must reference a quote of its own booking', async () => {
    const a = await newBooking(await testUser());
    const b = await newBooking(await testUser());
    const qa = await quoteService.propose(String(a.id), { amountKobo: 50_000n });
    const qb = await quoteService.propose(String(b.id), { amountKobo: 60_000n });
    await assert.rejects(() => quoteService.requestChange(String(a.id), qb.id, 'wrong quote', 5_000n), (e: any) => e.statusCode === 400 && /QUOTE_MISMATCH/.test(e.message));
    const ok = await quoteService.requestChange(String(a.id), qa.id, 'extra part', 5_000n);
    // A row pointing at another booking's quote (written outside the service) cannot be approved.
    const bad = await q<{ id: string }>(`INSERT INTO booking.change_order (job_id, quote_id, reason, amount_kobo) VALUES ($1,$2,'forged',9000) RETURNING id`, [String(a.id), qb.id]);
    await assert.rejects(() => quoteService.decideChange(String(bad[0].id), true, 'customer'), /QUOTE_MISMATCH/);
    assert.equal((await quoteService.decideChange(ok.id, true, 'customer')).status, 'approved');
  });
});
