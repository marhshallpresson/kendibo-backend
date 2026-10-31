import 'dotenv/config';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { signAccess } from '../packages/auth/auth.js';
import { q } from '../packages/database/db.js';
import { normalizeNigerianPhone, detectNigerianCarrier } from '../modules/notifications/sling.client.js';

let app: {
  inject: (opts: unknown) => Promise<{ statusCode: number; json: () => { data?: any; error?: any } }>;
  close?: () => Promise<void>;
};

before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = '';
  process.env.REDIS_URL = '';
  ({ app } = await import('../apps/api/src/main.js'));
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
  // Campaigns, comms sends and Sling lookups are ops actions (configuration:edit).
  const rows = await q<{ id: string }>(
    `INSERT INTO identity.users (name, email, role) VALUES ('Ops Admin', $1, 'SUPER_ADMIN') RETURNING id`,
    [`ops-${randomUUID()}@kendibo.local`],
  );
  adminId = String(rows[0].id);
});

let adminId = '';
const adminHeaders = () => ({ authorization: `Bearer ${signAccess(adminId, [])}` });

after(async () => {
  await app?.close?.().catch(() => {});
});

const auth = (sub: string) => ({ authorization: `Bearer ${signAccess(sub, [])}` });

async function createCustomer(name: string, phone: string) {
  const email = `cust-${randomUUID()}@kendibo.local`;
  const rows = await q<{ id: string }>(
    `INSERT INTO identity.users (name, phone, email, role) VALUES ($1,$2,$3,'CUSTOMER') RETURNING id`,
    [name, phone, email],
  );
  return String(rows[0].id);
}

describe('Sling Omnichannel, AI-Assisted CTA Retainers & Bulk Campaigns', () => {
  it('rejects comms and campaign routes without an admin seat', async () => {
    const anon = await app.inject({ method: 'GET', url: '/v1/admin/campaigns' });
    assert.equal(anon.statusCode, 401);
    const customer = await createCustomer('Ada Okon', '+2348030000001');
    const asCustomer = await app.inject({
      method: 'POST',
      url: '/v1/communications/send',
      headers: auth(customer),
      payload: { recipientId: customer, channels: ['sms'] },
    });
    assert.equal(asCustomer.statusCode, 403);
  });

  it('normalizes Nigerian MSISDN and detects carrier & RCS capability', async () => {
    assert.equal(normalizeNigerianPhone('08031234567'), '+2348031234567');
    assert.equal(detectNigerianCarrier('08031234567'), 'MTN Nigeria');
    assert.equal(detectNigerianCarrier('08021234567'), 'Airtel Nigeria');
    assert.equal(detectNigerianCarrier('08051234567'), 'Globacom (Glo)');
    assert.equal(detectNigerianCarrier('08091234567'), '9mobile');

    const hlr = await app.inject({
      method: 'POST',
      url: '/v1/communications/lookup/phone',
      headers: adminHeaders(),
      payload: { phone: '08031234567' },
    });
    assert.equal(hlr.statusCode, 200);
    assert.equal(hlr.json().data.number, '+2348031234567');
    assert.equal(hlr.json().data.network, 'MTN Nigeria');

    const rcs = await app.inject({
      method: 'POST',
      url: '/v1/communications/lookup/rcs',
      headers: adminHeaders(),
      payload: { phone: '08031234567' },
    });
    assert.equal(rcs.statusCode, 200);
    assert.equal(rcs.json().data.rcs_enabled, true);
  });

  it('generates AI-assisted CTA copy, WhatsApp template, Push payload & RCS rich card', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/communications/ai-cta/generate',
      headers: adminHeaders(),
      payload: {
        goal: 'retainer_maintenance',
        customerName: 'Adaeze Okafor',
        city: 'Lagos',
        serviceName: 'AC Servicing & Deep Cleaning',
        discountPct: 15,
      },
    });
    assert.equal(res.statusCode, 200);
    const data = res.json().data;
    assert.ok(data.ctaLabel.length > 0);
    assert.ok(data.smsBody.length <= 160);
    assert.ok(data.whatsappBody.includes('Adaeze'));
    assert.ok(data.rcsCard.title.length > 0);
    assert.ok(Array.isArray(data.rcsSuggestions) && data.rcsSuggestions.length >= 2);
  });

  it('manages user notification preferences and gates omnichannel dispatch', async () => {
    const userId = await createCustomer('Tunde Bakare', '+2348039998877');

    const getPrefs = await app.inject({
      method: 'GET',
      url: '/v1/me/notification-preferences',
      headers: auth(userId),
    });
    assert.equal(getPrefs.statusCode, 200);
    assert.equal(getPrefs.json().data.wa, true);

    const putPrefs = await app.inject({
      method: 'PUT',
      url: '/v1/me/notification-preferences',
      headers: auth(userId),
      payload: { sms: false, wa: true, push: true, promo: false },
    });
    assert.equal(putPrefs.statusCode, 200);
    assert.equal(putPrefs.json().data.sms, false);
    assert.equal(putPrefs.json().data.promo, false);

    // Transactional order alert respects sms=false while delivering whatsapp + push
    const sendRes = await app.inject({
      method: 'POST',
      url: '/v1/communications/send',
      headers: adminHeaders(),
      payload: {
        recipientId: userId,
        channels: ['whatsapp', 'sms', 'push'],
        template: 'booking.confirmed',
        category: 'order',
        vars: { id: 'bk_101', service: 'Deep Cleaning', slot: 'Tomorrow 10:00 AM' },
      },
    });
    assert.equal(sendRes.statusCode, 200);
    const dispatched = sendRes.json().data;
    assert.equal(dispatched.results.length, 2);
    assert.deepEqual(dispatched.skippedChannels, ['sms']);

    // Inbox contains the sent notifications
    const inbox = await app.inject({
      method: 'GET',
      url: '/v1/me/notifications',
      headers: auth(userId),
    });
    assert.equal(inbox.statusCode, 200);
    assert.ok(inbox.json().data.length >= 2);
  });

  it('creates, lists, triggers, and pauses AI-assisted customer retainers', async () => {
    const userId = await createCustomer('Chidinma Nwosu', '+2348025554433');

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/me/retainers',
      headers: auth(userId),
      payload: {
        serviceId: 'ac_maintenance',
        serviceName: 'Quarterly AC & Inverter Tune-Up',
        cadence: 'monthly',
        channels: ['whatsapp', 'push', 'rcs'],
        aiAssisted: true,
      },
    });
    assert.equal(createRes.statusCode, 200);
    const retainer = createRes.json().data;
    assert.equal(retainer.status, 'active');
    assert.ok(retainer.lastCtaLabel);

    const triggerRes = await app.inject({
      method: 'POST',
      url: `/v1/me/retainers/${retainer.id}/trigger-ai`,
      headers: auth(userId),
    });
    assert.equal(triggerRes.statusCode, 200);
    assert.equal(triggerRes.json().data.retainer.runCount, 1);
    assert.ok(triggerRes.json().data.dispatched.length >= 2);

    const pauseRes = await app.inject({
      method: 'PATCH',
      url: `/v1/me/retainers/${retainer.id}`,
      headers: auth(userId),
      payload: { status: 'paused' },
    });
    assert.equal(pauseRes.statusCode, 200);
    assert.equal(pauseRes.json().data.status, 'paused');
  });

  it('launches AI-assisted bulk promotional & communications alert campaigns and ingests Sling webhooks', async () => {
    const cmpRes = await app.inject({
      method: 'POST',
      url: '/v1/admin/campaigns',
      headers: adminHeaders(),
      payload: {
        name: 'Lagos Rainy Season Plumbing & AC Check',
        kind: 'bulk_promotional',
        channels: ['sms', 'whatsapp', 'rcs', 'push'],
        targetSegment: 'all_customers',
        aiAssisted: true,
        aiGoal: 'seasonal_promo',
        discountPct: 20,
        autoLaunch: true,
      },
    });
    assert.equal(cmpRes.statusCode, 200);
    const cmp = cmpRes.json().data.campaign;
    assert.equal(cmp.status, 'completed');
    assert.ok(cmp.stats.sent >= 1);

    // Trigger operational automation event and reconcile delivery via /webhooks/sling
    const userId = await createCustomer('Ibrahim Musa', '+2348051112233');
    const autoRes = await app.inject({
      method: 'POST',
      url: '/v1/communications/automation/trigger',
      headers: adminHeaders(),
      payload: {
        triggerEvent: 'quote.ready',
        recipientId: userId,
        vars: { name: 'Ibrahim Musa', jobId: 'job_900', amount: '25,000', service: 'Electrical Inspection' },
      },
    });
    assert.equal(autoRes.statusCode, 200);
    const firstRef = autoRes.json().data.results[0]?.reference;
    assert.ok(firstRef);

    const wh = await app.inject({
      method: 'POST',
      url: '/webhooks/sling',
      payload: {
        reference: firstRef,
        message_id: 'slg_live_msg_991',
        status_delivery: 'delivered',
      },
    });
    assert.equal(wh.statusCode, 200);
    assert.equal(wh.json().data.status, 'delivered');

    const statusRes = await app.inject({
      method: 'GET',
      url: '/v1/admin/sling/status',
      headers: adminHeaders(),
    });
    assert.equal(statusRes.statusCode, 200);
    assert.ok(Array.isArray(statusRes.json().data.automationRules));
    assert.ok(statusRes.json().data.automationRules.length >= 8);
  });

  it('respects promo opt-outs, never markets to unknown numbers, and launches only once', async () => {
    const optedOut = await createCustomer('Opted Out', '+2348061110001');
    const reachable = await createCustomer('Still In', '+2348061110002');
    await q(`INSERT INTO notification.user_preference (user_id, promo_enabled) VALUES ($1, false)`, [optedOut]);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/admin/campaigns',
      headers: adminHeaders(),
      payload: {
        name: 'Consent check',
        kind: 'bulk_promotional',
        channels: ['sms', 'inapp'],
        targetSegment: 'custom_numbers',
        messageBody: 'Deep cleaning is 10% off this week.',
        aiAssisted: false,
      },
    });
    assert.equal(created.statusCode, 200);
    const id = created.json().data.campaign.id;
    assert.equal(created.json().data.campaign.status, 'draft');

    const launch = () => app.inject({
      method: 'POST',
      url: `/v1/admin/campaigns/${id}/launch`,
      headers: adminHeaders(),
      payload: { customNumbers: ['+2348061110001', '08061110002', '+2348069999999'] },
    });
    const first = await launch();
    assert.equal(first.statusCode, 200);
    const stats = first.json().data.stats;
    assert.equal(stats.targeted, 1, 'only the customer who has not opted out');
    assert.equal(stats.skippedOptOut, 1);
    assert.equal(stats.skippedNoConsent, 1, 'a number with no account gets no promotion');
    assert.equal(stats.channels.sms, 'sent');
    assert.equal(first.json().data.status, 'completed');

    const inbox = await q<{ user_id: string }>(
      `SELECT user_id FROM notification.delivery_log WHERE campaign_id = $1 AND channel = 'inapp'`, [id],
    );
    assert.deepEqual(inbox.map((r) => String(r.user_id)), [reachable]);

    const again = await launch();
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().error.code, 'CAMPAIGN_ALREADY_LAUNCHED');
  });
});
