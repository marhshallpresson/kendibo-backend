// WhatsApp slash menu, onboarding tip, account RECOVER and session mode.
// The WhatsApp client runs in dev mode (no token: replies are only recorded as
// assistant turns) and the mailer is stubbed, so nothing leaves the machine.
import 'dotenv/config';
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { q } from '../packages/database/db.js';

process.env.NODE_ENV = 'test';
let app: { inject: (opts: any) => Promise<any>; close?: () => Promise<void> };
type Mail = { to: string; subject: string; html: string };
const mails: Mail[] = [];
let restoreMail: (() => void) | null = null;

before(async () => {
  process.env.DATABASE_URL = '';
  ({ app } = await import('../apps/api/src/main.js'));
  delete process.env.DATABASE_URL;
  const { email } = await import('../modules/notifications/channels.js');
  const original = email.send.bind(email);
  email.send = async (to: string, subject: string, html: string) => { mails.push({ to, subject, html }); return { id: `stub_${mails.length}` }; };
  restoreMail = () => { email.send = original; };
});
after(async () => {
  restoreMail?.();
  process.env.WHATSAPP_CONSENT_GATE = 'off';
  await app?.close?.().catch(() => {});
});
beforeEach(() => { mails.length = 0; });

const bot = () => import('../modules/whatsapp/whatsapp.bot.js');
const newNumber = () => `23481${Math.floor(1e7 + Math.random() * 8e7)}`;
const replies = async (waId: string) =>
  (await q<{ content: string }>(`SELECT content FROM messaging.whatsapp_turn WHERE wa_id=$1 AND role='assistant' ORDER BY created_at`, [waId])).map((r) => String(r.content));
const last = async (waId: string) => (await replies(waId)).at(-1) ?? '';
async function say(waId: string, body: string, name?: string) {
  const { handleInbound } = await bot();
  await handleInbound({ id: `wamid.${randomUUID()}`, from: waId, type: 'text', text: { body } }, name);
}
async function tap(waId: string, id: string, name?: string) {
  const { handleInbound } = await bot();
  await handleInbound({ id: `wamid.${randomUUID()}`, from: waId, type: 'interactive', interactive: { button_reply: { id, title: '' } } }, name);
}
async function customer(waId: string, extra: { email?: string; name?: string } = {}): Promise<string> {
  const r = await q<{ id: string }>(`INSERT INTO identity.users (phone, role, terms_accepted_at, email, name) VALUES ($1,'CUSTOMER',now(),$2,$3) RETURNING id`,
    [`+${waId}`, extra.email ?? null, extra.name ?? null]);
  return String(r[0].id);
}
const codeFrom = (m: Mail) => (m.html.match(/>(\d{6})</) ?? [])[1] ?? '';

describe('WhatsApp slash commands', () => {
  it('"/", "/help" and "menu" list the commands with every active category', async () => {
    const wa = newNumber();
    await customer(wa);
    for (const t of ['/', '/help', 'menu']) {
      await say(wa, t);
      const m = await last(wa);
      for (const c of ['/book', '/cleaning', '/ac', '/plumbing', '/sessions', '/switch', '/status', '/pay', '/invoice', '/reschedule', '/cancel', '/verify', '/recover', '/agent', '/stop']) {
        assert.ok(m.includes(c), `${t}: menu is missing ${c}\n${m}`);
      }
    }
  });

  it('an unknown command says so and shows the menu', async () => {
    const wa = newNumber();
    await customer(wa);
    await say(wa, '/xyz');
    const m = await last(wa);
    assert.match(m, /I don't know that one/);
    assert.match(m, /\/book/);
  });

  it('slash commands and the old uppercase shortcuts do the same thing', async () => {
    const a = newNumber(); const b = newNumber();
    await customer(a); await customer(b);
    await say(a, 'PAY'); await say(b, '/pay');
    assert.equal(await last(a), await last(b));
    assert.match(await last(a), /anything to pay/);
    await say(a, 'VERIFY'); await say(b, '/verify');
    assert.equal(await last(a), await last(b));
    assert.match(await last(b), /secure page/);
    await say(a, 'DONE'); await say(b, '/done');
    assert.equal(await last(a), await last(b));
    await say(a, 'STOP'); await say(b, '/stop');
    assert.equal(await last(a), await last(b));
    assert.match(await last(b), /won't get offers or promotions/);
  });

  it('/agent hands the chat to a person, like AGENT', async () => {
    const a = newNumber(); const b = newNumber();
    await customer(a); await customer(b);
    await say(a, 'AGENT'); await say(b, '/agent');
    assert.match(await last(a), /Kendibo team will reply/);
    assert.equal(await last(a), await last(b));
    const s = await q<{ state: string }>(`SELECT state FROM messaging.whatsapp_session WHERE wa_id=$1`, [b]);
    assert.equal(s[0].state, 'HUMAN');
  });

  it('/<category> starts a request in that trade', async () => {
    const wa = newNumber();
    await customer(wa);
    await say(wa, '/ac');
    const d = await q<{ category_id: string }>(`SELECT category_id FROM messaging.whatsapp_job_draft WHERE wa_id=$1 AND status='collecting'`, [wa]);
    assert.equal(d[0]?.category_id, 'ac');
  });
});

describe('WhatsApp onboarding tip', () => {
  it('after the email step (or skip) sends one tip about "/"', async () => {
    process.env.WHATSAPP_CONSENT_GATE = 'on';
    try {
      const wa = newNumber();
      await say(wa, 'hi', 'Ngozi Eze');
      await tap(wa, 'consent:agree', 'Ngozi Eze');
      await tap(wa, 'onb:name:yes', 'Ngozi Eze');
      await tap(wa, 'onb:email:skip', 'Ngozi Eze');
      const tips = (await replies(wa)).filter((t) => /type \/ any time/.test(t));
      assert.equal(tips.length, 1, 'exactly one tip');
      assert.match(tips[0], /\/book/);
      assert.match(tips[0], /\/status/);
      assert.match(tips[0], /\/agent/);
    } finally {
      process.env.WHATSAPP_CONSENT_GATE = 'off';
    }
  });
});

describe('WhatsApp RECOVER', () => {
  async function oldAccount() {
    const oldWa = newNumber();
    const email = `old-${randomUUID().slice(0, 8)}@example.com`;
    const id = await customer(oldWa, { email, name: 'Chidi Okafor' });
    return { id, email, oldWa };
  }

  it('happy path: code emailed, number moved to the old account, old email told', async () => {
    const { id, email } = await oldAccount();
    const wa = newNumber();
    await customer(wa); // the empty account this new number got on first contact
    await say(wa, 'I lost my number');
    await say(wa, 'recover');
    assert.match(await last(wa), /email or phone number/);
    await say(wa, email.toUpperCase());
    assert.match(await last(wa), /If that matches a Kendibo account/);
    assert.equal(mails.length, 1, (await replies(wa)).join(" || "));
    assert.equal(mails[0].to, email);
    const code = codeFrom(mails[0]);
    assert.match(code, /^\d{6}$/);
    await say(wa, code);
    assert.match(await last(wa), /Welcome back, Chidi/);
    const owner = await q<{ id: string }>(`SELECT id FROM identity.users WHERE phone=$1`, [`+${wa}`]);
    assert.equal(owner.length, 1, 'the number is on exactly one account');
    assert.equal(String(owner[0].id), id, 'the number now belongs to the old account');
    const audit = await q(`SELECT 1 FROM audit.log WHERE entity_id=$1 AND action='account.recovered_to_new_number'`, [id]);
    assert.equal(audit.length, 1);
    assert.equal(mails.length, 2);
    assert.equal(mails[1].to, email);
    assert.match(mails[1].html, new RegExp(`ending ${wa.slice(-4)}`));
    assert.match(mails[1].html, /wasn't you/);
    // The next message is handled as the recovered account.
    const s = await q<{ user_id: string }>(`SELECT user_id FROM messaging.whatsapp_session WHERE wa_id=$1`, [wa]);
    assert.equal(String(s[0].user_id), id);
  });

  it('works with the old phone number too', async () => {
    const { id, oldWa } = await oldAccount();
    const wa = newNumber();
    await say(wa, '/recover');
    await say(wa, `0${oldWa.slice(3)}`);
    assert.equal(mails.length, 1, (await replies(wa)).join(" || "));
    await say(wa, codeFrom(mails[0]));
    const owner = await q<{ id: string }>(`SELECT id FROM identity.users WHERE phone=$1`, [`+${wa}`]);
    assert.equal(String(owner[0].id), id);
  });

  it('same reply for an unknown email (no account enumeration), and no email sent', async () => {
    const { email } = await oldAccount();
    const a = newNumber(); const b = newNumber();
    await say(a, '/recover'); await say(a, email);
    await say(b, '/recover'); await say(b, `nobody-${randomUUID().slice(0, 6)}@example.com`);
    assert.equal(await last(a), await last(b));
    assert.equal(mails.length, 1, 'only the real account got a code');
    await say(b, '123456');
    assert.match(await last(b), /doesn't match/);
  });

  it('wrong code is refused; 5 wrong tries kill the code', async () => {
    const { id, email } = await oldAccount();
    const wa = newNumber();
    await say(wa, '/recover'); await say(wa, email);
    const code = codeFrom(mails[0]);
    const wrong = code === '000000' ? '111111' : '000000';
    await say(wa, wrong);
    assert.match(await last(wa), /doesn't match.*4 tries left/s);
    for (let i = 0; i < 4; i++) await say(wa, wrong);
    assert.match(await last(wa), /last try/);
    await say(wa, '/recover');
    await say(wa, code); // the old code, after the flow was restarted: not an account identifier
    const owner = await q<{ id: string }>(`SELECT id FROM identity.users WHERE phone=$1`, [`+${wa}`]);
    assert.notEqual(String(owner[0]?.id ?? ''), id, 'a killed code never moves the number');
  });

  it('an expired code is refused', async () => {
    const { id, email } = await oldAccount();
    const wa = newNumber();
    await say(wa, '/recover'); await say(wa, email);
    await q(`UPDATE messaging.whatsapp_recovery SET expires_at=$2 WHERE wa_id=$1`, [wa, new Date(Date.now() - 1000).toISOString()]);
    await say(wa, codeFrom(mails[0]));
    assert.match(await last(wa), /expired/);
    const owner = await q<{ id: string }>(`SELECT id FROM identity.users WHERE phone=$1`, [`+${wa}`]);
    assert.notEqual(String(owner[0]?.id ?? ''), id);
  });

  it('at most 3 recovery attempts per number per day', async () => {
    const wa = newNumber();
    for (let i = 0; i < 3; i++) { await say(wa, '/recover'); await say(wa, `x${i}-${randomUUID().slice(0, 6)}@example.com`); }
    await say(wa, '/recover');
    assert.match(await last(wa), /3 times today/);
  });

  it('never merges into a number that has its own bookings: opens a ticket instead', async () => {
    const { id, email } = await oldAccount();
    const wa = newNumber();
    const mine = await customer(wa);
    await q(`INSERT INTO booking.service_request (user_id, title, idempotency_key) VALUES ($1,'Fix my sink',$2)`, [mine, randomUUID()]);
    await say(wa, '/recover'); await say(wa, email);
    await say(wa, codeFrom(mails[0]));
    assert.match(await last(wa), /can't join the two accounts/);
    const owner = await q<{ id: string }>(`SELECT id FROM identity.users WHERE phone=$1`, [`+${wa}`]);
    assert.equal(String(owner[0].id), mine, 'the number stays where it was');
    assert.notEqual(String(owner[0].id), id);
    const t = await q(`SELECT 1 FROM support.ticket WHERE customer_id=$1 AND reason LIKE '%account recovery%'`, [mine]);
    assert.equal(t.length, 1);
    assert.equal(mails.length, 1, 'no "account moved" email');
  });
});

describe('WhatsApp session mode', () => {
  it('each request gets a tag; /sessions lists them; /switch changes what /status reports on', async () => {
    const wa = newNumber();
    const uid = await customer(wa);
    const { requestService } = await import('../modules/requests/request.service.js');
    const { activeRequestFor } = await import('../modules/whatsapp/sessions.js');
    const ac = await requestService.create(uid, { categoryId: 'ac', title: 'AC not cooling', idempotencyKey: randomUUID(), source: 'whatsapp' });
    const acTag = String((await q<{ t: string }>(`SELECT session_tag AS t FROM booking.service_request WHERE id=$1`, [ac.id]))[0].t);
    assert.match(acTag, /^AC-\d{4}$/);
    const cl = await requestService.create(uid, { categoryId: 'cleaning', title: 'Deep clean 3-bed flat', idempotencyKey: randomUUID(), source: 'whatsapp' });
    const clTag = String((await q<{ t: string }>(`SELECT session_tag AS t FROM booking.service_request WHERE id=$1`, [cl.id]))[0].t);
    assert.match(clTag, /^CLN-\d{4}$/);
    assert.equal((await activeRequestFor(uid))?.id, cl.id, 'the newest request is active; the first one is untouched');
    const first = await q<{ status: string }>(`SELECT status FROM booking.service_request WHERE id=$1`, [ac.id]);
    assert.equal(first[0].status, 'SUBMITTED');

    await say(wa, '/sessions');
    const list = await last(wa);
    assert.ok(list.includes(acTag) && list.includes(clTag), list);
    assert.match(list, /AC Services/);
    assert.match(list, /Cleaning/);

    await say(wa, '/status');
    assert.ok((await last(wa)).startsWith(`[${clTag}]`), await last(wa));

    await say(wa, `/switch ${acTag}`);
    assert.match(await last(wa), new RegExp(`^\\[${acTag}\\]`));
    await say(wa, '/status');
    assert.ok((await last(wa)).startsWith(`[${acTag}]`), await last(wa));
    assert.equal((await activeRequestFor(uid))?.id, ac.id);

    // Just sending the tag switches too.
    await say(wa, clTag.toLowerCase());
    await say(wa, '/status');
    assert.ok((await last(wa)).startsWith(`[${clTag}]`), await last(wa));

    // A tag that isn't theirs is refused.
    await say(wa, '/switch AC-0000');
    assert.match(await last(wa), /can't find an open request/);
  });

  it('/cancel acts on the active session; with one open session there is no tag prefix', async () => {
    const wa = newNumber();
    const uid = await customer(wa);
    const { requestService } = await import('../modules/requests/request.service.js');
    const r = await requestService.create(uid, { categoryId: 'plumbing', title: 'Leaking tap', idempotencyKey: randomUUID(), source: 'whatsapp' });
    await say(wa, '/status');
    assert.doesNotMatch(await last(wa), /^\[/);
    await say(wa, '/cancel');
    assert.match(await last(wa), /Cancel this request/);
    await tap(wa, `sess:cancel:${r.id}`);
    const s = await q<{ status: string }>(`SELECT status FROM booking.service_request WHERE id=$1`, [r.id]);
    assert.equal(s[0].status, 'CANCELLED');
    await say(wa, '/sessions');
    assert.match(await last(wa), /don't have any open requests/);
  });

  it('/invoice without an invoice yet says it will come after payment', async () => {
    const wa = newNumber();
    await customer(wa);
    await say(wa, '/invoice');
    assert.match(await last(wa), /invoice will arrive here after payment/);
  });

  it('/sessions uses plain words (no internal status codes) and shows a date', async () => {
    const wa = newNumber();
    const uid = await customer(wa);
    const { requestService } = await import('../modules/requests/request.service.js');
    await requestService.create(uid, { categoryId: 'ac', title: 'AC leaking water', idempotencyKey: randomUUID(), source: 'whatsapp' });
    await say(wa, '/sessions');
    const list = await last(wa);
    assert.doesNotMatch(list, /SUBMITTED|MATCHING|submitted/);
    assert.match(list, /finding you a pro/);
    assert.match(list, /asked \w{3}/);
  });

  it('/invoice goes through the invoices module when it is present', async () => {
    const hook = await import('../modules/whatsapp/invoice-hook.js');
    const sent: string[] = [];
    hook.setInvoiceModuleForTests(async () => ({
      sendInvoice: async (bookingId: string) => { sent.push(bookingId); return { number: 'KND-2026-000001', url: 'https://example.test/i/1' }; },
      latestInvoiceFor: async () => ({ number: 'KND-2026-000009', url: 'https://example.test/i/9', kind: 'final' }),
    }));
    try {
      // No open session: the latest document is sent.
      const a = newNumber();
      await customer(a);
      await say(a, '/invoice');
      assert.match(await last(a), /latest Kendibo invoice, KND-2026-000009/);
      // Active session with a booking: that booking's invoice is (re)sent.
      const b = newNumber();
      const uid = await customer(b);
      const { requestService } = await import('../modules/requests/request.service.js');
      const r = await requestService.create(uid, { categoryId: 'plumbing', title: 'Burst pipe', idempotencyKey: randomUUID(), source: 'whatsapp' });
      const svc = await q<{ id: string }>(`SELECT id FROM catalog.service LIMIT 1`);
      const bookingId = String((await q<{ id: string }>(
        `INSERT INTO booking.booking (user_id, service_id, address_id, status, price_kobo, price_snapshot, scheduled_at, idempotency_key)
         VALUES ($1, $2, NULL, 'REQUESTED', 5000, '{}'::jsonb, now(), $3) RETURNING id`, [uid, svc[0].id, `kt_${randomUUID()}`]))[0].id);
      await q(`UPDATE booking.service_request SET booking_id=$2 WHERE id=$1`, [r.id, bookingId]);
      await say(b, '/invoice');
      assert.deepEqual(sent, [bookingId]);
    } finally {
      hook.setInvoiceModuleForTests(null);
    }
  });
});
