// KYC manual-review fallback: when the identity provider (Prembly) is not
// configured, unfunded, over quota or down, an ID application is saved as
// UNDER_REVIEW with pending_reason='manual_verification' and handed to admins —
// never rejected and never a 500. No real network: fetch is stubbed and email
// is captured.
import 'dotenv/config';
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { q } from '../packages/database/db.js';
import { signAccess } from '../packages/auth/auth.js';
import { email } from '../modules/notifications/channels.js';

process.env.NODE_ENV = 'test';

type InjectRes = { statusCode: number; json: () => any; body: string };
let app: { inject: (opts: any) => Promise<InjectRes>; close?: () => Promise<void> };
let M: any; let kycService: any; let providerService: any; let K: any;

type Sent = { to: string; subject: string };
const sent: Sent[] = [];
const originalSend = email.send.bind(email);
const originalFetch = globalThis.fetch;
const ENV_KEYS = ['NODE_ENV', 'KYC_PROVIDER', 'PREMBLY_SECRET_KEY', 'PREMBLY_API_KEY', 'PREMBLY_BASE_URL', 'KYC_MAX_ATTEMPTS_PER_DAY', 'KYC_COST_NIN_KOBO'] as const;
let savedEnv = new Map<string, string | undefined>();

before(async () => {
  process.env.DATABASE_URL = '';
  process.env.REDIS_URL = '';
  ({ app } = await import('../apps/api/src/main.js'));
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
  M = await import('../modules/notifications/admin-alerts.service.js');
  K = await import('../modules/kyc/kyc.service.js');
  kycService = K.kycService;
  ({ providerService } = await import('../modules/providers/provider.service.js'));
  (email as { send: unknown }).send = async (to: string, subject: string) => {
    sent.push({ to, subject });
    return { id: `test_${sent.length}`, provider: 'test' };
  };
});
after(async () => {
  (email as { send: unknown }).send = originalSend;
  globalThis.fetch = originalFetch;
  await app?.close?.().catch(() => {});
});
beforeEach(() => {
  sent.length = 0;
  savedEnv = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of savedEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const auth = (sub: string) => ({ authorization: `Bearer ${signAccess(sub, [])}` });
async function user(role = 'CUSTOMER', name = 'Ada Okon') {
  return String((await q<{ id: string }>(`INSERT INTO identity.users (email, role, name) VALUES ($1,$2,$3) RETURNING id`,
    [`${role.toLowerCase()}-${randomUUID()}@kendibo.local`, role, name]))[0].id);
}
const manualAlerts = (needle?: string) => sent.filter((m) => m.subject.includes('KYC needs manual verification') && (!needle || m.subject.includes(needle)));
async function recipients() { return (await M.getAlertEmails()).length as number; }
const MESSAGE = "We've received your details. Our team will verify you shortly — usually within 24 hours.";

/** Production with no Prembly keys: the sandbox adapter fails closed with KYC_PROVIDER_UNCONFIGURED. */
function productionWithoutKeys() {
  process.env.NODE_ENV = 'production';
  process.env.KYC_PROVIDER = 'stub';
  process.env.PREMBLY_SECRET_KEY = '';
  process.env.PREMBLY_API_KEY = '';
}

/** Production with a (fake) Prembly key and every Prembly call answered by `respond`. */
function productionWithPrembly(respond: () => Response) {
  process.env.NODE_ENV = 'production';
  process.env.KYC_PROVIDER = 'prembly';
  process.env.PREMBLY_SECRET_KEY = 'unit-test-secret';
  process.env.PREMBLY_BASE_URL = 'https://prembly.test';
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    assert.ok(String(input).startsWith('https://prembly.test/'), `unexpected fetch ${String(input)}`);
    return respond();
  }) as typeof fetch;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('classification', () => {
  it('provider-side outages are unavailable; real verdicts are not', () => {
    const c = (reason: string) => K.classifyKycResult({ passed: false, reason });
    for (const r of ['KYC_PROVIDER_UNCONFIGURED', 'PREMBLY_INSUFFICIENT_WALLET_BALANCE: top up', 'PREMBLY_HTTP_429: slow down',
      'PREMBLY_HTTP_503', 'The operation was aborted due to timeout', 'fetch failed', 'KYC_ADAPTER_ERROR: boom', 'KYC_DAILY_BUDGET_REACHED']) {
      assert.equal(c(r), 'unavailable', r);
    }
    for (const r of ['NIN_NOT_FOUND', 'NIN_FORMAT', 'SELFIE_MISSING', 'LOW_FACE_CONFIDENCE_40', 'KYC_ATTEMPT_LIMIT', 'Submitted profile name does not match NIN/BVN legal name.']) {
      assert.equal(c(r), 'failed', r);
    }
    assert.equal(K.classifyKycResult({ passed: true }), 'passed');
  });
});

describe('customer KYC when the provider is unavailable', () => {
  it('production with no Prembly keys: 200, UNDER_REVIEW + manual_verification, one alert', async () => {
    const uid = await user('CUSTOMER', 'Chinedu Eze');
    productionWithoutKeys();
    const res = await app.inject({ method: 'POST', url: '/v1/user/kyc', headers: auth(uid), payload: { nin: '12345678901' } });
    assert.equal(res.statusCode, 200, res.body);
    const d = res.json().data;
    assert.equal(d.status, 'UNDER_REVIEW');
    assert.equal(d.pendingReason, 'manual_verification');
    assert.equal(d.message, MESSAGE);
    assert.equal(d.rejectionReason, null);
    assert.equal(d.userId, uid, 'existing response shape kept');

    const row = (await q<Record<string, any>>(`SELECT status, pending_reason, submitted_masked FROM kyc.customer WHERE user_id=$1`, [uid]))[0];
    assert.equal(row.pending_reason, 'manual_verification');
    const masked = typeof row.submitted_masked === 'string' ? JSON.parse(row.submitted_masked) : row.submitted_masked;
    assert.equal(masked.nin, '123****8901');
    assert.ok(!JSON.stringify(masked).includes('12345678901'), 'raw NIN never stored');

    const checks = await q<{ status: string; masked_input: string }>(
      `SELECT status, masked_input FROM kyc.verification_check WHERE subject_type='user' AND subject_id=$1`, [uid]);
    assert.ok(checks.some((c) => c.status === 'unavailable' && c.masked_input === '123****8901'));

    await M.flushAdminAlerts();
    assert.equal(manualAlerts('Chinedu Eze').length, await recipients(), 'one alert per recipient');

    // A retry while still pending is saved again but does not alert again.
    const again = await app.inject({ method: 'POST', url: '/v1/user/kyc', headers: auth(uid), payload: { nin: '12345678901' } });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().data.pendingReason, 'manual_verification');
    await M.flushAdminAlerts();
    assert.equal(manualAlerts('Chinedu Eze').length, await recipients(), 'no duplicate alert for the same application');

    // GET shows the same pending state and message.
    const got = await app.inject({ method: 'GET', url: '/v1/user/kyc', headers: auth(uid) });
    assert.equal(got.json().data.message, MESSAGE);
  });

  it('an adapter that throws is saved for manual review, never a 500', async () => {
    const uid = await user('CUSTOMER', 'Bola Ade');
    const throwing = {
      name: 'prembly',
      verifyNin: async () => { throw new Error('socket hang up'); },
      verifyBvn: async () => { throw new Error('socket hang up'); },
      verifyDocAndFace: async () => { throw new Error('socket hang up'); },
      verifyCac: async () => { throw new Error('socket hang up'); },
    };
    const out = await kycService.submitUserApplication(uid, { nin: '12345678901', adapter: throwing });
    assert.equal(out.status, 'UNDER_REVIEW');
    assert.equal(out.pendingReason, 'manual_verification');
    const checks = await kycService.checksFor('user', uid);
    assert.equal(checks[0].status, 'unavailable');
    assert.match(String(checks[0].detail?.reason ?? JSON.parse(String(checks[0].detail)).reason), /KYC_ADAPTER_ERROR/);
    await M.flushAdminAlerts();
    assert.equal(manualAlerts('Bola Ade').length, await recipients());
  });

  it('Prembly 402 insufficient balance through the route: saved for manual review', async () => {
    const uid = await user('CUSTOMER', 'Tunde Bakare');
    productionWithPrembly(() => json(402, { status: false, detail: 'Insufficient wallet balance' }));
    const res = await app.inject({ method: 'POST', url: '/v1/user/kyc', headers: auth(uid), payload: { nin: '22345678901' } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().data.status, 'UNDER_REVIEW');
    assert.equal(res.json().data.pendingReason, 'manual_verification');
    const cost = await q<{ unit_cost_kobo: string; outcome: string }>(
      `SELECT unit_cost_kobo, outcome FROM kyc.verification_cost WHERE subject_type='user' AND subject_id=$1`, [uid]);
    assert.ok(cost.length >= 1);
    for (const c of cost) {
      assert.equal(Number(c.unit_cost_kobo), 0, 'outage is not billed');
      assert.match(c.outcome, /^unavailable:/);
    }
  });

  it('a real NIN_NOT_FOUND keeps today\'s behaviour (no manual flag, no alert)', async () => {
    const uid = await user('CUSTOMER', 'Ngozi Real');
    // Local sandbox (NODE_ENV=test): NINs starting 0000 are a definite not-found.
    const out = await kycService.submitUserApplication(uid, { nin: '00001234567' });
    assert.equal(out.status, 'UNDER_REVIEW');
    assert.equal(out.pendingReason, null);
    assert.equal(out.message, null);
    const checks = await kycService.checksFor('user', uid);
    assert.ok(checks.some((c: any) => c.status === 'failed'));
    assert.ok(!checks.some((c: any) => c.status === 'unavailable'));
    await M.flushAdminAlerts();
    assert.equal(manualAlerts('Ngozi Real').length, 0);
  });
});

describe('attempt limit and spend', () => {
  it('unavailable attempts do not consume KYC_MAX_ATTEMPTS_PER_DAY; real failures still do', async () => {
    const uid = await user('CUSTOMER', 'Ada Okon');
    process.env.KYC_MAX_ATTEMPTS_PER_DAY = '1';
    process.env.KYC_COST_NIN_KOBO = '5000';
    productionWithPrembly(() => json(402, { status: false, detail: 'Insufficient wallet balance' }));
    for (let i = 0; i < 3; i++) {
      const out = await kycService.submitUserApplication(uid, { nin: '32345678901' });
      assert.equal(out.pendingReason, 'manual_verification', `attempt ${i + 1}`);
    }
    const reasons = (await kycService.checksFor('user', uid)).map((c: any) => String((typeof c.detail === 'string' ? JSON.parse(c.detail) : c.detail)?.reason ?? ''));
    assert.ok(!reasons.some((r: string) => r.includes('KYC_ATTEMPT_LIMIT')));

    // Prembly is funded again: the next attempt runs (not blocked) and verifies.
    productionWithPrembly(() => json(200, { status: true, response_code: '00', data: { firstname: 'Ada', lastname: 'Okon' } }));
    const ok = await kycService.submitUserApplication(uid, { nin: '32345678901' });
    assert.equal(ok.status, 'VERIFIED');
    assert.equal(ok.pendingReason, null);

    // Control: a conclusive not-found does count, so the limit still bites.
    const other = await user('CUSTOMER', 'Limit Control');
    productionWithPrembly(() => json(200, { status: false, response_code: '01', detail: 'NIN_NOT_FOUND' }));
    await kycService.submitUserApplication(other, { nin: '42345678901' });
    const blocked = await kycService.submitUserApplication(other, { nin: '52345678901' });
    assert.equal(blocked.pendingReason, null);
    const last = (await kycService.checksFor('user', other))
      .map((c: any) => (typeof c.detail === 'string' ? JSON.parse(c.detail) : c.detail)?.reason);
    assert.ok(last.includes('KYC_ATTEMPT_LIMIT'), 'real attempts are still limited');
  });
});

describe('provider KYC + admin queue', () => {
  it('provider submission saved for manual review; queue lists both; approve clears pending', async () => {
    const pUser = await user('PROVIDER', 'Emeka Fixit');
    const prov = await providerService.onboard(pUser);
    const cUser = await user('CUSTOMER', 'Queue Customer');
    const admin = await user('SUPER_ADMIN', 'Ops Admin');

    productionWithoutKeys();
    const pres = await app.inject({ method: 'POST', url: '/v1/provider/kyc', headers: auth(pUser), payload: { nin: '62345678901' } });
    assert.equal(pres.statusCode, 200, pres.body);
    assert.equal(pres.json().data.status, 'UNDER_REVIEW');
    assert.equal(pres.json().data.pendingReason, 'manual_verification');
    assert.equal(pres.json().data.message, MESSAGE);
    assert.equal(pres.json().data.rejectionReason, null);
    const cres = await app.inject({ method: 'POST', url: '/v1/user/kyc', headers: auth(cUser), payload: { nin: '72345678901' } });
    assert.equal(cres.statusCode, 200, cres.body);
    process.env.NODE_ENV = 'test';

    await M.flushAdminAlerts();
    assert.equal(manualAlerts('Emeka Fixit').length, await recipients(), 'one provider alert');
    assert.equal(sent.filter((m) => m.subject.includes('KYC submitted: ')).length, 0, 'no second generic KYC alert');

    // Only admins with provider:verify see the queue.
    assert.equal((await app.inject({ method: 'GET', url: '/v1/admin/kyc/queue', headers: auth(cUser) })).statusCode, 403);
    const queue = await app.inject({ method: 'GET', url: '/v1/admin/kyc/queue?pendingReason=manual_verification', headers: auth(admin) });
    assert.equal(queue.statusCode, 200, queue.body);
    const items = queue.json().data as any[];
    const pItem = items.find((i) => i.subjectType === 'provider' && i.subjectId === prov.id);
    const cItem = items.find((i) => i.subjectType === 'user' && i.subjectId === cUser);
    assert.ok(pItem && cItem, 'both subjects listed');
    assert.equal(pItem.pendingReason, 'manual_verification');
    assert.equal(pItem.masked.nin, '623****8901');
    assert.equal(cItem.masked.nin, '723****8901');
    assert.ok(cItem.submittedAt);
    assert.ok(Array.isArray(cItem.documents));
    assert.ok(cItem.checks.some((c: any) => c.status === 'unavailable'));
    assert.ok(!queue.body.includes('62345678901') && !queue.body.includes('72345678901'), 'no raw ID numbers');

    // Helper for the later auto re-check job.
    const pending = await kycService.pendingManualReview(500);
    assert.ok(pending.some((r: any) => r.subjectType === 'provider' && r.subjectId === prov.id));
    assert.ok(pending.some((r: any) => r.subjectType === 'user' && r.subjectId === cUser));

    // Reject needs a reason.
    const noReason = await app.inject({ method: 'POST', url: `/v1/admin/users/kyc/${cUser}/reject`, headers: auth(admin), payload: {} });
    assert.equal(noReason.statusCode, 400);

    // Approve customer: VERIFIED, pending cleared, reviewed_by = admin.
    const ca = await app.inject({ method: 'POST', url: `/v1/admin/users/kyc/${cUser}/approve`, headers: auth(admin) });
    assert.equal(ca.statusCode, 200, ca.body);
    assert.equal(ca.json().data.status, 'VERIFIED');
    assert.equal(ca.json().data.pendingReason, null);
    const crow = (await q<{ reviewed_by: string; pending_reason: string | null }>(`SELECT reviewed_by, pending_reason FROM kyc.customer WHERE user_id=$1`, [cUser]))[0];
    assert.equal(crow.reviewed_by, admin);
    assert.equal(crow.pending_reason, null);

    // Approve provider via the existing route.
    const pa = await app.inject({ method: 'POST', url: `/v1/admin/providers/${prov.id}/approve`, headers: auth(admin) });
    assert.equal(pa.statusCode, 200, pa.body);
    const prow = (await q<{ kyc_status: string; kyc_pending_reason: string | null; kyc_reviewed_by: string }>(
      `SELECT kyc_status, kyc_pending_reason, kyc_reviewed_by FROM provider.provider WHERE id=$1`, [prov.id]))[0];
    assert.equal(prow.kyc_status, 'VERIFIED');
    assert.equal(prow.kyc_pending_reason, null);
    assert.equal(prow.kyc_reviewed_by, admin);

    const after = await kycService.pendingManualReview(500);
    assert.ok(!after.some((r: any) => r.subjectId === prov.id || r.subjectId === cUser));
  });
});
