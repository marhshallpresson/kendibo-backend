// Paga-only settlement: one rule for the webhook, the return/verify endpoints and the
// reconciler. Exact, underpaid, overpaid, top-up, duplicate callbacks, races, stuck
// payments, advisory lock, 48h expiry, legacy rows. Paga's HTTP is a fake adapter;
// callbacks are persisted and settled exactly like production (only the hash is faked).
import 'dotenv/config';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto, { randomUUID } from 'node:crypto';
import { walletService } from '../modules/wallet/wallet.service.js';
import { bookingService } from '../modules/bookings/booking.service.js';
import { q, withAdvisoryLock } from '../packages/database/db.js';
import { signAccess } from '../packages/auth/auth.js';
import { PaymentService, PspUnavailableError, mintReference } from '../modules/payments/payment.service.js';
import { PaymentSettlement, type SettlementHooks } from '../modules/payments/settlement.js';
import { PagaAdapter, statusFrom } from '../modules/payments/paga.adapter.js';
import { PagaClient, type PagaConfig } from '../modules/payments/paga/client.js';

type Verified = { psp: string; chargeId: string; reference: string; amountKobo: bigint; currency: string; status: string; code: string };
/** What Paga's /status says per reference (default: still in process). */
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
const naira = (kobo: number | bigint) => Number(kobo) / 100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check: () => Promise<boolean>, ms = 2000) {
  for (let t = 0; t < ms; t += 25) { if (await check()) return true; await sleep(25); }
  return false;
}
/** The settlement finished (status flipped, wallet credited, confirmed). */
const settled = (reference: string) => waitFor(async () => Boolean((await rowOf(reference))?.settled_at));
const statusOf = async (reference: string) => (await q<{ status: string }>(`SELECT status FROM payment.payment WHERE reference=$1`, [reference]))[0]?.status;
const rowOf = async (reference: string) => (await q<Record<string, any>>(`SELECT * FROM payment.payment WHERE reference=$1`, [reference]))[0];

async function testUser(): Promise<string> {
  const rows = await q<{ id: string }>(`INSERT INTO identity.users (email) VALUES ($1) RETURNING id`, [`ps-${randomUUID()}@kendibo.local`]);
  return String(rows[0].id);
}
async function newBooking(owner: string) {
  return bookingService.create(owner, {
    serviceId: 'svc_ac_general', addressId: '',
    scheduledAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(), idempotencyKey: `ps-${randomUUID()}`,
  });
}
async function startBookingPayment(owner: string, bookingId: string, amountKobo: string) {
  const res = await app.inject({ method: 'POST', url: `/v1/bookings/${bookingId}/payments`, headers: { ...auth(owner), ...idem() }, payload: { amountKobo, email: 'buyer@kendibo.test' } });
  assert.equal(res.statusCode, 200, res.body);
  return String(res.json().data.reference);
}
async function startTopup(owner: string, amountKobo: number) {
  const res = await app.inject({ method: 'POST', url: '/v1/wallet/topup', headers: { ...auth(owner), ...idem() }, payload: { amountKobo } });
  assert.equal(res.statusCode, 200, res.body);
  return String(res.json().data.reference);
}
/** Paga's /status says "paid" and its (hash-verified) callback reports the cumulative amount received. */
function callback(reference: string, cumulativeKobo: number, opts: { notificationId?: string; state?: string; status?: 'successful' | 'partial'; paymentKobo?: number } = {}) {
  pagaSays.set(reference, opts.status === 'partial' ? { status: 'partial', code: '2' } : { status: 'successful', code: '0' });
  return app.inject({
    method: 'POST', url: '/webhooks/payments/paga', headers: { 'content-type': 'application/json' },
    payload: {
      notificationId: opts.notificationId ?? randomUUID(), statusCode: '0', externalReferenceNumber: reference, state: opts.state ?? 'CONSUMED',
      outstandingBalance: 0, paymentAmount: naira(opts.paymentKobo ?? cumulativeKobo), cumulativePaymentAmount: naira(cumulativeKobo), hash: 'fake',
    },
  });
}
const journals = async (reference: string) => (await q(`SELECT 1 FROM ledger.journal WHERE reference=$1`, [reference])).length;
const credits = async (reference: string) => q<{ ref: string; amount_kobo: string }>(`SELECT ref, amount_kobo FROM payment.wallet_txn WHERE ref >= $1 AND ref < $2 ORDER BY created_at`, [`${reference}:`, `${reference};`]);

describe('references', () => {
  it('every minted Paga reference is deterministic and at most 50 characters (Paga limit)', () => {
    for (const purpose of ['booking', 'topup', 'tier', 'subscription'] as const) {
      const ref = mintReference(purpose, randomUUID(), randomUUID(), `${randomUUID()}${randomUUID()}`);
      assert.match(ref, /^kb_[bwts]_[0-9a-f]{24}$/);
      assert.ok(ref.length <= 50 && `rf_${ref}`.length <= 50, `${ref} / rf_${ref}`);
    }
    const u = randomUUID();
    assert.equal(mintReference('topup', u, '', 'k1'), mintReference('topup', u, '', 'k1'));
    assert.notEqual(mintReference('topup', u, '', 'k1'), mintReference('topup', u, '', 'k2'));
  });
  it('checkout stores the paying owner on our row and mints the reference server-side', async () => {
    const owner = await testUser();
    const booking = await newBooking(owner);
    const ref = await startBookingPayment(owner, String(booking.id), String(booking.priceKobo));
    const row = await rowOf(ref);
    assert.equal(row.user_id, owner);
    assert.equal(row.purpose, 'booking');
    assert.equal(String(row.booking_id), String(booking.id));
    assert.ok(ref.length <= 50);
    const top = await startTopup(owner, 5000);
    assert.equal((await rowOf(top)).user_id, owner);
    assert.equal((await rowOf(top)).purpose, 'topup');
  });
});

describe('Paga status mapping and callback hash', () => {
  it('only -2 and -3 fail a payment; unknown codes stay pending', () => {
    assert.equal(statusFrom('0'), 'successful');
    assert.equal(statusFrom('2'), 'partial');
    assert.equal(statusFrom('1'), 'pending');
    assert.equal(statusFrom('-2'), 'failed');
    assert.equal(statusFrom('-3'), 'failed');
    for (const unknown of ['99', '114', '-1', '', undefined, 'weird']) assert.equal(statusFrom(unknown as never), 'pending', String(unknown));
  });

  const CFG: PagaConfig = { env: 'sandbox', publicKey: 'pub', secretKey: 'sec', hashKey: 'hk', timeoutMs: 1000 };
  const adapter = () => new PagaAdapter(new PagaClient(CFG, (async () => new Response('{}')) as unknown as typeof fetch));
  const sha = (s: string) => crypto.createHash('sha512').update(s).digest('hex');
  const body = (over: Record<string, unknown> = {}) => ({ notificationId: 'n-1', statusCode: '0', externalReferenceNumber: 'kb_b_x', state: 'CONSUMED', outstandingBalance: 0, paymentAmount: 50, cumulativePaymentAmount: 50, ...over });

  it('accepts a correct hash (both outstandingBalance spellings, any case) and rejects a bad one', () => {
    const a = adapter();
    const two = { ...body(), hash: sha('n-10kb_b_xCONSUMED0.00hk') };
    const raw = { ...body(), hash: sha('n-10kb_b_xCONSUMED0hk') };
    const upper = { ...body(), hash: sha('n-10kb_b_xCONSUMED0.00hk').toUpperCase() };
    assert.equal(a.verifyWebhookSignature(JSON.stringify(two)), true);
    assert.equal(a.verifyWebhookSignature(JSON.stringify(raw)), true);
    assert.equal(a.verifyWebhookSignature(JSON.stringify(upper)), true);
    assert.equal(a.verifyWebhookSignature(JSON.stringify({ ...two, hash: sha('forged') })), false);
    assert.equal(a.verifyWebhookSignature(JSON.stringify({ ...two, externalReferenceNumber: 'kb_b_other' })), false, 'tampered body');
    assert.equal(a.verifyWebhookSignature(JSON.stringify({ ...body(), hash: undefined })), false);
    const nullBalance = { ...body({ outstandingBalance: null }), hash: sha('n-10kb_b_xCONSUMEDhk') };
    assert.equal(a.verifyWebhookSignature(JSON.stringify(nullBalance)), true, 'null balance is left out of the hash');
  });

  it('a callback with a bad hash is refused (401) and changes nothing', async () => {
    const real = new PagaAdapter(new PagaClient(CFG, (async () => new Response('{}')) as unknown as typeof fetch));
    const svc = new PaymentService({ paga: real as never });
    const bad = svc.parseWebhook(Buffer.from(JSON.stringify({ ...body(), hash: sha('forged') })), {});
    assert.equal(bad.ok, false);
    const good = svc.parseWebhook(Buffer.from(JSON.stringify({ ...body(), hash: sha('n-10kb_b_xCONSUMED0.00hk') })), {});
    assert.equal(good.ok, true);
    if (good.ok) {
      assert.equal(good.callback.cumulativeKobo, 5000n);
      assert.equal(good.callback.state, 'CONSUMED');
      assert.equal(good.eventId, 'paga:n-1');
    }
  });

  it('PAGA_CALLBACK_IPS, when set, blocks other sources; unset means not enforced', async () => {
    const before0 = process.env.PAGA_CALLBACK_IPS;
    try {
      process.env.PAGA_CALLBACK_IPS = '51.124.69.198,51.136.123.148';
      const blocked = await app.inject({ method: 'POST', url: '/webhooks/payments/paga', headers: { 'content-type': 'application/json' }, payload: body() });
      assert.equal(blocked.statusCode, 403);
      delete process.env.PAGA_CALLBACK_IPS;
      const open = await app.inject({ method: 'POST', url: '/webhooks/payments/paga', headers: { 'content-type': 'application/json' }, payload: body({ externalReferenceNumber: 'kb_b_nobody' }) });
      assert.equal(open.statusCode, 200);
    } finally { if (before0 === undefined) delete process.env.PAGA_CALLBACK_IPS; else process.env.PAGA_CALLBACK_IPS = before0; }
  });
});

describe('Paga not configured', () => {
  it('checkout fails with PSP_UNAVAILABLE and never falls back to another PSP', async () => {
    const keys = ['PAGA_PUBLIC_KEY', 'PAGA_SECRET_KEY', 'PAGA_HASH_KEY'];
    const saved = keys.map((k) => process.env[k]);
    keys.forEach((k) => { process.env[k] = ''; });
    try {
      const svc = new PaymentService();
      await assert.rejects(() => svc.createCheckout({ bookingId: 'wallet_topup', purpose: 'topup', amountKobo: 5000n, idempotencyKey: 'k', userId: randomUUID() }), (e: unknown) => e instanceof PspUnavailableError && (e as PspUnavailableError).code === 'PSP_UNAVAILABLE');
    } finally { keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; }); }
  });
});

describe('booking settlement rules', () => {
  it('exact amount: booking is paid once, nothing goes to the wallet', async () => {
    const owner = await testUser();
    const booking = await newBooking(owner);
    const price = Number(booking.priceKobo);
    const ref = await startBookingPayment(owner, String(booking.id), String(price));
    assert.equal((await callback(ref, price)).statusCode, 200);
    assert.ok(await settled(ref));
    assert.equal((await rowOf(ref)).received_kobo, String(price));
    assert.ok(await waitFor(async () => (await rowOf(ref)).settled_at !== null));
    assert.equal(await journals(ref), 1);
    assert.equal(await walletService.getBalance(owner), 0);
  });

  it('underpaid: not confirmed, the received amount lands in the payer wallet, then the wallet finishes it', async () => {
    const owner = await testUser();
    const booking = await newBooking(owner);
    const price = Number(booking.priceKobo);
    const paid = price - 40_000;
    const ref = await startBookingPayment(owner, String(booking.id), String(price));
    await callback(ref, paid, { status: 'partial', state: 'PENDING' });
    assert.ok(await waitFor(async () => (await statusOf(ref)) === 'partial'));
    assert.ok(await waitFor(async () => (await credits(ref)).length === 1));
    assert.equal(await journals(ref), 0, 'booking is NOT confirmed');
    assert.equal(await walletService.getBalance(owner), paid);
    assert.deepEqual((await credits(ref)).map((c) => [c.ref, Number(c.amount_kobo)]), [[`${ref}:partial`, paid]]);

    // The payer tops up the rest (also through Paga), then pays from the wallet.
    const top = await startTopup(owner, 40_000);
    await callback(top, 40_000);
    assert.ok(await settled(top));
    assert.equal(await walletService.getBalance(owner), price);
    const wp = await app.inject({ method: 'POST', url: `/v1/bookings/${booking.id}/pay-with-wallet`, headers: { ...auth(owner), ...idem() }, payload: {} });
    assert.equal(wp.statusCode, 200, wp.body);
    assert.equal(wp.json().data.status, 'successful');
    assert.equal(await walletService.getBalance(owner), 0);
  });

  it('overpaid: booking confirmed and the excess is credited to the wallet', async () => {
    const owner = await testUser();
    const booking = await newBooking(owner);
    const price = Number(booking.priceKobo);
    const ref = await startBookingPayment(owner, String(booking.id), String(price));
    await callback(ref, price + 30_000);
    assert.ok(await waitFor(async () => (await rowOf(ref)).settled_at !== null));
    assert.equal(await statusOf(ref), 'successful');
    assert.equal(await journals(ref), 1);
    assert.equal(await walletService.getBalance(owner), 30_000);
    assert.deepEqual((await credits(ref)).map((c) => [c.ref, Number(c.amount_kobo)]), [[`${ref}:excess`, 30_000]]);
  });

  it('the payer notice says what was paid, what is in the wallet and what to do', async () => {
    const owner = await testUser();
    const booking = await newBooking(owner);
    const price = Number(booking.priceKobo);
    const ref = await startBookingPayment(owner, String(booking.id), String(price));
    const notes: string[] = [];
    const settlement = new PaymentSettlement(new PaymentService({ paga: fakePsp as never }), { confirm: async () => {}, notify: async (_u, _t, body) => { notes.push(body); }, track: () => {} });
    pagaSays.set(ref, { status: 'partial', code: '2' });
    await settlement.recordCallback(ref, { notificationId: randomUUID(), state: 'PENDING', statusCode: '2', paymentKobo: 10_000n, cumulativeKobo: 10_000n, outstandingKobo: null });
    assert.equal((await settlement.settle(ref)).status, 'partial');
    assert.equal(notes.length, 1);
    assert.match(notes[0], /You paid ₦100\.00 of ₦/);
    assert.match(notes[0], /in your wallet\. Pay the rest from your wallet to confirm\./);
  });

  it('a further transfer to a partially paid request is credited as well, once', async () => {
    const owner = await testUser();
    const booking = await newBooking(owner);
    const price = Number(booking.priceKobo);
    const ref = await startBookingPayment(owner, String(booking.id), String(price));
    await callback(ref, 20_000, { status: 'partial', state: 'PENDING' });
    assert.ok(await waitFor(async () => (await walletService.getBalance(owner)) === 20_000));
    await callback(ref, 50_000, { status: 'partial', state: 'PENDING' });
    assert.ok(await waitFor(async () => (await walletService.getBalance(owner)) === 50_000));
    await callback(ref, 50_000, { status: 'partial', state: 'PENDING' }); // replay with a new id
    await sleep(100);
    assert.equal(await walletService.getBalance(owner), 50_000);
    assert.equal(await journals(ref), 0);
  });
});

describe('wallet top-up settlement', () => {
  it('credits exactly the Paga-confirmed received amount', async () => {
    const owner = await testUser();
    const exact = await startTopup(owner, 12_000);
    await callback(exact, 12_000);
    assert.ok(await settled(exact));
    assert.equal(await walletService.getBalance(owner), 12_000);
    assert.deepEqual((await credits(exact)).map((c) => c.ref), [`${exact}:topup`]);

    const less = await startTopup(owner, 10_000);
    await callback(less, 7_000, { status: 'partial', state: 'PENDING' });
    assert.ok(await waitFor(async () => (await walletService.getBalance(owner)) === 19_000));
    assert.equal(await statusOf(less), 'partial');

    const more = await startTopup(owner, 5_000);
    await callback(more, 6_500);
    assert.ok(await waitFor(async () => (await walletService.getBalance(owner)) === 25_500));
    assert.equal(await statusOf(more), 'successful');
  });

  it('the owner is the stored payer: a callback never credits anyone else', async () => {
    const owner = await testUser();
    const other = await testUser();
    const ref = await startTopup(owner, 3_000);
    await callback(ref, 3_000);
    assert.ok(await settled(ref));
    assert.equal(await walletService.getBalance(owner), 3_000);
    assert.equal(await walletService.getBalance(other), 0);
  });

  it('a payment with no stored owner is flagged, not credited', async () => {
    const owner = await testUser();
    const ref = await startTopup(owner, 2_000);
    await q(`UPDATE payment.payment SET user_id=NULL WHERE reference=$1`, [ref]);
    const events: string[] = [];
    const settlement = new PaymentSettlement(new PaymentService({ paga: fakePsp as never }), { confirm: async () => {}, notify: async () => {}, track: (e) => { events.push(e); } });
    pagaSays.set(ref, { status: 'successful', code: '0' });
    await settlement.recordCallback(ref, { notificationId: randomUUID(), state: 'CONSUMED', statusCode: '0', paymentKobo: 2_000n, cumulativeKobo: 2_000n, outstandingKobo: 0n });
    await settlement.settle(ref);
    assert.equal(await walletService.getBalance(owner), 0);
    assert.ok(events.includes('payment.no_owner'));
  });
});

describe('callbacks, races and idempotency', () => {
  it('a duplicate notificationId is processed once; a retry with a new id adds nothing', async () => {
    const owner = await testUser();
    const ref = await startTopup(owner, 9_000);
    const id = randomUUID();
    assert.equal((await callback(ref, 9_000, { notificationId: id })).statusCode, 200);
    assert.ok(await settled(ref));
    const again = await callback(ref, 9_000, { notificationId: id });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().status, 'SUCCESS');
    await callback(ref, 9_000, { notificationId: randomUUID() });
    await sleep(100);
    assert.equal(await walletService.getBalance(owner), 9_000);
    assert.equal((await q(`SELECT 1 FROM payment.webhook_event WHERE event_id=$1`, [`paga:${id}`])).length, 1);
    assert.equal((await credits(ref)).length, 1);
  });

  it('the event is recorded only after the callback is persisted, so a retry after a crash is processed', async () => {
    const owner = await testUser();
    const ref = await startTopup(owner, 4_000);
    const id = randomUUID();
    // Simulate a crash before anything was stored: no event row, no callback fields.
    assert.equal((await q(`SELECT 1 FROM payment.webhook_event WHERE event_id=$1`, [`paga:${id}`])).length, 0);
    await callback(ref, 4_000, { notificationId: id });
    assert.ok(await settled(ref));
    assert.equal((await rowOf(ref)).last_notification_id, id);
  });

  it('webhook and reconciler racing on one payment settle it exactly once', async () => {
    const owner = await testUser();
    const booking = await newBooking(owner);
    const price = Number(booking.priceKobo);
    const ref = await startBookingPayment(owner, String(booking.id), String(price));
    await q(`UPDATE payment.payment SET created_at = $2 WHERE reference=$1`, [ref, new Date(Date.now() - 10 * 60_000).toISOString()]);
    let confirms = 0;
    const hooks: SettlementHooks = { confirm: async () => { confirms++; await sleep(20); }, notify: async () => {}, track: () => {} };
    const settlement = new PaymentSettlement(new PaymentService({ paga: fakePsp as never }), hooks);
    pagaSays.set(ref, { status: 'successful', code: '0' });
    await settlement.recordCallback(ref, { notificationId: randomUUID(), state: 'CONSUMED', statusCode: '0', paymentKobo: BigInt(price), cumulativeKobo: BigInt(price + 5_000), outstandingKobo: 0n });
    const results = await Promise.all([settlement.settle(ref), settlement.settle(ref), settlement.reconcileTick(), settlement.settle(ref)]);
    assert.ok(results.length === 4);
    await settlement.settle(ref); // anything left over is completed idempotently
    assert.equal(await statusOf(ref), 'successful');
    assert.equal(confirms, 1, 'confirmed once');
    assert.equal(await walletService.getBalance(owner), 5_000, 'excess credited once');
    assert.equal((await credits(ref)).length, 1);
  });

  it('the status flip is guarded: a second flip of the same pending row changes nothing', async () => {
    const owner = await testUser();
    const ref = await startTopup(owner, 1_500);
    const first = await q(`UPDATE payment.payment SET status='successful' WHERE reference=$1 AND status='pending' RETURNING reference`, [ref]);
    const second = await q(`UPDATE payment.payment SET status='successful' WHERE reference=$1 AND status='pending' RETURNING reference`, [ref]);
    assert.equal(first.length, 1);
    assert.equal(second.length, 0);
  });
});

describe('reconciler', () => {
  const settlementFor = (hooks: Partial<SettlementHooks> = {}) =>
    new PaymentSettlement(new PaymentService({ paga: fakePsp as never }), { confirm: async () => {}, notify: async () => {}, track: () => {}, ...hooks });

  it('settles a stuck pending payment without the customer returning, once the callback amount is known', async () => {
    const owner = await testUser();
    const ref = await startTopup(owner, 8_000);
    await q(`UPDATE payment.payment SET created_at=$2, next_check_at=$2 WHERE reference=$1`, [ref, new Date(Date.now() - 5 * 60_000).toISOString()]);
    const settlement = settlementFor();
    // The callback was stored but the in-process settle was lost (crash): the reconciler finishes it.
    pagaSays.set(ref, { status: 'successful', code: '0' });
    await settlement.recordCallback(ref, { notificationId: randomUUID(), state: 'CONSUMED', statusCode: '0', paymentKobo: 8_000n, cumulativeKobo: 8_000n, outstandingKobo: 0n });
    const stats = await settlement.reconcileTick();
    assert.ok(stats && stats.checked >= 1 && stats.settled >= 1);
    assert.equal(await statusOf(ref), 'successful');
    assert.equal(await walletService.getBalance(owner), 8_000);
  });

  it('does not touch payments younger than a minute, and backs a still-pending payment off', async () => {
    const owner = await testUser();
    const fresh = await startTopup(owner, 2_000);
    await q(`UPDATE payment.payment SET next_check_at=$2 WHERE reference=$1`, [fresh, new Date(Date.now() - 1000).toISOString()]);
    const old = await startTopup(owner, 2_100);
    await q(`UPDATE payment.payment SET created_at=$2, next_check_at=$2 WHERE reference=$1`, [old, new Date(Date.now() - 5 * 60_000).toISOString()]);
    await settlementFor().reconcileTick();
    assert.equal((await rowOf(fresh)).check_attempts, 0, 'too young: skipped');
    const o = await rowOf(old);
    assert.equal(Number(o.check_attempts), 1);
    assert.ok(new Date(o.next_check_at).getTime() > Date.now() + 30_000, 'next check is pushed out (exponential backoff)');
    await q(`UPDATE payment.payment SET status='failed' WHERE reference=$1`, [fresh]); // keep later ticks quiet
  });

  it('Paga says paid but no verified amount is known: stays pending, flagged for review, never expired', async () => {
    const owner = await testUser();
    const ref = await startTopup(owner, 6_000);
    await q(`UPDATE payment.payment SET created_at=$2, next_check_at=$2 WHERE reference=$1`, [ref, new Date(Date.now() - 60 * 3600_000).toISOString()]);
    const events: string[] = [];
    pagaSays.set(ref, { status: 'successful', code: '0' });
    const settlement = settlementFor({ track: (e) => { events.push(e); } });
    await settlement.settle(ref);
    assert.equal(await statusOf(ref), 'pending');
    assert.equal((await rowOf(ref)).review_flag, 'paid_amount_unknown');
    assert.ok(events.includes('payment.review_needed'));
    await settlement.reconcileTick();
    assert.equal(await statusOf(ref), 'pending', 'money may have arrived: never auto-expired');
    assert.equal(await walletService.getBalance(owner), 0, 'and nothing is credited on a guess');
  });

  it('expires payments still pending after 48h, but a late payment still settles first', async () => {
    const owner = await testUser();
    const stale = await startTopup(owner, 3_100);
    const late = await startTopup(owner, 3_200);
    const old = new Date(Date.now() - 49 * 3600_000).toISOString();
    for (const r of [stale, late]) await q(`UPDATE payment.payment SET created_at=$2, next_check_at=$2 WHERE reference=$1`, [r, old]);
    const settlement = settlementFor();
    pagaSays.set(late, { status: 'successful', code: '0' });
    await settlement.recordCallback(late, { notificationId: randomUUID(), state: 'CONSUMED', statusCode: '0', paymentKobo: 3_200n, cumulativeKobo: 3_200n, outstandingKobo: 0n });
    const stats = await settlement.reconcileTick();
    assert.ok(stats && stats.expired >= 1);
    assert.equal(await statusOf(stale), 'expired');
    assert.equal(await statusOf(late), 'successful');
    assert.equal(await walletService.getBalance(owner), 3_200);
  });

  it('a Postgres advisory lock lets only one reconciler run at a time', async () => {
    const settlement = settlementFor();
    const outer = await withAdvisoryLock('payments:reconcile', async () => settlement.reconcileTick());
    assert.equal(outer.acquired, true);
    assert.equal(outer.value, null, 'a second process finds the lock taken and does nothing');
    const free = await settlement.reconcileTick();
    assert.notEqual(free, null, 'lock is released afterwards');
  });
});

describe('historical rows from the retired card PSP', () => {
  it('still list and read correctly, are never reconciled and cannot be refunded through Paga', async () => {
    const owner = await testUser();
    const booking = await newBooking(owner);
    const ref = `old_${randomUUID()}`;
    await q(`INSERT INTO payment.payment (booking_id, psp, reference, charge_id, amount_kobo, status, user_id, purpose) VALUES ($1,'legacy_card',$2,$2,$3,'successful',$4,'booking')`, [booking.id, ref, Number(booking.priceKobo), owner]);
    const res = await app.inject({ method: 'GET', url: `/v1/payments/${ref}`, headers: auth(owner) });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.psp, 'legacy_card');
    assert.equal(res.json().data.status, 'successful');
    const settlement = new PaymentSettlement(new PaymentService({ paga: fakePsp as never }), { confirm: async () => { throw new Error('must not run'); }, notify: async () => {}, track: () => {} });
    assert.deepEqual(await settlement.settle(ref), { status: 'successful', transitioned: false });
    await q(`INSERT INTO payment.payment (booking_id, psp, reference, charge_id, amount_kobo, status, user_id, purpose, next_check_at) VALUES ($1,'legacy_card',$2,$2,5000,'pending',$3,'booking',$4)`, [booking.id, `${ref}_p`, owner, new Date(Date.now() - 1000).toISOString()]);
    await settlement.reconcileTick();
    assert.equal(await statusOf(`${ref}_p`), 'pending', 'retired PSP rows are left alone');
    await assert.rejects(() => new PaymentService({ paga: fakePsp as never }).refund(ref), /REFUND_RETIRED_PSP/);
  });

  it('the migration only allows the neutral legacy value', async () => {
    await assert.rejects(() => q(`INSERT INTO payment.payment (booking_id, psp, reference, amount_kobo) VALUES (gen_random_uuid(), $1, $2, 100)`, ['b' + 'achs', `x_${randomUUID()}`]));
  });
});
