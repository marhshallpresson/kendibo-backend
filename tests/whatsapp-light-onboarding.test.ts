// Light WhatsApp onboarding (the default): no agree-first wall, a "Check prices"
// path, terms linked on kendibo.ng, and a review page before checkout.
// WhatsApp sends are stubbed and recorded here, so nothing leaves the machine.
import 'dotenv/config';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.NODE_ENV = 'test';
delete process.env.WHATSAPP_ONBOARDING; // default = light
let app: { inject: (opts: any) => Promise<any>; close?: () => Promise<void> };
const sent: { kind: string; args: unknown[] }[] = [];
let handle: (m: unknown, profileName?: string) => Promise<void>;

before(async () => {
  process.env.DATABASE_URL = '';
  process.env.SITE_URL = 'https://kendibo.ng';
  ({ app } = (await import('../apps/api/src/main.js')) as never);
  delete process.env.DATABASE_URL;
  const { wa } = await import('../modules/whatsapp/whatsapp.client.js');
  const w = wa as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  for (const k of Object.keys(w)) {
    if (typeof w[k] !== 'function' || k.startsWith('fetch') || k.startsWith('download')) continue;
    w[k] = async (...a: unknown[]) => { sent.push({ kind: k, args: a.slice(1) }); return { id: 'stub' }; };
  }
  const bot = await import('../modules/whatsapp/whatsapp.bot.js');
  handle = (bot as unknown as { handleInbound: typeof handle }).handleInbound;
});
after(async () => { await app?.close?.().catch(() => {}); });

const num = () => `23481${Math.floor(1e7 + Math.random() * 8e7)}`;
const text = (from: string, body: string) => ({ from, id: `wamid.${randomUUID()}`, type: 'text', text: { body }, profileName: 'Ada' });
const tap = (from: string, id: string) => ({ from, id: `wamid.${randomUUID()}`, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: id } }, profileName: 'Ada' });
const all = () => JSON.stringify(sent);

describe('WhatsApp light onboarding', () => {
  it('first hello gets the welcome with Check prices and the kendibo.ng terms, no consent wall', async () => {
    const from = num();
    sent.length = 0;
    await handle(text(from, 'hello'), 'Ada');
    const out = all();
    assert.match(out, /menu:prices/, out.slice(0, 400));
    assert.match(out, /menu:book/);
    assert.match(out, /https:\/\/kendibo\.ng\/terms/);
    assert.doesNotMatch(out, /consent:agree/);
    assert.doesNotMatch(out, /api\.kendibo\.ng\/w\/terms/);
  });

  it('Check prices answers one question and offers to book it', async () => {
    const from = num();
    await handle(text(from, 'hi'), 'Ada');
    sent.length = 0;
    await handle(tap(from, 'menu:prices'), 'Ada');
    assert.match(all(), /Which job do you want prices for/);
    sent.length = 0;
    await handle(text(from, 'how much for plumbing'), 'Ada');
    const out = all();
    assert.match(out, /cat:/, out.slice(0, 600));
    assert.match(out, /Book this/);
  });

  it('does not ask for a name or an email before helping', async () => {
    const from = num();
    sent.length = 0;
    await handle(text(from, 'hello'), 'Ada');
    await handle(tap(from, 'menu:book'), 'Ada');
    const out = all();
    assert.doesNotMatch(out, /onb:name/);
    assert.doesNotMatch(out, /your email/i);
  });
});

describe('WhatsApp web pages', () => {
  it('/w/terms redirects to the main website', async () => {
    const r = await app.inject({ method: 'GET', url: '/w/terms' });
    assert.equal(r.statusCode, 302);
    assert.equal(r.headers.location, 'https://kendibo.ng/terms');
  });

  it('/w/pay rejects a bad token and explains a booking it cannot pay', async () => {
    const bad = await app.inject({ method: 'GET', url: '/w/pay?t=nope' });
    assert.doesNotMatch(String(bad.body), /Confirm &amp; pay|Confirm & pay/);
    const { signLink } = await import('../modules/whatsapp/links.js');
    const t = signLink({ w: num(), d: randomUUID(), p: 'pay' });
    const r = await app.inject({ method: 'GET', url: `/w/pay?t=${encodeURIComponent(t)}` });
    assert.equal(r.statusCode, 200);
    assert.doesNotMatch(String(r.body), /id="f"/);
    // Confirming without a token never reaches checkout.
    const post = await app.inject({ method: 'POST', url: '/w/pay', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 't=nope' });
    assert.notEqual(post.statusCode, 303);
  });

  it('the confirm page shows the booking and posts to /w/pay', async () => {
    const { renderPayConfirmPage } = await import('../modules/whatsapp/web-pages.js');
    const page = renderPayConfirmPage({
      token: 'tok<x>', nonce: 'n1', termsUrl: 'https://kendibo.ng/terms',
      preview: { service: 'AC service', pro: 'Ada Cool Ltd', when: 'Mon 17 Nov, 10:00', address: '12 Allen Ave, Ikeja', amount: '₦25,000', protectedNote: 'held until done' },
    });
    assert.match(page, /action="\/w\/pay"/);
    assert.match(page, /AC service/);
    assert.match(page, /Ada Cool Ltd/);
    assert.match(page, /₦25,000/);
    assert.match(page, /https:\/\/kendibo\.ng\/terms/);
    assert.doesNotMatch(page, /tok<x>/, 'token is escaped');
  });
});
