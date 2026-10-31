// Admin operations: WhatsApp support inbox, payouts desk, matching model.
// Route-level, through the real access gate (admin seat + permission).
import 'dotenv/config';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { q } from '../packages/database/db.js';
import { signAccess } from '../packages/auth/auth.js';

process.env.NODE_ENV = 'test';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: { inject: (opts: any) => Promise<any>; close?: () => Promise<void> };
before(async () => {
  process.env.DATABASE_URL = '';
  process.env.REDIS_URL = '';
  ({ app } = await import('../apps/api/src/main.js'));
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
});
after(async () => { await app?.close?.().catch(() => {}); });

const auth = (sub: string) => ({ authorization: `Bearer ${signAccess(sub, [])}` });
async function user(role: string) {
  return String((await q<{ id: string }>(`INSERT INTO identity.users (email, role) VALUES ($1,$2) RETURNING id`, [`${role.toLowerCase()}-${randomUUID()}@kendibo.local`, role]))[0].id);
}

describe('admin ops access', () => {
  it('customers and anonymous callers are refused; the right role gets in', async () => {
    const anon = await app.inject({ method: 'GET', url: '/v1/admin/payouts/queue' });
    assert.equal(anon.statusCode, 401);
    const customer = await user('CUSTOMER');
    const c = await app.inject({ method: 'GET', url: '/v1/admin/payouts/queue', headers: auth(customer) });
    assert.equal(c.statusCode, 403);
    // Support can work the inbox but cannot pay vendors.
    const support = await user('CUSTOMER_SUPPORT');
    assert.equal((await app.inject({ method: 'GET', url: '/v1/admin/whatsapp/conversations', headers: auth(support) })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/admin/payouts/queue', headers: auth(support) })).statusCode, 403);
    const finance = await user('FINANCE');
    assert.equal((await app.inject({ method: 'GET', url: '/v1/admin/payouts/queue', headers: auth(finance) })).statusCode, 200);
  });
});

describe('WhatsApp support inbox', () => {
  it('lists hand-offs, replies inside the 24h window, refuses outside it, and resolves', async () => {
    const support = await user('CUSTOMER_SUPPORT');
    const waId = `2348${Math.floor(Math.random() * 1e9)}`;
    await q(`INSERT INTO messaging.whatsapp_session (wa_id, state) VALUES ($1,'HUMAN')`, [waId]);
    await q(`INSERT INTO messaging.whatsapp_turn (wa_id, role, content) VALUES ($1,'user','The cleaner broke my vase')`, [waId]);

    const list = await app.inject({ method: 'GET', url: '/v1/admin/whatsapp/conversations', headers: auth(support) });
    const row = list.json().data.find((r: { waId: string }) => r.waId === waId);
    assert.ok(row, 'hand-off is listed');
    assert.equal(row.canReply, true);

    const sent = await app.inject({ method: 'POST', url: `/v1/admin/whatsapp/conversations/${waId}/reply`, headers: auth(support), payload: { text: 'So sorry — we will make this right.' } });
    assert.equal(sent.statusCode, 200);
    const thread = await app.inject({ method: 'GET', url: `/v1/admin/whatsapp/conversations/${waId}`, headers: auth(support) });
    assert.ok(thread.json().data.turns.some((t: { text: string }) => t.text.startsWith('[team]')));

    // A conversation whose last customer message is older than 24h.
    const stale = `2349${Math.floor(Math.random() * 1e9)}`;
    await q(`INSERT INTO messaging.whatsapp_session (wa_id, state) VALUES ($1,'HUMAN')`, [stale]);
    await q(`INSERT INTO messaging.whatsapp_turn (wa_id, role, content, created_at) VALUES ($1,'user','hello',$2)`, [stale, new Date(Date.now() - 30 * 3600_000).toISOString()]);
    const late = await app.inject({ method: 'POST', url: `/v1/admin/whatsapp/conversations/${stale}/reply`, headers: auth(support), payload: { text: 'hi' } });
    assert.equal(late.statusCode, 409);
    assert.equal(late.json().error.code, 'OUTSIDE_24H_WINDOW');

    const resolved = await app.inject({ method: 'POST', url: `/v1/admin/whatsapp/conversations/${waId}/resolve`, headers: auth(support) });
    assert.equal(resolved.statusCode, 200);
    const state = (await q<{ state: string }>(`SELECT state FROM messaging.whatsapp_session WHERE wa_id=$1`, [waId]))[0].state;
    assert.equal(state, 'MENU', 'bot takes the conversation back');
  });
});

describe('payouts desk', () => {
  it('shows balances net of fees and never pays more than is available', async () => {
    const finance = await user('FINANCE');
    const vendorUser = await user('PROVIDER');
    const pid = String((await q<{ id: string }>(`INSERT INTO provider.provider (user_id, business_name) VALUES ($1,'Ada Cleaning') RETURNING id`, [vendorUser]))[0].id);
    await q(`INSERT INTO provider.earning (provider_id, job_id, amount_kobo) VALUES ($1,$2,2000000)`, [pid, `job_${randomUUID()}`]);
    await q(`INSERT INTO provider.fee_ledger (provider_id, kind, amount_kobo, reference) VALUES ($1,'kyc_verification',50000,$2)`, [pid, `kyc:${randomUUID()}`]);

    const queue = await app.inject({ method: 'GET', url: '/v1/admin/payouts/queue', headers: auth(finance) });
    const row = queue.json().data.find((r: { providerId: string }) => r.providerId === pid);
    assert.equal(row.availableKobo, '1950000', 'earned minus outstanding fee');

    const tooMuch = await app.inject({ method: 'POST', url: `/v1/admin/payouts/${pid}/pay`, headers: auth(finance), payload: { amountKobo: '1950001' } });
    assert.equal(tooMuch.statusCode, 409);
    assert.equal(tooMuch.json().error.code, 'PAYOUT_EXCEEDS_BALANCE');
  });
});

describe('matching model status', () => {
  it('reports cold-start state and refuses to train without enough data', async () => {
    const ops = await user('SUPER_ADMIN');
    const status = await app.inject({ method: 'GET', url: '/v1/admin/ml/status', headers: auth(ops) });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().data.coldStart, true);
    const train = await app.inject({ method: 'POST', url: '/v1/admin/ml/train', headers: auth(ops) });
    assert.equal(train.statusCode, 200);
    assert.equal(train.json().data.activated, false);
  });
});
