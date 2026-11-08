// Admin email alerts (DB recipients), lifecycle/marketing email, consent,
// one-click unsubscribe and the idempotent send log. Mail is captured by
// replacing the email port — nothing leaves the machine.
import 'dotenv/config';
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { q } from '../packages/database/db.js';
import { issueOtp, signAccess } from '../packages/auth/auth.js';
import { email } from '../modules/notifications/channels.js';
import { emit } from '../packages/observability/emit.js';

process.env.NODE_ENV = 'test';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: { inject: (opts: any) => Promise<any>; close?: () => Promise<void> };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let M: any; let L: any; let identityService: any; let providerService: any; let requestService: any;

type Sent = { to: string; subject: string; html: string; opts?: { text?: string; headers?: Record<string, string> } };
const sent: Sent[] = [];
const originalSend = email.send.bind(email);

before(async () => {
  process.env.DATABASE_URL = '';
  process.env.REDIS_URL = '';
  ({ app } = await import('../apps/api/src/main.js'));
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
  M = await import('../modules/notifications/admin-alerts.service.js');
  L = await import('../modules/notifications/lifecycle.service.js');
  ({ identityService } = await import('../modules/identity/identity.service.js'));
  ({ providerService } = await import('../modules/providers/provider.service.js'));
  ({ requestService } = await import('../modules/requests/request.service.js'));
  (email as { send: unknown }).send = async (to: string, subject: string, html: string, opts?: Sent['opts']) => {
    sent.push({ to, subject, html, opts });
    return { id: `test_${sent.length}`, provider: 'test' };
  };
});
after(async () => {
  (email as { send: unknown }).send = originalSend;
  await app?.close?.().catch(() => {});
});
beforeEach(() => { sent.length = 0; });

const auth = (sub: string) => ({ authorization: `Bearer ${signAccess(sub, [])}` });
const phone = () => `0803${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
async function user(role = 'CUSTOMER', extra: { email?: string; name?: string } = {}) {
  return String((await q<{ id: string }>(`INSERT INTO identity.users (email, role, name) VALUES ($1,$2,$3) RETURNING id`,
    [extra.email ?? `${role.toLowerCase()}-${randomUUID()}@kendibo.local`, role, extra.name ?? 'Ada Okon']))[0].id);
}
const alerts = (needle: string) => sent.filter((m) => m.subject.startsWith('[Kendibo alert]') && m.subject.includes(needle));

describe('admin alert recipients live in the database', () => {
  it('migration 042 seeds both admin addresses; admins can change them, customers cannot', async () => {
    const row = await q<{ value: unknown }>(`SELECT value FROM configuration.platform_setting WHERE key='admin.alert_emails'`);
    assert.ok(row[0], 'setting row seeded');
    assert.deepEqual(await M.getAlertEmails(), ['admin@kendibo.ng', 'alerts@kendibo.ng']);

    const customer = await user('CUSTOMER');
    assert.equal((await app.inject({ method: 'GET', url: '/v1/admin/settings/alert-emails', headers: auth(customer) })).statusCode, 403);

    const admin = await user('SUPER_ADMIN');
    const got = await app.inject({ method: 'GET', url: '/v1/admin/settings/alert-emails', headers: auth(admin) });
    assert.equal(got.statusCode, 200);
    assert.deepEqual(got.json().data.emails, ['admin@kendibo.ng', 'alerts@kendibo.ng']);

    const bad = await app.inject({ method: 'PUT', url: '/v1/admin/settings/alert-emails', headers: auth(admin), payload: { emails: ['not-an-email'] } });
    assert.equal(bad.statusCode, 400);

    const put = await app.inject({ method: 'PUT', url: '/v1/admin/settings/alert-emails', headers: auth(admin), payload: { emails: ['ops@kendibo.ng'] } });
    assert.equal(put.statusCode, 200);
    emit('provider.kyb_submitted', { providerId: randomUUID(), hasRcNumber: true });
    await M.flushAdminAlerts();
    assert.deepEqual(alerts('Business KYB').map((m) => m.to), ['ops@kendibo.ng'], 'new recipients read from DB');

    await app.inject({ method: 'PUT', url: '/v1/admin/settings/alert-emails', headers: auth(admin), payload: { emails: ['admin@kendibo.ng', 'alerts@kendibo.ng'] } });
  });
});

describe('admin alerts', () => {
  it('a new customer sign-up (phone OTP) alerts both admin addresses without blocking sign-in', async () => {
    const raw = phone();
    const norm = identityService.normalizeIdentity(raw).value;
    const { code } = await issueOtp('phone', norm);
    const res = await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { channel: 'phone', identity: raw, code, name: 'Emem Udo' } });
    assert.equal(res.statusCode, 200);
    await M.flushAdminAlerts();
    const a = alerts('customer sign-up via phone_otp');
    assert.deepEqual(a.map((m) => m.to).sort(), ['admin@kendibo.ng', 'alerts@kendibo.ng']);
    assert.match(a[0].html, /Emem Udo/);
    assert.ok(!a[0].html.includes(norm), 'phone is masked');
    assert.ok(a[0].opts?.text?.includes('Channel: phone_otp'), 'plain-text alternative');
  });

  it('a failing mailer never breaks the request that triggered the alert', async () => {
    const keep = email.send;
    (email as { send: unknown }).send = async () => { throw new Error('SMTP down'); };
    try {
      const raw = phone();
      const { code } = await issueOtp('phone', identityService.normalizeIdentity(raw).value);
      const res = await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { channel: 'phone', identity: raw, code } });
      assert.equal(res.statusCode, 200);
      await M.flushAdminAlerts();
    } finally { (email as { send: unknown }).send = keep; }
  });

  it('provider onboarding steps alert once each (profile started, first time online)', async () => {
    const uid = await user('PROVIDER', { name: 'Bassey Cleaners' });
    const p = await providerService.onboard(uid);
    await M.flushAdminAlerts();
    assert.equal(alerts('New provider/vendor profile started').length, 2);

    sent.length = 0;
    await providerService.setOnline(p.id, true);
    await providerService.setOnline(p.id, false);
    await providerService.setOnline(p.id, true);
    await M.flushAdminAlerts();
    const online = alerts('First time online');
    assert.equal(online.length, 2, 'one email per recipient, only the first time');
    assert.match(online[0].html, /Bassey Cleaners/);
  });

  it('unserved demand alerts with category, area, masked phone and ask — once per request', async () => {
    const uid = await user('CUSTOMER', { name: 'Imaobong Etim' });
    const r = await requestService.create(uid, {
      title: 'Fix leaking kitchen sink', details: 'Water under the cabinet', categoryId: 'plumbing',
      lat: 4.0, lng: 3.0, contactName: 'Imaobong Etim', contactPhone: '+2348031234567', idempotencyKey: randomUUID(),
    });
    await M.flushAdminAlerts();
    emit('request.unserved', { requestId: r.id, reason: 'NO_PROVIDER_IN_RANGE' }); // replay
    await M.flushAdminAlerts();
    const a = alerts('Unserved request');
    assert.equal(a.length, 2, 'de-duplicated: one email per recipient');
    assert.match(a[0].html, /Fix leaking kitchen sink/);
    assert.match(a[0].html, /Imaobong Etim/);
    assert.match(a[0].html, /\+2348031\*\*\*567/);
    assert.ok(!a[0].html.includes('+2348031234567'));
    assert.match(a[0].html, /No available, verified provider in range/);
  });
});

describe('marketing email, consent and unsubscribe', () => {
  it('is skipped without consent, sent with consent (unsubscribe link + headers), and capped weekly', async () => {
    const uid = await user('CUSTOMER', { name: 'Uduak' });
    const none = await L.sendMarketing(uid, `c-${randomUUID()}`, 'New: deep cleaning', ['Book a deep clean this week.']);
    assert.deepEqual(none, { sent: false, reason: 'NO_CONSENT' });
    assert.equal(sent.length, 0);

    const prefs = await app.inject({ method: 'PUT', url: '/v1/me/email-preferences', headers: auth(uid), payload: { marketing: true, source: 'app_settings' } });
    assert.equal(prefs.statusCode, 200);
    assert.equal(prefs.json().data.marketing, true);
    assert.equal(prefs.json().data.consentSource, 'app_settings');

    const ok = await L.sendMarketing(uid, `c-${randomUUID()}`, 'New: deep cleaning', ['Book a deep clean this week.']);
    assert.deepEqual(ok, { sent: true });
    const m = sent[0];
    assert.match(m.html, /\/v1\/email\/unsubscribe\?u=/);
    assert.match(m.html, /Email preferences/);
    assert.match(m.html, /Uyo, Akwa Ibom/);
    assert.match(m.opts!.headers!['List-Unsubscribe'], /^<https?:\/\/.+\/v1\/email\/unsubscribe\?u=/);
    assert.equal(m.opts!.headers!['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    assert.match(m.opts!.text!, /Unsubscribe: /);

    const capped = await L.sendMarketing(uid, `c-${randomUUID()}`, 'Another promo', ['x']);
    assert.deepEqual(capped, { sent: false, reason: 'WEEKLY_CAP' });
  });

  it('the signed unsubscribe link works (GET page and one-click POST); a forged one does not', async () => {
    const uid = await user('CUSTOMER');
    await L.setMarketingConsent(uid, true, 'app_signup');
    await L.sendMarketing(uid, `c-${randomUUID()}`, 'Hello', ['Hi']);
    const header = sent[0].opts!.headers!['List-Unsubscribe'];
    const url = new URL(header.slice(1, header.indexOf('>')));

    const forged = await app.inject({ method: 'GET', url: `/v1/email/unsubscribe?u=${uid}&t=${'x'.repeat(43)}` });
    assert.equal(forged.statusCode, 400);
    assert.equal((await L.emailPreferences(uid)).marketing, true);

    const res = await app.inject({ method: 'GET', url: `${url.pathname}${url.search}` });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /unsubscribed/i);
    const after = await L.emailPreferences(uid);
    assert.equal(after.marketing, false);
    assert.ok(after.unsubscribedAt);

    const post = await app.inject({ method: 'POST', url: `${url.pathname}${url.search}`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'List-Unsubscribe=One-Click' });
    assert.equal(post.statusCode, 200);

    const blocked = await L.sendMarketing(uid, `c-${randomUUID()}`, 'Promo', ['x']);
    assert.equal(blocked.sent, false);
    assert.equal((await L.send('customer_welcome_d2', uid, 'once')).reason, 'UNSUBSCRIBED', 'tips stop too');
    assert.equal((await L.send('provider_approved', uid, 'once')).sent, true, 'transactional still delivered');
  });
});

describe('lifecycle sweeper', () => {
  it('sends the day-2 welcome once; the send log prevents duplicates across sweeps', async () => {
    const uid = await user('CUSTOMER', { name: 'Nsikak' });
    await q(`UPDATE identity.users SET created_at=$2 WHERE id=$1`, [uid, new Date(Date.now() - 3 * 86_400_000).toISOString()]);
    await L.lifecycleSweep();
    await L.lifecycleSweep();
    const mine = sent.filter((m) => m.subject === 'How booking on Kendibo works' && m.html.includes('Nsikak'));
    assert.equal(mine.length, 1);
    assert.match(mine[0].html, /Unsubscribe/);
    // Owner rule: no internal labels (template keys, series/day numbers, campaign tags) in visible content.
    for (const m of sent.filter((x) => !x.subject.startsWith('[Kendibo alert]'))) {
      const visible = `${m.subject}\n${m.html.replace(/<[^>]+>/g, ' ')}\n${m.opts?.text ?? ''}`;
      assert.ok(!/(customer|provider)_[a-z0-9_]+|campaign:|\bday \d+\b|\bmail \d+ of \d+\b|\b\d+ of \d+\b/i.test(visible), `internal label leaked: ${m.subject}`);
    }
    const log = await q(`SELECT 1 FROM notification.email_send_log WHERE user_id=$1 AND template='customer_welcome_d2'`, [uid]);
    assert.equal(log.length, 1);
  });

  it('retention emails are marketing: no consent means no win-back', async () => {
    const quiet = await user('CUSTOMER', { name: 'Quiet' });
    const keen = await user('CUSTOMER', { name: 'Keen' });
    const old = new Date(Date.now() - 70 * 86_400_000).toISOString();
    await q(`UPDATE identity.users SET created_at=$2 WHERE id=$1`, [quiet, old]);
    await q(`UPDATE identity.users SET created_at=$2 WHERE id=$1`, [keen, old]);
    await L.setMarketingConsent(keen, true, 'web');
    await L.lifecycleSweep();
    const winback = sent.filter((m) => m.subject === 'We miss you at Kendibo');
    assert.ok(winback.some((m) => m.html.includes('Keen')));
    assert.ok(!winback.some((m) => m.html.includes('Quiet')));
  });
});
