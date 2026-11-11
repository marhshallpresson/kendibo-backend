// The whole WhatsApp journey with stubs (no real messages, emails or PSP calls):
// first message -> consent -> name -> email (+ confirm link) -> request ->
// location -> day/time -> vendor accepts -> pay (signed Bachs webhook) ->
// receipt -> 24h reminder -> on the way + start code -> check-in -> completed ->
// customer DONE -> settlement -> final invoice -> review.
// Plus: invoice numbering and idempotency, the hosted invoice page, and the
// schedule updates (reschedule, pro-proposed time, provider evening reminder).
import 'dotenv/config';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto, { randomUUID } from 'node:crypto';
import { q } from '../packages/database/db.js';
import { signAccess } from '../packages/auth/auth.js';
import { providerService } from '../modules/providers/provider.service.js';

// ── Stubs ──────────────────────────────────────────────────────────────────
// Bachs: webhooks are HMAC-signed with a test secret; the "PSP" answers verify
// calls from the payment rows we recorded (so the amount check passes).
const WEBHOOK_SECRET = 'test-bachs-webhook-secret';
const fakePsp = {
  name: 'bachs',
  createCheckout: async (input: { reference: string }) => ({ psp: 'bachs', checkoutId: `chk_${input.reference}`, checkoutUrl: `https://pay.test/c/${input.reference}`, reference: input.reference, status: 'open' }),
  getCheckout: async (checkoutId: string, reference: string) => ({ psp: 'bachs', checkoutId, checkoutUrl: `https://pay.test/c/${reference}`, reference, status: 'open' }),
  verifyByReference: async (reference: string) => verified(reference),
  verifyByChargeId: async (chargeId: string) => verified(chargeId.replace(/^ch_/, '')),
  refund: async () => ({ refundId: 'rf_test', status: 'processing' }),
  createPayout: async () => ({ payoutId: 'pay_test', status: 'pending' }),
  verifyWebhookSignature: (raw: Buffer, headers: Record<string, string | undefined>) => {
    const ts = String(headers['x-bachs-timestamp'] ?? '');
    const want = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${raw.toString('utf8')}`).digest('hex');
    const got = String(headers['x-bachs-signature'] ?? '');
    return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
  },
};
async function verified(reference: string) {
  const r = await q<{ amount_kobo: string }>(`SELECT amount_kobo FROM payment.payment WHERE reference=$1`, [reference]);
  return { psp: 'bachs', chargeId: `ch_${reference}`, reference, amountKobo: BigInt(String(r[0]?.amount_kobo ?? '0')), currency: 'NGN', status: r[0] ? 'successful' : 'failed' };
}
(globalThis as Record<string, unknown>).__PSP__ = { bachs: fakePsp };

process.env.NODE_ENV = 'test';
type Res = { statusCode: number; json: () => any; body: string; headers: Record<string, string | string[] | number | undefined> };
let app: { inject: (opts: unknown) => Promise<Res>; close?: () => Promise<void> };

// Email stub: capture instead of logging.
const mails: { to: string; subject: string; html: string }[] = [];
// WhatsApp link buttons: capture the URL (the turn log keeps only the label).
const ctas: { to: string; body: string; url: string }[] = [];

before(async () => {
  process.env.DATABASE_URL = '';
  process.env.REDIS_URL = '';
  ({ app } = await import('../apps/api/src/main.js'));
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
  process.env.WHATSAPP_CONSENT_GATE = 'on';
  const { email } = await import('../modules/notifications/channels.js');
  (email as { send: unknown }).send = async (to: string, subject: string, html: string) => { mails.push({ to, subject, html }); return { id: `stub_${mails.length}` }; };
  const { wa } = await import('../modules/whatsapp/whatsapp.client.js');
  const real = wa.ctaUrl;
  (wa as { ctaUrl: unknown }).ctaUrl = async (to: string, body: string, label: string, url: string) => { ctas.push({ to, body, url }); return real(to, body, label, url); };
});
after(async () => {
  process.env.WHATSAPP_CONSENT_GATE = 'off';
  await app?.close?.().catch(() => {});
});

const UYO = { lat: 5.0377, lng: 7.9128 };
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const newNumber = () => `23480${Math.floor(1e7 + Math.random() * 8e7)}`;
const bot = () => import('../modules/whatsapp/whatsapp.bot.js');
const say = async (w: string, body: string) => (await bot()).handleInbound({ id: `wamid.${randomUUID()}`, from: w, type: 'text', text: { body } }, 'Ada Obi');
const tap = async (w: string, id: string, title = '') => (await bot()).handleInbound({ id: `wamid.${randomUUID()}`, from: w, type: 'interactive', interactive: { button_reply: { id, title } } }, 'Ada Obi');

/** Everything sent to this number while `act` ran (the bot records every outbound message). */
async function sent(w: string, act: () => Promise<unknown>): Promise<string> {
  const seen = new Set((await q<{ id: string }>(`SELECT id FROM messaging.whatsapp_turn WHERE wa_id=$1 AND role='assistant'`, [w])).map((r) => String(r.id)));
  await act();
  const rows = await q<{ id: string; content: string }>(`SELECT id, content FROM messaging.whatsapp_turn WHERE wa_id=$1 AND role='assistant' ORDER BY created_at`, [w]);
  return rows.filter((r) => !seen.has(String(r.id))).map((r) => String(r.content)).join('\n---\n');
}
/** Like `sent`, for notices the API sends after it has answered (waits up to 5s for `want`). */
async function sentSoon(w: string, act: () => Promise<unknown>, want: RegExp): Promise<string> {
  const seen = new Set((await q<{ id: string }>(`SELECT id FROM messaging.whatsapp_turn WHERE wa_id=$1 AND role='assistant'`, [w])).map((r) => String(r.id)));
  await act();
  let out = '';
  for (let i = 0; i < 50; i++) {
    const rows = await q<{ id: string; content: string }>(`SELECT id, content FROM messaging.whatsapp_turn WHERE wa_id=$1 AND role='assistant' ORDER BY created_at`, [w]);
    out = rows.filter((r) => !seen.has(String(r.id))).map((r) => String(r.content)).join('\n---\n');
    if (want.test(out)) break;
    await new Promise((res) => setTimeout(res, 100));
  }
  return out;
}
const move = (token: string, jobId: string, to: string, code?: string) =>
  app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/transition`, headers: bearer(token), payload: { to, ...(code ? { code } : {}) } });

async function onlinePro(phone?: string) {
  await q(`UPDATE provider.provider SET online=false`);
  const rows = await q<{ id: string }>(`INSERT INTO identity.users (email, name, phone) VALUES ($1,'Ewet Cool Air',$2) RETURNING id`, [`pro-${randomUUID()}@kendibo.local`, phone ?? null]);
  const uid = String(rows[0].id);
  const p = await providerService.onboard(uid);
  await q(`UPDATE provider.provider SET business_name='Ewet Cool Air' WHERE id=$1`, [p.id]);
  await providerService.addSkill(p.id, 'hvac');
  await providerService.verifyKyc(p.id);
  await providerService.setOnline(p.id, true, UYO.lat, UYO.lng);
  return { providerId: p.id, userId: uid, token: signAccess(uid, []), phone };
}

async function signedWebhook(reference: string): Promise<Res> {
  const body = JSON.stringify({ id: `evt_${randomUUID()}`, type: 'payment.succeeded', data: { reference, payment_id: `ch_${reference}` } });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${body}`).digest('hex');
  return app.inject({ method: 'POST', url: '/webhooks/payments/bachs', headers: { 'content-type': 'application/json', 'x-bachs-timestamp': ts, 'x-bachs-signature': sig }, payload: body });
}

describe('WhatsApp journey, first message to final invoice', () => {
  it('runs end to end and tells the customer each step', async () => {
    const w = newNumber();
    const proPhone = newNumber();
    const pro = await onlinePro(`+${proPhone}`);

    // 1. First message -> consent notice.
    let r = await sent(w, () => say(w, 'my AC dey leak water, budget 15k, tomorrow morning'));
    assert.match(r, /Welcome to Kendibo, Ada/);
    assert.match(r, /Terms and privacy/);

    // 2. Consent -> name -> email.
    r = await sent(w, () => tap(w, 'consent:agree', 'Agree & continue'));
    assert.match(r, /Shall I call you Ada/);
    r = await sent(w, () => tap(w, 'onb:name:yes', "Yes, that's me"));
    assert.match(r, /What's your email/);
    const address = `ada-${randomUUID().slice(0, 8)}@example.com`;
    r = await sent(w, () => say(w, address));
    assert.match(r, /sent a link to/);
    const confirmMail = mails.find((m) => m.to === address);
    assert.ok(confirmMail, 'confirmation email sent to the stub');
    const link = /\/w\/confirm-email\?t=([^"&<\s]+)/.exec(confirmMail!.html);
    assert.ok(link, 'the email carries the confirm link');
    const confirm = await app.inject({ method: 'GET', url: `/w/confirm-email?t=${link![1]}` });
    assert.equal(confirm.statusCode, 200);
    assert.match(confirm.body, /Email confirmed/);
    const user = (await q<{ id: string; email: string; verified: string | null }>(`SELECT id, email, email_verified_at AS verified FROM identity.users WHERE phone=$1`, [`+${w}`]))[0];
    assert.equal(user.email, address);
    assert.ok(user.verified);

    // 3. The request: photo (skip) -> location -> confirm (day and time came with the first message).
    const transcript: string[] = [];
    for (let i = 0; i < 8; i++) {
      const last = (await q<{ content: string }>(`SELECT content FROM messaging.whatsapp_turn WHERE wa_id=$1 AND role='assistant' ORDER BY created_at DESC LIMIT 1`, [w]))[0]?.content ?? '';
      transcript.push(last);
      if ((await q(`SELECT 1 FROM messaging.whatsapp_job_draft WHERE wa_id=$1 AND status='submitted'`, [w])).length) break;
      if (/Here's your request|Find vendors/.test(last)) await tap(w, 'flow:confirm', 'Find vendors');
      else if (/picture|photo/i.test(last)) await tap(w, 'flow:skip_photo', 'Skip photo');
      else if (/Set location|location/i.test(last) && !/Location saved/.test(last)) await (await bot()).handleInbound({ id: `wamid.${randomUUID()}`, from: w, type: 'location', location: { latitude: UYO.lat, longitude: UYO.lng, address: '12 Ewet Housing, Uyo' } });
      else if (/budget/i.test(last)) await say(w, '15k');
      else if (/morning|afternoon|evening|which day|when/i.test(last)) await say(w, 'tomorrow morning');
      else await say(w, 'my AC dey leak water, tomorrow morning');
    }
    const draft = (await q<{ request_id: string; status: string }>(`SELECT request_id, status FROM messaging.whatsapp_job_draft WHERE wa_id=$1 AND status='submitted'`, [w]))[0];
    assert.match(transcript.join('\n'), /Here's your request:[\s\S]*When: \w{3}, \d{1,2} \w{3}, morning 8–12/, 'day and time window confirmed');
    assert.equal(draft?.status, 'submitted', transcript.join('\n=====\n'));
    const requestId = String(draft.request_id);

    // 4. Vendor accepts -> pro assigned (name + rating) + pay link.
    const offer = (await q<{ id: string; request_id: string; provider_id: string }>(`SELECT id, request_id, provider_id FROM booking.request_offer`))
      .find((o) => String(o.request_id) === requestId && String(o.provider_id) === pro.providerId);
    assert.ok(offer, 'the online pro got the offer');
    let bookingId = '';
    r = await sent(w, async () => {
      const acc = await app.inject({ method: 'POST', url: `/v1/provider/requests/${offer!.id}/respond`, headers: bearer(pro.token), payload: { accept: true } });
      assert.equal(acc.statusCode, 200, acc.body);
      bookingId = String(acc.json().data.bookingId);
      // The customer notice runs after the response; wait for the pay button.
      for (let i = 0; i < 50 && !ctas.some((c) => c.to === w && /pay\.test/.test(c.url)); i++) await new Promise((res) => setTimeout(res, 100));
    });
    assert.match(r, /Your pro is Ewet Cool Air \(new on Kendibo, ID-checked\)/);
    assert.match(r, /Booked for \w{3} \d{1,2} \w{3}, 8am–12pm/, 'the date and the morning window');
    assert.match(r, /accepted your job\. Pay ₦[\d,.]+ to confirm/);
    assert.ok(ctas.some((c) => c.to === w && /pay\.test/.test(c.url)), 'pay button sent');

    // 5. Pay: the signed Bachs webhook -> receipt on WhatsApp (link) and by email.
    const reference = `bk_${bookingId}_wa`;
    const unsigned = await app.inject({ method: 'POST', url: '/webhooks/payments/bachs', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ id: 'x', data: { reference } }) });
    assert.equal(unsigned.statusCode, 401, 'an unsigned webhook is refused');
    r = await sent(w, async () => assert.equal((await signedWebhook(reference)).statusCode, 200));
    assert.match(r, /Payment received: ₦[\d,.]+\. Kendibo holds it safely until you confirm the job is done\. Your receipt is KND-\d{4}-\d{6}/);
    assert.match(r, /View receipt/);
    const receiptCta = ctas.filter((c) => c.to === w && /\/w\/invoice\//.test(c.url));
    assert.equal(receiptCta.length, 1, 'receipt link sent once on WhatsApp');
    const receiptMail = mails.filter((m) => m.to === address && /receipt/.test(m.subject));
    assert.equal(receiptMail.length, 1, 'receipt emailed to the verified address');
    assert.ok(receiptMail[0].html.includes(receiptCta[0].url.replace(/&/g, '&amp;')), 'email has the same signed link');
    const receiptPage = await app.inject({ method: 'GET', url: receiptCta[0].url.replace(/^https?:\/\/[^/]+/, '') });
    assert.equal(receiptPage.statusCode, 200);
    assert.match(receiptPage.body, /Payment receipt/);
    assert.match(receiptPage.body, /holds this payment until you confirm/);
    // A webhook replay sends nothing new.
    assert.equal(await sent(w, () => signedWebhook(reference)), '');

    // 6. 24h reminder (the sweeper with an advanced clock): date, window, address, prep, start code.
    const { reminderSweep } = await import('../modules/job-engine/journey.js');
    const at = Date.parse(String((await q<{ s: string }>(`SELECT scheduled_at AS s FROM booking.booking WHERE id=$1`, [bookingId]))[0].s));
    r = await sent(w, () => reminderSweep(at - 20 * 3600_000));
    assert.match(r, /Reminder: your Kendibo .+ is booked for \w{3} \d{1,2} \w{3}, 8am–12pm/);
    assert.match(r, /Address: 12 Ewet Housing, Uyo/);
    assert.match(r, /To prepare: Clear the space around your AC/);
    assert.match(r, /4-digit start code/);
    assert.equal(await sent(w, () => reminderSweep(at - 20 * 3600_000)), '', 'never twice');

    // The pro asks for another time; the customer keeps the old one with a WhatsApp tap.
    const proposal = await app.inject({ method: 'POST', url: `/v1/bookings/${bookingId}/change-time`, headers: bearer(pro.token), payload: { scheduledAt: new Date(at + 2 * 86_400_000).toISOString(), window: 'evening' } });
    assert.equal(proposal.statusCode, 200, proposal.body);
    r = await sent(w, () => tap(w, `sched:decline:${proposal.json().data.changeId}`, 'Keep old time'));
    assert.match(r, /OK, your booking stays at \w{3} \d{1,2} \w{3}, 8am–12pm\./);
    assert.equal(Date.parse(String((await q<{ s: string }>(`SELECT scheduled_at AS s FROM booking.booking WHERE id=$1`, [bookingId]))[0].s)), at, 'time unchanged');
    r = await sent(w, () => tap(w, `sched:decline:${proposal.json().data.changeId}`, 'Keep old time'));
    assert.match(r, /already answered/);

    // 1h reminder: due soon, with the date and window.
    r = await sent(w, () => reminderSweep(at - 30 * 60_000));
    assert.match(r, /Your Kendibo pro is due soon \(\w{3} \d{1,2} \w{3}, 8am–12pm\)/);
    assert.equal(await sent(w, () => reminderSweep(at - 20 * 60_000)), '', '1h reminder never twice');

    // 7. On the way (start code) -> arrive -> check in with the code -> work -> done.
    r = await sentSoon(w, async () => assert.equal((await move(pro.token, bookingId, 'EN_ROUTE')).statusCode, 200), /start code: \d{4}/);
    assert.match(r, /Your Kendibo pro is on the way/);
    const code = /start code: (\d{4})/.exec(r)?.[1];
    assert.ok(code, `start code sent: ${r}`);
    assert.equal((await move(pro.token, bookingId, 'ARRIVED')).statusCode, 200);
    assert.equal((await move(pro.token, bookingId, 'CHECK_IN', code)).statusCode, 200);
    assert.equal((await move(pro.token, bookingId, 'IN_PROGRESS')).statusCode, 200);
    r = await sentSoon(w, async () => assert.equal((await move(pro.token, bookingId, 'COMPLETED')).statusCode, 200), /Reply DONE/);
    assert.match(r, /Reply DONE to confirm/);

    // 8. Customer DONE -> settlement -> final invoice.
    r = await sentSoon(w, () => say(w, 'DONE'), /invoice KND-/);
    const earning = await q(`SELECT 1 FROM provider.earning WHERE job_id=$1`, [bookingId]);
    assert.equal(earning.length, 1, 'settled: the pro was credited');
    assert.match(r, /Your Kendibo invoice KND-\d{4}-\d{6} is ready: .+, ₦[\d,.]+ paid/);
    const finalCta = ctas.filter((c) => c.to === w && /\/w\/invoice\//.test(c.url));
    assert.equal(finalCta.length, 2, 'final invoice link sent');
    assert.ok(mails.some((m) => m.to === address && /invoice KND-/.test(m.subject)), 'final invoice emailed');
    const finalPage = await app.inject({ method: 'GET', url: finalCta[1].url.replace(/^https?:\/\/[^/]+/, '') });
    assert.equal(finalPage.statusCode, 200);
    assert.match(finalPage.body, /<h1>Invoice<\/h1>/);
    assert.match(finalPage.body, /Ewet Cool Air/);
    assert.match(finalPage.body, new RegExp(reference));
    assert.match(finalPage.body, /Kendibo Technologies Ltd/);
    const invoices = await q<{ kind: string; number: string }>(`SELECT kind, number FROM billing.invoice WHERE booking_id=$1 AND kind=$2`, [bookingId, 'final']);
    assert.equal(invoices.length, 1);

    // The customer's API view and the pro's earnings statement.
    const custToken = signAccess(String(user.id), ['booking:view:self']);
    const api = await app.inject({ method: 'GET', url: `/v1/bookings/${bookingId}/invoice`, headers: bearer(custToken) });
    assert.equal(api.statusCode, 200, api.body);
    assert.equal(api.json().data.kind, 'final');
    assert.equal(api.json().data.number, invoices[0].number);
    const listed = String((await q<{ p: string }>(`SELECT price_kobo AS p FROM booking.booking WHERE id=$1`, [bookingId]))[0].p);
    assert.equal(api.json().data.totalKobo, listed, 'the customer pays the listed price; commission/VAT stay provider-side');
    assert.equal(api.json().data.paidKobo, listed);
    assert.doesNotMatch(finalPage.body, /commission|VAT/i);
    const proView = await app.inject({ method: 'GET', url: `/v1/bookings/${bookingId}/invoice`, headers: bearer(pro.token) });
    assert.equal(proView.statusCode, 200, proView.body);
    assert.equal(proView.json().data.kind, 'earnings_statement');
    assert.equal(proView.json().data.settled, true);

    // For the /invoice command: the newest document.
    const { latestInvoiceFor } = await import('../modules/invoices/invoice.service.js');
    assert.equal((await latestInvoiceFor(String(user.id)))?.kind, 'final');
    r = await sent(w, () => say(w, '/invoice'));
    assert.match(r, new RegExp(`Your Kendibo invoice ${invoices[0].number} is ready`), 'the /invoice command resends the newest document');
    assert.equal((await q(`SELECT 1 FROM billing.invoice WHERE booking_id=$1`, [bookingId])).length, 2, 'resending issues nothing new');

    // 9. Review.
    const review = await app.inject({ method: 'POST', url: '/v1/reviews', headers: bearer(signAccess(String(user.id), [])), payload: { bookingId, rating: 5, tags: ['on_time'], comment: 'Cool again' } });
    assert.equal(review.statusCode, 200, review.body);
  });
});

// ── Focused tests ──────────────────────────────────────────────────────────
async function paidBooking(opts: { phone?: string; proPhone?: string } = {}) {
  const pro = await onlinePro(opts.proPhone);
  const cust = String((await q<{ id: string }>(`INSERT INTO identity.users (email, name, phone) VALUES ($1,'Bisi Test',$2) RETURNING id`, [`c-${randomUUID()}@kendibo.local`, opts.phone ?? null]))[0].id);
  const token = signAccess(cust, ['booking:create', 'booking:view:self', 'booking:cancel']);
  const created = await app.inject({ method: 'POST', url: '/v1/service-requests', headers: { ...bearer(token), 'idempotency-key': `idem-${randomUUID()}` }, payload: { categoryId: 'ac', title: 'AC not cooling', details: 'warm air', urgency: 'today', ...UYO } });
  assert.equal(created.statusCode, 200, created.body);
  const offer = (await q<{ id: string; request_id: string; provider_id: string }>(`SELECT id, request_id, provider_id FROM booking.request_offer`))
    .find((o) => String(o.request_id) === created.json().data.id && String(o.provider_id) === pro.providerId);
  const acc = await app.inject({ method: 'POST', url: `/v1/provider/requests/${offer!.id}/respond`, headers: bearer(pro.token), payload: { accept: true } });
  assert.equal(acc.statusCode, 200, acc.body);
  const bookingId = String(acc.json().data.bookingId);
  const price = (await q<{ p: string }>(`SELECT price_kobo AS p FROM booking.booking WHERE id=$1`, [bookingId]))[0].p;
  await q(`INSERT INTO payment.payment (booking_id, psp, reference, amount_kobo, status) VALUES ($1,'bachs',$2,$3,'successful')`, [bookingId, `bk_${bookingId}_t`, String(price)]);
  return { bookingId, customerId: cust, token, pro };
}

describe('invoices', () => {
  it('numbers sequentially, one per kind per booking, and only once paid', async () => {
    const { issueInvoice, formatNumber } = await import('../modules/invoices/invoice.service.js');
    assert.equal(formatNumber(2026, 123), 'KND-2026-000123');
    const a = await paidBooking();
    const b = await paidBooking();
    const ra = await issueInvoice(a.bookingId, 'receipt');
    const again = await issueInvoice(a.bookingId, 'receipt');
    assert.equal(again!.id, ra!.id, 'same receipt on a second call');
    const rb = await issueInvoice(b.bookingId, 'receipt');
    const n = (s: string) => Number(s.split('-')[2]);
    assert.match(ra!.number, /^KND-\d{4}-\d{6}$/);
    assert.equal(n(rb!.number), n(ra!.number) + 1, 'next number');
    // An approved extra (paid separately) shows on the final invoice; a declined one does not.
    await q(`INSERT INTO booking.change_order (job_id, reason, amount_kobo, status) VALUES ($1,'Replace drain pipe',500000,'approved'), ($1,'Gas top-up',900000,'declined')`, [a.bookingId]);
    await q(`INSERT INTO payment.payment (booking_id, psp, reference, amount_kobo, status) VALUES ($1,'bachs',$2,500000,'successful')`, [a.bookingId, `co_${a.bookingId}_t`]);
    const fa = await issueInvoice(a.bookingId, 'final');
    assert.notEqual(fa!.id, ra!.id, 'final is its own document');
    const price = BigInt(fa!.data.lines[0].amountKobo);
    assert.deepEqual(fa!.data.lines.slice(1), [{ label: 'Extra: Replace drain pipe', amountKobo: '500000' }]);
    assert.equal(fa!.data.totalKobo, String(price + 500000n), 'listed price + approved extras, no commission or VAT added');
    assert.equal(fa!.data.paidKobo, fa!.data.totalKobo);
    assert.equal(ra!.data.paidKobo, String(price), 'the receipt shows what was paid then');
    assert.equal((await issueInvoice(a.bookingId, 'final'))!.id, fa!.id);
    const rows = await q(`SELECT 1 FROM billing.invoice WHERE booking_id=$1 AND kind=$2`, [a.bookingId, 'receipt']);
    assert.equal(rows.length, 1);
    await q(`UPDATE payment.payment SET status='refunded' WHERE booking_id=$1`, [b.bookingId]);
    const unpaid = await paidBooking();
    await q(`DELETE FROM payment.payment WHERE booking_id=$1`, [unpaid.bookingId]);
    assert.equal(await issueInvoice(unpaid.bookingId, 'receipt'), null, 'nothing paid, no receipt');
  });

  it('serves the hosted page for a valid link, 403 for a tampered one', async () => {
    const { issueInvoice } = await import('../modules/invoices/invoice.service.js');
    const { invoiceLink, signLink } = await import('../modules/whatsapp/links.js');
    const { bookingId, customerId } = await paidBooking();
    const inv = (await issueInvoice(bookingId, 'receipt'))!;
    const path = invoiceLink(customerId, inv.id).replace(/^https?:\/\/[^/]+/, '');
    const ok = await app.inject({ method: 'GET', url: path });
    assert.equal(ok.statusCode, 200);
    assert.match(ok.body, new RegExp(inv.number));
    assert.match(String(ok.headers?.['content-security-policy'] ?? "default-src 'none'"), /default-src 'none'/);
    const token = decodeURIComponent(path.split('/').pop()!);
    const [body, mac] = token.split('.');
    const flipped = `${body}.${mac.slice(0, -2)}${mac.endsWith('AA') ? 'BB' : 'AA'}`;
    assert.equal((await app.inject({ method: 'GET', url: `/w/invoice/${encodeURIComponent(flipped)}` })).statusCode, 403, 'tampered MAC');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), w: randomUUID() })).toString('base64url');
    assert.equal((await app.inject({ method: 'GET', url: `/w/invoice/${encodeURIComponent(`${forged}.${mac}`)}` })).statusCode, 403, 'edited claims');
    const otherPurpose = signLink({ w: customerId, d: inv.id, p: 'pay' });
    assert.equal((await app.inject({ method: 'GET', url: `/w/invoice/${encodeURIComponent(otherPurpose)}` })).statusCode, 403, 'a pay link is not an invoice link');
    const expired = signLink({ w: customerId, d: inv.id, p: 'invoice' }, -60);
    const gone = await app.inject({ method: 'GET', url: `/w/invoice/${encodeURIComponent(expired)}` });
    assert.equal(gone.statusCode, 403, 'expired link');
    assert.match(gone.body, /not valid/);
    assert.doesNotMatch(gone.body, new RegExp(inv.number), 'nothing leaks on a refused link');
    const wrongOwner = signLink({ w: randomUUID(), d: inv.id, p: 'invoice' });
    assert.equal((await app.inject({ method: 'GET', url: `/w/invoice/${encodeURIComponent(wrongOwner)}` })).statusCode, 404, 'bound to the customer');
  });

  it('sendInvoice resends on request; the API refuses strangers', async () => {
    const { sendInvoice } = await import('../modules/invoices/invoice.service.js');
    const phone = newNumber();
    await q(`INSERT INTO messaging.whatsapp_inbound (message_id, wa_id) VALUES ($1,$2)`, [`wamid.${randomUUID()}`, phone]);
    const { bookingId } = await paidBooking({ phone: `+${phone}` });
    const first = await sent(phone, () => sendInvoice(bookingId));
    assert.match(first, /Your receipt is KND-/);
    const second = await sent(phone, () => sendInvoice(bookingId));
    assert.match(second, /Your receipt is KND-/, 'the /invoice command always answers');
    const stranger = String((await q<{ id: string }>(`INSERT INTO identity.users (email) VALUES ($1) RETURNING id`, [`s-${randomUUID()}@kendibo.local`]))[0].id);
    const res = await app.inject({ method: 'GET', url: `/v1/bookings/${bookingId}/invoice`, headers: bearer(signAccess(stranger, [])) });
    assert.equal(res.statusCode, 403);
  });
});

describe('schedule updates', () => {
  it('tells the customer old -> new time on a reschedule and resets the reminders', async () => {
    const phone = newNumber(); const proPhone = newNumber();
    for (const n of [phone, proPhone]) await q(`INSERT INTO messaging.whatsapp_inbound (message_id, wa_id) VALUES ($1,$2)`, [`wamid.${randomUUID()}`, n]);
    const { bookingId, token } = await paidBooking({ phone: `+${phone}`, proPhone: `+${proPhone}` });
    const from = new Date(Date.now() + 2 * 86_400_000); from.setUTCHours(8, 0, 0, 0); // 9am Lagos
    await q(`UPDATE booking.booking SET scheduled_at=$2, time_window=NULL, reminder_24h_at=now() WHERE id=$1`, [bookingId, from.toISOString()]);
    const to = new Date(from.getTime() + 86_400_000);
    const { formatWhen } = await import('../modules/invoices/when.js');
    let res: Res | undefined;
    let proMsg = '';
    const msg = await sent(phone, async () => {
      proMsg = await sent(proPhone, async () => {
        res = await app.inject({ method: 'POST', url: `/v1/bookings/${bookingId}/change-time`, headers: bearer(token), payload: { scheduledAt: to.toISOString(), window: 'afternoon' } });
      });
    });
    assert.equal(res!.statusCode, 200, res!.body);
    assert.equal(msg, `Your Kendibo booking has moved from ${formatWhen(from)} to ${formatWhen(to, 'afternoon')}. Your pro has been told.`);
    assert.match(formatWhen(to, 'afternoon'), /^\w{3} \d{1,2} \w{3}, 12pm–4pm$/);
    assert.match(formatWhen(from), /^\w{3} \d{1,2} \w{3}, 9am$/);
    assert.equal(proMsg, `Booking moved from ${formatWhen(from)} to ${formatWhen(to, 'afternoon')}. Please plan for the new time.`);
    const b = (await q<{ d: string | null; w: string }>(`SELECT reminder_24h_at AS d, time_window AS w FROM booking.booking WHERE id=$1`, [bookingId]))[0];
    assert.equal(b.d, null, '24h reminder will fire again for the new time');
    assert.equal(b.w, 'afternoon');
    const past = await app.inject({ method: 'POST', url: `/v1/bookings/${bookingId}/change-time`, headers: bearer(token), payload: { scheduledAt: '2020-01-01T10:00:00Z' } });
    assert.equal(past.statusCode, 400);
  });

  it('a new date from the pro waits for the customer to accept it', async () => {
    const phone = newNumber(); const proPhone = newNumber();
    for (const n of [phone, proPhone]) await q(`INSERT INTO messaging.whatsapp_inbound (message_id, wa_id) VALUES ($1,$2)`, [`wamid.${randomUUID()}`, n]);
    const { bookingId, token, pro } = await paidBooking({ phone: `+${phone}`, proPhone: `+${proPhone}` });
    const before = (await q<{ s: string }>(`SELECT scheduled_at AS s FROM booking.booking WHERE id=$1`, [bookingId]))[0].s;
    const to = new Date(Date.now() + 3 * 86_400_000).toISOString();
    let res: Res | undefined;
    const ask = await sent(phone, async () => {
      res = await app.inject({ method: 'POST', url: `/v1/bookings/${bookingId}/change-time`, headers: bearer(pro.token), payload: { scheduledAt: to, window: 'morning' } });
    });
    assert.equal(res!.statusCode, 200, res!.body);
    assert.equal(res!.json().data.status, 'proposed');
    assert.match(ask, /Ewet Cool Air asked to change your booking from .+ to \w{3} \d{1,2} \w{3}, 8am–12pm\. Is the new time OK\? \[Accept new time \| Keep old time\]/);
    const still = (await q<{ s: string }>(`SELECT scheduled_at AS s FROM booking.booking WHERE id=$1`, [bookingId]))[0].s;
    assert.equal(String(still), String(before), 'nothing changes before the customer accepts');
    const changeId = String(res!.json().data.changeId);
    const proHeard = await sent(proPhone, async () => {
      const ok = await app.inject({ method: 'POST', url: `/v1/bookings/${bookingId}/schedule-changes/${changeId}`, headers: bearer(token), payload: { accept: true } });
      assert.equal(ok.statusCode, 200, ok.body);
    });
    assert.match(proHeard, /The customer accepted the new time: \w{3} \d{1,2} \w{3}, 8am–12pm/);
    const moved = (await q<{ s: string }>(`SELECT scheduled_at AS s FROM booking.booking WHERE id=$1`, [bookingId]))[0].s;
    assert.equal(Math.floor(Date.parse(String(moved)) / 1000), Math.floor(Date.parse(to) / 1000), 'moved to the proposed time');
    const twice = await app.inject({ method: 'POST', url: `/v1/bookings/${bookingId}/schedule-changes/${changeId}`, headers: bearer(token), payload: { accept: true } });
    assert.equal(twice.statusCode, 409);
  });

  it('reminds the pro once, the evening before', async () => {
    const { providerEveningSweep } = await import('../modules/job-engine/schedule-updates.js');
    const proPhone = newNumber();
    await q(`INSERT INTO messaging.whatsapp_inbound (message_id, wa_id) VALUES ($1,$2)`, [`wamid.${randomUUID()}`, proPhone]);
    const { bookingId } = await paidBooking({ proPhone: `+${proPhone}` });
    const job = new Date(Date.now() + 3 * 86_400_000); job.setUTCHours(9, 0, 0, 0); // 10am Lagos
    await q(`UPDATE booking.booking SET scheduled_at=$2, time_window='morning' WHERE id=$1`, [bookingId, job.toISOString()]);
    const evening = job.getTime() - 15 * 3600_000; // 7pm Lagos the day before
    assert.equal(await sent(proPhone, () => providerEveningSweep(job.getTime() - 18 * 3600_000)), '', 'not before 6pm');
    const r = await sent(proPhone, () => providerEveningSweep(evening));
    assert.match(r, /^Tomorrow: .+, \w{3} \d{1,2} \w{3}, 8am–12pm\..*Customer: Bisi\./);
    assert.equal(await sent(proPhone, () => providerEveningSweep(evening + 600_000)), '', 'once');
  });
});
