// Meta integration: WhatsApp message templates (status webhooks, approved-only
// sending, pay link) and Facebook Login (token checks, linking, data deletion).
// Meta's Graph API is stubbed; nothing leaves the machine.
import 'dotenv/config';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto, { randomUUID } from 'node:crypto';
import { q } from '../packages/database/db.js';
import { signAccess } from '../packages/auth/auth.js';

process.env.NODE_ENV = 'test';
process.env.WHATSAPP_APP_SECRET = 'test-app-secret';
const FB_APP = '987654321012345';
const FB_SECRET = 'fb-test-secret';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: { inject: (opts: any) => Promise<any>; close?: () => Promise<void> };
const realFetch = globalThis.fetch;
before(async () => {
  process.env.DATABASE_URL = '';
  process.env.REDIS_URL = '';
  ({ app } = await import('../apps/api/src/main.js'));
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
});
after(async () => {
  globalThis.fetch = realFetch;
  await app?.close?.().catch(() => {});
});

const number = () => `23491${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
const sign = (body: string) => `sha256=${crypto.createHmac('sha256', 'test-app-secret').update(body).digest('hex')}`;
async function admin() {
  const id = String((await q<{ id: string }>(`INSERT INTO identity.users (name, email, role) VALUES ('Ops', $1, 'SUPER_ADMIN') RETURNING id`, [`ops-${randomUUID()}@kendibo.local`]))[0].id);
  return { authorization: `Bearer ${signAccess(id, [])}` };
}
async function botTurns(waId: string) {
  return (await q<{ content: string }>(`SELECT content FROM messaging.whatsapp_turn WHERE wa_id=$1 AND role='assistant'`, [waId])).map((r) => String(r.content));
}

describe('WhatsApp message templates', () => {
  it('exposes a configured Kendibot link by default and honors explicit disable', async () => {
    const keys = ['KENDIBOT_PROMOTION_ENABLED', 'WHATSAPP_BUSINESS_NUMBER', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      process.env.KENDIBOT_PROMOTION_ENABLED = 'false';
      process.env.WHATSAPP_BUSINESS_NUMBER = '+234 800 123 4567';
      process.env.WHATSAPP_ACCESS_TOKEN = 'test-token';
      process.env.WHATSAPP_PHONE_NUMBER_ID = '123';
      let response = await app.inject({ method: 'GET', url: '/v1/kendibot' });
      assert.deepEqual(response.json().data, { enabled: false, url: null });
      delete process.env.KENDIBOT_PROMOTION_ENABLED;
      response = await app.inject({ method: 'GET', url: '/v1/kendibot' });
      assert.deepEqual(response.json().data, { enabled: true, url: 'https://wa.me/2348001234567?text=Hello' });
      process.env.KENDIBOT_PROMOTION_ENABLED = 'true';
      response = await app.inject({ method: 'GET', url: '/v1/kendibot' });
      assert.deepEqual(response.json().data, { enabled: true, url: 'https://wa.me/2348001234567?text=Hello' });
      process.env.WHATSAPP_BUSINESS_NUMBER = 'invalid';
      response = await app.inject({ method: 'GET', url: '/v1/kendibot' });
      assert.deepEqual(response.json().data, { enabled: false, url: null });
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });
  it('follows Meta status webhooks and only sends approved templates', async () => {
    const { applyTemplateWebhook, approvedTemplate } = await import('../modules/whatsapp/templates.js');
    const base = { message_template_id: 555001, message_template_name: 'kendibo_job_offer', message_template_language: 'en' };
    assert.equal(await approvedTemplate('job_offer'), null, 'nothing is sent before review');
    await applyTemplateWebhook('message_template_status_update', { ...base, event: 'APPROVED', reason: 'NONE' });
    assert.equal(await approvedTemplate('job_offer'), null, 'a missing category must not be assumed to be utility');
    await applyTemplateWebhook('template_category_update', { ...base, new_category: 'UTILITY' });
    assert.deepEqual(await approvedTemplate('job_offer'), { name: 'kendibo_job_offer', language: 'en' });
    await applyTemplateWebhook('message_template_status_update', { ...base, event: 'PAUSED', reason: 'LOW_QUALITY' });
    assert.equal(await approvedTemplate('job_offer'), null, 'paused templates are not sent');
    await applyTemplateWebhook('message_template_status_update', { message_template_id: 555001, event: 'REINSTATED' });
    assert.ok(await approvedTemplate('job_offer'), 'matched by template id, reinstated = approved');
    await applyTemplateWebhook('template_category_update', { ...base, previous_category: 'UTILITY', new_category: 'MARKETING' });
    await applyTemplateWebhook('message_template_quality_update', { ...base, previous_quality_score: 'GREEN', new_quality_score: 'YELLOW' });
    const row = (await q<{ category: string; quality: string; status: string }>(`SELECT category, quality, status FROM messaging.whatsapp_template WHERE name='kendibo_job_offer'`))[0];
    assert.equal(row.category, 'MARKETING');
    assert.equal(row.quality, 'YELLOW');
    assert.equal(row.status, 'APPROVED');
    assert.equal(await approvedTemplate('job_offer'), null, 'marketing cannot be used without the consent gate');
    assert.ok(await approvedTemplate('job_offer', true), 'the marketing template can be selected after consent is checked');
  });

  it('a template webhook through the signed endpoint updates the status', async () => {
    const payload = JSON.stringify({ entry: [{ id: 'waba', changes: [{ field: 'message_template_status_update', value: { event: 'REJECTED', message_template_id: 555002, message_template_name: 'kendibo_request_update', message_template_language: 'en', reason: 'INVALID_FORMAT' } }] }] });
    const r = await app.inject({ method: 'POST', url: '/webhooks/whatsapp', payload, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(payload) } });
    assert.equal(r.statusCode, 200);
    let row: { status: string; reason: string } | undefined;
    for (let i = 0; i < 40 && !row; i++) {
      row = (await q<{ status: string; reason: string }>(`SELECT status, reason FROM messaging.whatsapp_template WHERE name='kendibo_request_update'`))[0];
      if (!row) await new Promise((res) => setTimeout(res, 25));
    }
    assert.equal(row?.status, 'REJECTED');
    assert.equal(row?.reason, 'INVALID_FORMAT');
  });

  it('returns a retryable error when an inbound message cannot be persisted', async () => {
    const payload = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: { messages: [{ from: number(), type: 'text', text: { body: 'hello' } }] } }] }] });
    const r = await app.inject({ method: 'POST', url: '/webhooks/whatsapp', payload, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(payload) } });
    assert.equal(r.statusCode, 503);
    assert.equal(r.json().error.code, 'WHATSAPP_INBOUND_UNAVAILABLE');
  });

  it('stores a signed inbound message before acknowledging it and deduplicates retries', async () => {
    const id = `wamid.${randomUUID()}`;
    const payload = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: { messages: [{ id, from: number(), type: 'text', text: { body: 'hello' } }] } }] }] });
    const options = { method: 'POST', url: '/webhooks/whatsapp', payload, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(payload) } };
    assert.equal((await app.inject(options)).statusCode, 200);
    assert.equal((await app.inject(options)).statusCode, 200);
    const rows = await q<{ n: string }>(`SELECT COUNT(*) AS n FROM messaging.whatsapp_inbound WHERE message_id=$1`, [id]);
    assert.equal(Number(rows[0].n), 1);
  });

  it('outside the 24h window an approved template is used instead of SMS', async () => {
    const { applyTemplateWebhook } = await import('../modules/whatsapp/templates.js');
    await applyTemplateWebhook('message_template_status_update', { message_template_id: 555001, message_template_name: 'kendibo_job_offer', message_template_language: 'en', event: 'APPROVED' });
    // The first test moved it to MARKETING; only utility templates are sent.
    await applyTemplateWebhook('template_category_update', { message_template_id: 555001, message_template_name: 'kendibo_job_offer', message_template_language: 'en', new_category: 'UTILITY' });
    const { notifyProviderOfOffer } = await import('../modules/whatsapp/whatsapp.bot.js');
    const v = number();
    const { setJobOfferConsent } = await import('../modules/whatsapp/policy.js');
    await setJobOfferConsent(v, true);
    await notifyProviderOfOffer(`+${v}`, randomUUID(), 'AC repair, 2 km away');
    assert.ok((await botTurns(v)).some((t) => t.includes('[template kendibo_job_offer]')));
  });

  it('the admin console lists the catalogue with Meta status, and refuses sync until configured', async () => {
    const h = await admin();
    const list = await app.inject({ method: 'GET', url: '/v1/admin/whatsapp/templates', headers: h });
    assert.equal(list.statusCode, 200);
    const names = list.json().data.templates.map((t: { name: string }) => t.name);
    assert.deepEqual(names, ['kendibo_job_offer', 'kendibo_vendor_accepted', 'kendibo_request_update']);
    const sync = await app.inject({ method: 'POST', url: '/v1/admin/whatsapp/templates/sync', headers: h });
    assert.equal(sync.statusCode, 409);
    const anon = await app.inject({ method: 'GET', url: '/v1/admin/whatsapp/templates' });
    assert.equal(anon.statusCode, 401);
  });

  it('the pay link only works for the right number and a payable booking', async () => {
    const bad = await app.inject({ method: 'GET', url: '/w/pay?t=forged.token' });
    assert.equal(bad.statusCode, 410);
    const { payToken } = await import('../modules/whatsapp/links.js');
    const t = payToken(number(), randomUUID());
    const other = await app.inject({ method: 'GET', url: `/w/pay?t=${encodeURIComponent(t)}` });
    assert.equal(other.statusCode, 200);
    assert.match(other.body, /not valid for this number/);
  });
});

describe('Facebook Login', () => {
  const graph = (handler: (url: URL) => unknown) => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.hostname !== 'graph.facebook.com') return realFetch(input, init);
      const body = handler(url);
      return new Response(JSON.stringify(body), { status: body && (body as { error?: unknown }).error ? 400 : 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  };
  const token = 'EAAG' + 'x'.repeat(60);

  it('is refused cleanly before it is configured', async () => {
    delete process.env.FACEBOOK_APP_ID;
    const r = await app.inject({ method: 'POST', url: '/v1/auth/facebook', payload: { accessToken: token } });
    assert.equal(r.statusCode, 503);
  });

  it('signs in only with a token issued to our app, and links by Facebook id', async () => {
    process.env.FACEBOOK_APP_ID = FB_APP;
    process.env.FACEBOOK_APP_SECRET = FB_SECRET;
    const fbId = `fb_${Date.now()}`;
    let sawProof = false;
    graph((url) => {
      if (url.pathname.endsWith('/debug_token')) {
        assert.equal(url.searchParams.get('access_token'), `${FB_APP}|${FB_SECRET}`, 'checked with our app token');
        return { data: { is_valid: true, app_id: FB_APP, user_id: fbId, expires_at: Math.floor(Date.now() / 1000) + 3600 } };
      }
      if (url.pathname.endsWith('/me')) {
        sawProof = url.searchParams.get('appsecret_proof') === crypto.createHmac('sha256', FB_SECRET).update(token).digest('hex');
        return { id: fbId, name: 'Ada Okon', email: `ada-${fbId}@example.com` };
      }
      return { error: { message: 'unexpected' } };
    });
    const first = await app.inject({ method: 'POST', url: '/v1/auth/facebook', payload: { accessToken: token } });
    assert.equal(first.statusCode, 200, first.body);
    assert.ok(first.json().data.access);
    assert.equal(first.json().data.isNew, true);
    assert.ok(sawProof, 'profile fetched with appsecret_proof');
    const again = await app.inject({ method: 'POST', url: '/v1/auth/facebook', payload: { accessToken: token } });
    assert.equal(again.json().data.isNew, false);
    assert.equal(again.json().data.user.id, first.json().data.user.id);
  });

  it('rejects a token issued to another app', async () => {
    process.env.FACEBOOK_APP_ID = FB_APP;
    process.env.FACEBOOK_APP_SECRET = FB_SECRET;
    graph((url) => (url.pathname.endsWith('/debug_token') ? { data: { is_valid: true, app_id: '111', user_id: 'someone' } } : { id: 'someone' }));
    const r = await app.inject({ method: 'POST', url: '/v1/auth/facebook', payload: { accessToken: token } });
    assert.equal(r.statusCode, 401);
  });

  it('honours Meta data-deletion callbacks signed with the app secret', async () => {
    process.env.FACEBOOK_APP_SECRET = FB_SECRET;
    const fbId = `fbdel_user_${Date.now()}`;
    await q(`INSERT INTO identity.users (name, facebook_sub, profile_image) VALUES ('Del', $1, 'https://scontent.fbcdn.net/p.jpg')`, [fbId]);
    const b64 = (s: Buffer | string) => Buffer.from(s).toString('base64url');
    const payload = b64(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: fbId, issued_at: Math.floor(Date.now() / 1000) }));
    const signed = `${b64(crypto.createHmac('sha256', FB_SECRET).update(payload).digest())}.${payload}`;
    const forged = await app.inject({ method: 'POST', url: '/v1/auth/facebook/data-deletion', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `signed_request=${encodeURIComponent(`x${signed}`)}` });
    assert.equal(forged.statusCode, 400);
    const r = await app.inject({ method: 'POST', url: '/v1/auth/facebook/data-deletion', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `signed_request=${encodeURIComponent(signed)}` });
    assert.equal(r.statusCode, 200, r.body);
    const { url, confirmation_code: code } = r.json();
    assert.match(code, /^fbdel_[0-9a-f]{20}$/);
    assert.match(url, /\/w\/facebook-deletion\?code=/);
    const left = await q<{ id: string }>(`SELECT id FROM identity.users WHERE facebook_sub=$1`, [fbId]);
    assert.equal(left.length, 0, 'Facebook id unlinked');
    const page = await app.inject({ method: 'GET', url: `/w/facebook-deletion?code=${code}` });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /has been removed/);
  });
});
