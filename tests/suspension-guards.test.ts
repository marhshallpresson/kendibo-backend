// Suspension guards: a suspended customer on WhatsApp gets one notice and no
// booking flow; a locked or suspended admin cannot sign in through Google.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { q } from '../packages/database/db.js';

process.env.NODE_ENV = 'test';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: { inject: (opts: any) => Promise<any>; close?: () => Promise<void> };
let handleInbound: (m: { id: string; from: string; type: string; text: { body: string } }) => Promise<void>;
before(async () => {
  process.env.DATABASE_URL = '';
  process.env.REDIS_URL = '';
  ({ app } = await import('../apps/api/src/main.js'));
  ({ handleInbound } = await import('../modules/whatsapp/whatsapp.bot.js'));
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
});
after(async () => { await app?.close?.().catch(() => {}); });

const UA = 'suspension-guards-test/1.0';
const NOTICE = 'Your Kendibo account is on hold. If you think this is a mistake, email support@kendibo.ng.';

// ── WhatsApp ────────────────────────────────────────────────────────────────
const assistantTurns = async (waId: string) =>
  (await q<{ content: string }>(`SELECT content FROM messaging.whatsapp_turn WHERE wa_id=$1 AND role='assistant'`, [waId])).map((r) => String(r.content));

describe('suspended WhatsApp customer', () => {
  it('gets the notice once, then silence, and never enters the booking flow', async () => {
    const waId = `23480${Math.floor(1e7 + Math.random() * 8e7)}`;
    await q(`INSERT INTO identity.users (phone, role, name, status, suspended_at) VALUES ($1,'CUSTOMER','Suspended Sam','suspended',now())`, [`+${waId}`]);

    await handleInbound({ id: `wamid.${randomUUID()}`, from: waId, type: 'text', text: { body: 'I need a plumber in Uyo' } });
    await handleInbound({ id: `wamid.${randomUUID()}`, from: waId, type: 'text', text: { body: 'hello?' } });
    await handleInbound({ id: `wamid.${randomUUID()}`, from: waId, type: 'text', text: { body: 'RECOVER my account' } });

    const replies = await assistantTurns(waId);
    assert.equal(replies.filter((t) => t === NOTICE).length, 1, `notice sent once, got: ${JSON.stringify(replies)}`);
    assert.equal(replies.length, 1, 'nothing else is sent to a suspended customer');

    const drafts = await q(`SELECT 1 FROM messaging.whatsapp_job_draft WHERE wa_id=$1`, [waId]).catch(() => []);
    assert.equal(drafts.length, 0, 'no booking draft is opened');
    const bookings = await q(`SELECT b.id FROM booking.booking b JOIN identity.users u ON u.id=b.user_id WHERE u.phone=$1`, [`+${waId}`]);
    assert.equal(bookings.length, 0);
  });
});

// ── Admin Google sign-in ────────────────────────────────────────────────────
const fakeIdToken = `eyJhbGciOiJSUzI1NiJ9.${'p'.repeat(40)}.sig`;
function mockGoogle(email: string, sub: string) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).startsWith('https://oauth2.googleapis.com/tokeninfo')) {
      return new Response(JSON.stringify({ sub, email, email_verified: 'true', exp: String(Math.floor(Date.now() / 1000) + 3600) }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}
async function admin(status = 'active') {
  const email = `admin-${randomUUID()}@kendibo.local`;
  const sub = `g-${randomUUID()}`;
  const id = String((await q<{ id: string }>(`INSERT INTO identity.users (email, role, name, status) VALUES ($1,'SUPER_ADMIN','Ada Admin',$2) RETURNING id`, [email, status]))[0].id);
  return { id, email, sub };
}
const googleLogin = (idToken = fakeIdToken) =>
  app.inject({ method: 'POST', url: '/v1/auth/google', headers: { 'user-agent': UA }, payload: { idToken } });

describe('admin Google sign-in guards', () => {
  it('refuses a locked admin with 429 and Retry-After, like password sign-in', async () => {
    await q(`DELETE FROM identity.admin_login_lock`);
    const a = await admin();
    const restore = mockGoogle(a.email, a.sub);
    try {
      await q(`INSERT INTO identity.admin_login_lock (key, failures, window_started_at, locked_until) VALUES ($1,5,now(),$2)`,
        [`acct:${a.id}`, new Date(Date.now() + 15 * 60_000).toISOString()]);
      const r = await googleLogin();
      assert.equal(r.statusCode, 429);
      assert.equal(r.json().error.code, 'ADMIN_LOGIN_LOCKED');
      assert.ok(Number(r.headers['retry-after']) > 800, `retry-after ${r.headers['retry-after']}`);
      assert.equal(r.json().data, undefined, 'no session issued while locked');
    } finally { restore(); }
  });

  it('refuses a suspended admin with ACCOUNT_SUSPENDED', async () => {
    await q(`DELETE FROM identity.admin_login_lock`);
    const a = await admin('suspended');
    const restore = mockGoogle(a.email, a.sub);
    try {
      const r = await googleLogin();
      assert.equal(r.statusCode, 403);
      assert.equal(r.json().error.code, 'ACCOUNT_SUSPENDED');
      assert.equal(r.json().data, undefined);
    } finally { restore(); }
  });

  it('still signs in an unlocked, active admin', async () => {
    await q(`DELETE FROM identity.admin_login_lock`);
    const a = await admin();
    const restore = mockGoogle(a.email, a.sub);
    try {
      const r = await googleLogin();
      assert.equal(r.statusCode, 200, r.body);
      assert.ok(r.json().data?.access);
    } finally { restore(); }
  });
});

