// Would-be providers / vendors on WhatsApp get one short message with a
// "Join as a provider" button to the sign-up page (VENDOR_SIGNUP_URL), at any
// point, without losing a booking in progress, and at most once per 10 minutes.
// New users are asked once after onboarding: book a service, or offer services?
// The WhatsApp client runs in dev mode (no token) and ctaUrl is captured here,
// so nothing leaves the machine.
import 'dotenv/config';
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { q } from '../packages/database/db.js';

process.env.NODE_ENV = 'test';
// The post-onboarding question belongs to the full onboarding; the default is the light one.
process.env.WHATSAPP_ONBOARDING = 'full';
const SIGNUP = 'https://example.test/join-provider';
let app: { close?: () => Promise<void> };
type Cta = { to: string; body: string; label: string; url: string };
const ctas: Cta[] = [];
let restore: (() => void) | null = null;

before(async () => {
  process.env.DATABASE_URL = '';
  process.env.VENDOR_SIGNUP_URL = SIGNUP;
  ({ app } = await import('../apps/api/src/main.js'));
  delete process.env.DATABASE_URL;
  const { wa } = await import('../modules/whatsapp/whatsapp.client.js');
  const original = wa.ctaUrl;
  wa.ctaUrl = async (to: string, body: string, label: string, url: string) => {
    ctas.push({ to, body, label, url });
    return original(to, body, label, url); // dev mode: only recorded as a turn
  };
  restore = () => { wa.ctaUrl = original; };
});
after(async () => {
  restore?.();
  delete process.env.VENDOR_SIGNUP_URL;
  process.env.WHATSAPP_CONSENT_GATE = 'off';
  await app?.close?.().catch(() => {});
});
beforeEach(() => { ctas.length = 0; });

const bot = () => import('../modules/whatsapp/whatsapp.bot.js');
const newNumber = () => `23481${Math.floor(1e7 + Math.random() * 8e7)}`;
const replies = async (waId: string) =>
  (await q<{ content: string }>(`SELECT content FROM messaging.whatsapp_turn WHERE wa_id=$1 AND role='assistant' ORDER BY created_at`, [waId])).map((r) => String(r.content));
const last = async (waId: string) => (await replies(waId)).at(-1) ?? '';
const joinCtas = (waId: string) => ctas.filter((c) => c.to === waId && c.label === 'Join as a provider');
async function say(waId: string, body: string, name?: string) {
  const { handleInbound } = await bot();
  await handleInbound({ id: `wamid.${randomUUID()}`, from: waId, type: 'text', text: { body } }, name);
}
async function tap(waId: string, id: string, name?: string) {
  const { handleInbound } = await bot();
  await handleInbound({ id: `wamid.${randomUUID()}`, from: waId, type: 'interactive', interactive: { button_reply: { id, title: '' } } }, name);
}
async function customer(waId: string): Promise<string> {
  const r = await q<{ id: string }>(`INSERT INTO identity.users (phone, role, terms_accepted_at) VALUES ($1,'CUSTOMER',now()) RETURNING id`, [`+${waId}`]);
  return String(r[0].id);
}
const sessionData = async (waId: string) => {
  const r = await q<{ data: unknown }>(`SELECT data FROM messaging.whatsapp_session WHERE wa_id=$1`, [waId]);
  const d = r[0]?.data;
  return (typeof d === 'string' ? JSON.parse(d) : d ?? {}) as Record<string, unknown>;
};

describe('WhatsApp vendor sign-up link', () => {
  for (const text of ['How can I join as a vendor?', 'I wan join as plumber', 'I dey sell inverter battery', 'how I fit register as vendor']) {
    it(`"${text}" gets the Join as a provider button`, async () => {
      const wa = newNumber();
      await customer(wa);
      await say(wa, text);
      const sent = joinCtas(wa);
      assert.equal(sent.length, 1, (await replies(wa)).join(' | '));
      assert.equal(sent[0].url, SIGNUP);
      assert.match(sent[0].body, /book services here any time/);
      assert.ok(sent[0].body.length < 250, 'short message');
      assert.doesNotMatch(sent[0].body, /vendor_join|intent|_/, 'no internal labels');
    });
  }

  it('the setting is read in one place, with the public page as the default', async () => {
    const { vendorSignupUrl } = await import('../modules/whatsapp/links.js');
    assert.equal(vendorSignupUrl(), SIGNUP);
    const saved = process.env.VENDOR_SIGNUP_URL;
    delete process.env.VENDOR_SIGNUP_URL;
    try { assert.equal(vendorSignupUrl(), 'https://kendibo.ng/#join-provider'); } finally { process.env.VENDOR_SIGNUP_URL = saved; }
  });

  it('mid-draft: sends the button and keeps the booking draft as it was', async () => {
    const wa = newNumber();
    await customer(wa);
    await say(wa, '/ac');
    const before = await q<{ id: string; category_id: string; status: string }>(`SELECT id, category_id, status FROM messaging.whatsapp_job_draft WHERE wa_id=$1 AND status='collecting'`, [wa]);
    assert.equal(before[0]?.category_id, 'ac');
    await say(wa, 'I am a plumber, how do I register as a provider?');
    const sent = joinCtas(wa);
    assert.equal(sent.length, 1);
    assert.match(sent[0].body, /booking in progress is saved/);
    const after = await q<{ id: string; category_id: string; status: string }>(`SELECT id, category_id, status FROM messaging.whatsapp_job_draft WHERE wa_id=$1 AND status='collecting'`, [wa]);
    assert.equal(after.length, 1, 'draft still open');
    assert.equal(after[0].id, before[0].id);
    assert.equal(after[0].category_id, 'ac');
    // The booking carries on afterwards.
    await say(wa, 'my AC is leaking water');
    const d = await q<{ need: string | null }>(`SELECT need FROM messaging.whatsapp_job_draft WHERE id=$1`, [after[0].id]);
    assert.ok(d[0].need, 'the next message still fills the draft');
    assert.equal(joinCtas(wa).length, 1);
  });

  it('sends the button at most once per 10 minutes unless they ask for the link again', async () => {
    const wa = newNumber();
    await customer(wa);
    await say(wa, 'I want to offer my services on Kendibo');
    await say(wa, 'I wan join as electrician');
    assert.equal(joinCtas(wa).length, 1, 'no second button inside 10 minutes');
    assert.match(await last(wa), /in my message above/);
    await say(wa, 'please send the link again');
    assert.equal(joinCtas(wa).length, 2, 'an explicit ask gets it again');
    // Ten minutes later the button goes out again.
    const data = await sessionData(wa);
    await q(`UPDATE messaging.whatsapp_session SET data=$2 WHERE wa_id=$1`, [wa, JSON.stringify({ ...data, vendorCtaAt: Date.now() - 11 * 60_000 })]);
    await say(wa, 'how I fit register as vendor');
    assert.equal(joinCtas(wa).length, 3);
  });

  it('the AI agent prompt points to the sign-up link and never collects business details', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync('modules/whatsapp/agent.ts', 'utf8'));
    assert.match(src, /\$\{vendorSignupUrl\(\)\}/);
    assert.match(src, /Never collect their business details/);
  });
});

describe('WhatsApp post-onboarding question', () => {
  async function onboard(wa: string, first: string) {
    await say(wa, first, 'Chidi Okafor');
    await tap(wa, 'consent:agree', 'Chidi Okafor');
    await tap(wa, 'onb:name:yes', 'Chidi Okafor');
    await tap(wa, 'onb:email:skip', 'Chidi Okafor');
  }
  const ROLE_Q = /Are you here to book a service, or to offer your services on Kendibo\?/;

  it('asks once; "Offer my services" sends the sign-up button', async () => {
    process.env.WHATSAPP_CONSENT_GATE = 'on';
    try {
      const wa = newNumber();
      await onboard(wa, 'hi');
      const q1 = await last(wa);
      assert.match(q1, ROLE_Q);
      assert.match(q1, /\[Book a service \| Offer my services\]/);
      assert.match(q1, /type \/ any time/, 'the "/" tip rides along once');
      assert.equal((await sessionData(wa)).roleAsked, true);
      await tap(wa, 'role:offer', 'Chidi Okafor');
      const sent = joinCtas(wa);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].url, SIGNUP);
      await say(wa, 'hello', 'Chidi Okafor');
      assert.equal((await replies(wa)).filter((t) => ROLE_Q.test(t)).length, 1, 'asked only once');
      assert.equal((await replies(wa)).filter((t) => /type \/ any time/.test(t)).length, 1, 'one tip');
    } finally {
      process.env.WHATSAPP_CONSENT_GATE = 'off';
    }
  });

  it('"Book a service" carries on with the booking as before', async () => {
    process.env.WHATSAPP_CONSENT_GATE = 'on';
    try {
      const wa = newNumber();
      await onboard(wa, 'hi');
      assert.match(await last(wa), ROLE_Q);
      await tap(wa, 'menu:book', 'Chidi Okafor');
      const d = await q(`SELECT 1 FROM messaging.whatsapp_job_draft WHERE wa_id=$1 AND status='collecting'`, [wa]);
      assert.equal(d.length, 1, 'a booking draft started');
      assert.equal(joinCtas(wa).length, 0);
      assert.doesNotMatch(await last(wa), ROLE_Q);
    } finally {
      process.env.WHATSAPP_CONSENT_GATE = 'off';
    }
  });

  it('skips the question when the first message already said which', async () => {
    process.env.WHATSAPP_CONSENT_GATE = 'on';
    try {
      const booker = newNumber();
      await onboard(booker, 'I need a plumber, my sink is leaking');
      assert.equal((await replies(booker)).filter((t) => ROLE_Q.test(t)).length, 0);
      assert.ok((await q(`SELECT 1 FROM messaging.whatsapp_job_draft WHERE wa_id=$1`, [booker])).length, 'their job draft started');

      const pro = newNumber();
      await onboard(pro, 'I wan join as plumber');
      assert.equal((await replies(pro)).filter((t) => ROLE_Q.test(t)).length, 0);
      assert.equal(joinCtas(pro).length, 1, 'their first message is answered with the sign-up button');
    } finally {
      process.env.WHATSAPP_CONSENT_GATE = 'off';
    }
  });

  it('a would-be provider mid-onboarding gets the button and the step is kept', async () => {
    process.env.WHATSAPP_CONSENT_GATE = 'on';
    try {
      const wa = newNumber();
      await say(wa, 'hi', 'Chidi Okafor');
      await tap(wa, 'consent:agree', 'Chidi Okafor');
      await tap(wa, 'onb:name:yes', 'Chidi Okafor');
      assert.match(await last(wa), /What's your email/);
      await say(wa, 'I want to register as a vendor', 'Chidi Okafor');
      assert.equal(joinCtas(wa).length, 1);
      assert.equal((await sessionData(wa)).onboard, 'email', 'still on the email step');
    } finally {
      process.env.WHATSAPP_CONSENT_GATE = 'off';
    }
  });
});
