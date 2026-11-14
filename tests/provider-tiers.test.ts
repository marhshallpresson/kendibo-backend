// Provider / vendor tiers: tier computation, paid upgrade applications (wallet
// and PSP checkout), admin approve/reject (+refunds), tier caps on acceptance,
// Tier-3-only trades, the Kendibo Pro subscription, admin downgrade, listing
// caps, and onboarding without documents. In-memory database; fake PSP.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { q } from '../packages/database/db.js';
import { signAccess } from '../packages/auth/auth.js';
import { walletService } from '../modules/wallet/wallet.service.js';

const fakePsp = {
  name: 'bachs',
  createCheckout: async (input: { reference: string }) => ({
    psp: 'bachs', checkoutId: `chk_${input.reference}`, checkoutUrl: `https://pay.test/c/${input.reference}`, reference: input.reference, status: 'open',
  }),
  getCheckout: async (checkoutId: string, reference: string) => ({ psp: 'bachs', checkoutId, checkoutUrl: `https://pay.test/c/${reference}`, reference, status: 'open' }),
  verifyByReference: async (reference: string) => ({ psp: 'bachs', chargeId: `ch_${reference}`, reference, amountKobo: 0n, currency: 'NGN', status: 'pending' }),
  verifyByChargeId: async (chargeId: string) => ({ psp: 'bachs', chargeId, reference: chargeId, amountKobo: 0n, currency: 'NGN', status: 'pending' }),
  refund: async () => ({ refundId: 'rf_test', status: 'processing' }),
  createPayout: async () => ({ payoutId: 'pay_test', status: 'pending' }),
  verifyWebhookSignature: () => true,
};
(globalThis as Record<string, unknown>).__PSP__ = { bachs: fakePsp };

process.env.NODE_ENV = 'test';
// Tier limits are enforced together with vendor eligibility.
process.env.VENDOR_ELIGIBILITY_ENFORCED = 'true';

type Res = { statusCode: number; json: () => any; body: string };
let app: { inject: (opts: unknown) => Promise<Res>; close?: () => Promise<void> };
let tierService: typeof import('../modules/tiers/tier.service.js')['tierService'];
let eligibility: typeof import('../modules/vendors/eligibility.service.js')['vendorEligibilityService'];
let offerings: typeof import('../modules/vendors/offering.service.js')['offeringService'];

before(async () => {
  process.env.DATABASE_URL = '';
  process.env.REDIS_URL = '';
  ({ app } = await import('../apps/api/src/main.js'));
  ({ tierService } = await import('../modules/tiers/tier.service.js'));
  ({ vendorEligibilityService: eligibility } = await import('../modules/vendors/eligibility.service.js'));
  ({ offeringService: offerings } = await import('../modules/vendors/offering.service.js'));
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
});
after(async () => { await app?.close?.().catch(() => {}); });

let ipN = 0;
const ip = () => { ipN++; return `10.77.${Math.floor(ipN / 250)}.${(ipN % 250) + 1}`; };
const call = (method: string, url: string, sub: string, payload?: unknown) =>
  app.inject({ method, url, remoteAddress: ip(), headers: { authorization: `Bearer ${signAccess(sub, [])}` }, ...(payload !== undefined ? { payload } : {}) });

async function user(role = 'PROVIDER', name = 'Bola Fixes') {
  return String((await q<{ id: string }>(
    `INSERT INTO identity.users (email, phone, role, name) VALUES ($1,$2,$3,$4) RETURNING id`,
    [`tier-${randomUUID()}@kendibo.local`, `+23480${Math.floor(Math.random() * 1e8).toString().padStart(8, '0')}`, role, name],
  ))[0].id);
}

/** A pro who meets Tier 1 (unless `opts` says otherwise). */
async function pro(opts: { kyc?: 'VERIFIED' | 'UNDER_REVIEW'; manual?: boolean; selfie?: boolean; face?: boolean; accountType?: 'individual' | 'business' } = {}) {
  const uid = await user();
  const pid = String((await q<{ id: string }>(
    `INSERT INTO provider.provider (user_id, kyc_status, kyc_tier, nin_masked, face_verified, lat, lng, account_type, kyc_pending_reason)
     VALUES ($1,$2,$3,'123****8901',$4,6.5244,3.3792,$5,$6) RETURNING id`,
    [uid, opts.kyc ?? 'VERIFIED', opts.kyc === 'UNDER_REVIEW' ? 0 : 2, opts.face ?? (opts.selfie !== false), opts.accountType ?? 'individual', opts.manual ? 'manual_verification' : null],
  ))[0].id);
  await q(`INSERT INTO provider.skill (provider_id, service_id) VALUES ($1,'cleaning')`, [pid]);
  return { uid, pid };
}

/** Everything Tier 2 asks for (address check, 2 photos, bank in own name, a reference). */
async function meetTier2(pid: string, uid: string) {
  await q(`INSERT INTO kyc.verification_check (subject_type, subject_id, tier, check_kind, status) VALUES ('provider',$1,3,'address','passed')`, [pid]);
  for (let i = 0; i < 2; i++) {
    const asset = `asset-${randomUUID()}`;
    await q(`INSERT INTO media.asset (id, status) VALUES ($1,'clean')`, [asset]);
    await q(`INSERT INTO provider.gallery (provider_id, asset_id) VALUES ($1,$2)`, [pid, asset]);
  }
  await q(`UPDATE provider.provider SET account_number='0123456789', bank_code='058', name_aligned=TRUE WHERE id=$1`, [pid]);
  const ref = await call('POST', '/v1/provider/tier/references', uid, { kind: 'guarantor', name: 'Chief Ade', phone: '08031112222', relationship: 'Former employer' });
  assert.equal(ref.statusCode, 200, ref.body);
}

async function admin() { return user('TRUST_SAFETY', 'Tolu Admin'); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('tier computation', () => {
  it('Tier 1 Starter once contact, NIN, selfie, a trade and a service area are in', async () => {
    const { uid } = await pro();
    const res = await call('GET', '/v1/provider/tier', uid);
    assert.equal(res.statusCode, 200, res.body);
    const d = res.json().data;
    assert.equal(d.tier, 1);
    assert.equal(d.active, true);
    assert.equal(d.name, 'Starter');
    assert.equal(d.badge, 'ID checked');
    assert.deepEqual(d.limits, { maxJobKobo: '5000000', maxOpenJobs: 3, maxListings: 10, payoutHoldHours: 48, commissionBps: 1500 });
    assert.equal(d.next.tier, 2);
    assert.equal(d.next.feeKobo, '250000');
    assert.equal(d.next.canApply, false);
    for (const k of ['proof_of_address', 'portfolio', 'bank_name_match', 'reference']) assert.ok(d.next.missing.includes(k), k);
    assert.equal(d.application, null);
    assert.equal(d.subscription.active, false);
    assert.equal(d.subscription.priceKobo, '300000');
    const home = d.lockedCategories.find((c: any) => c.id === 'home-care');
    assert.equal(home?.minTier, 3, 'home care is Tier-3-only');
    assert.ok(d.lockedCategories.some((c: any) => c.id === 'solar-inverter' && c.minTier === 2));
    assert.ok(!d.lockedCategories.some((c: any) => c.id === 'cleaning'));
  });

  it('is not active until Tier 1 is complete (no selfie yet)', async () => {
    const { uid } = await pro({ selfie: false });
    const d = (await call('GET', '/v1/provider/tier', uid)).json().data;
    assert.equal(d.tier, 1);
    assert.equal(d.active, false);
    assert.equal(d.requirements.find((r: any) => r.key === 'selfie').done, false);
    assert.equal(d.next.canApply, false);
    assert.ok(d.next.missing.includes('selfie'));
  });
});

describe('onboarding without documents', () => {
  it('finishes Tier 1 with NIN in manual review and no documents/CAC, and may go online at Tier 1 limits', async () => {
    const uid = await user('PROVIDER', 'Musa Clean');
    const s1 = await call('PUT', '/v1/provider/onboarding/progress', uid, { step: 'account', accountType: 'individual', data: { kind: 'individual' } });
    assert.equal(s1.statusCode, 200, s1.body);
    const pid = String(s1.json().data.providerId);
    assert.equal(s1.json().data.tier1.done, false);
    // NIN saved for manual review (identity provider down); selfie check recorded; trade + area set. No documents, no CAC.
    await q(`UPDATE provider.provider SET kyc_status='UNDER_REVIEW', kyc_pending_reason='manual_verification', lat=6.45, lng=3.4 WHERE id=$1`, [pid]);
    await q(`INSERT INTO kyc.verification_check (subject_type, subject_id, tier, check_kind, status) VALUES ('provider',$1,2,'face_liveness','unavailable')`, [pid]);
    await q(`INSERT INTO provider.skill (provider_id, service_id) VALUES ($1,'cleaning')`, [pid]);

    const prog = (await call('GET', '/v1/provider/onboarding/progress', uid)).json().data;
    assert.equal(prog.tier1.done, true, JSON.stringify(prog.tier1));
    assert.equal(prog.tier1.manualReview, true);
    const docs = await q<{ n: string }>(`SELECT COUNT(*) AS n FROM kyc.submission_document WHERE provider_id=$1`, [pid]);
    assert.equal(Number(docs[0].n), 0, 'no documents were needed');

    const online = await call('POST', '/v1/provider/online', uid, { online: true, lat: 6.45, lng: 3.4 });
    assert.equal(online.statusCode, 200, online.body);

    const low = await eligibility.evaluate(pid, 'cleaning', { amountKobo: 2_000_000n });
    assert.deepEqual(low.missing, [], 'low-risk trade within the Tier 1 cap');
    const big = await eligibility.evaluate(pid, 'cleaning', { amountKobo: 6_000_000n });
    assert.ok(big.missing.includes('job_cap'), 'manual review stays at the Tier 1 cap');
    const tier = (await call('GET', '/v1/provider/tier', uid)).json().data;
    assert.equal(tier.tier, 1);
    assert.equal(tier.active, true);
  });
});

describe('upgrade applications', () => {
  it('409 with the missing list when requirements are unmet', async () => {
    const { uid } = await pro();
    const res = await call('POST', '/v1/provider/tier/apply', uid, { targetTier: 2 });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().error.code, 'REQUIREMENTS_UNMET');
    assert.ok(res.json().error.missing.includes('portfolio'));
  });

  it('pays the Tier 2 fee from the wallet, admin approves, and the fee comes back after 3 jobs', async () => {
    const { uid, pid } = await pro();
    await meetTier2(pid, uid);
    await walletService.credit(uid, 300_000, `wt_${uid}_seed`, 'topup');
    const ready = (await call('GET', '/v1/provider/tier', uid)).json().data;
    assert.equal(ready.next.canApply, true, JSON.stringify(ready.next));

    const res = await call('POST', '/v1/provider/tier/apply', uid, { targetTier: 2, feeKobo: '1' }); // client amounts are ignored
    assert.equal(res.statusCode, 200, res.body);
    const d = res.json().data;
    assert.deepEqual(d.payment, { method: 'wallet', paid: true });
    assert.equal(d.status, 'under_review');
    assert.equal(await walletService.getBalance(uid), 50_000, 'charged ₦2,500 from the wallet');

    const again = await call('POST', '/v1/provider/tier/apply', uid, { targetTier: 2 });
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().error.code, 'APPLICATION_OPEN');

    const adm = await admin();
    const list = await call('GET', '/v1/admin/tier-applications?status=under_review', adm);
    assert.equal(list.statusCode, 200, list.body);
    assert.ok(list.json().data.items.some((a: any) => a.id === d.applicationId && a.feeKobo === '250000'));
    assert.equal((await call('GET', '/v1/admin/tier-applications', uid)).statusCode, 403, 'pros cannot see the queue');

    const ok = await call('POST', `/v1/admin/tier-applications/${d.applicationId}/approve`, adm, {});
    assert.equal(ok.statusCode, 200, ok.body);
    const after = (await call('GET', '/v1/provider/tier', uid)).json().data;
    assert.equal(after.tier, 2);
    assert.equal(after.badge, 'Verified pro');
    assert.equal(after.limits.maxJobKobo, '50000000');
    assert.equal(after.application.status, 'approved');
    const audit = await q(`SELECT 1 FROM audit.log WHERE action='provider.tier.application_approved' AND entity_id=$1`, [d.applicationId]);
    assert.equal(audit.length, 1);

    await sleep(5);
    for (let i = 0; i < 3; i++) await q(`INSERT INTO provider.earning (provider_id, job_id, amount_kobo) VALUES ($1,$2,500000)`, [pid, `job-${randomUUID()}`]);
    await call('GET', '/v1/provider/tier', uid); // lazily checks refunds
    assert.equal(await walletService.getBalance(uid), 300_000, 'fee refunded as wallet credit');
    await call('GET', '/v1/provider/tier', uid);
    assert.equal(await walletService.getBalance(uid), 300_000, 'refunded once');
  });

  it('opens a PSP checkout when the wallet is short; rejection refunds to the wallet', async () => {
    const { uid, pid } = await pro();
    await meetTier2(pid, uid);
    const res = await call('POST', '/v1/provider/tier/apply', uid, { targetTier: 2 });
    assert.equal(res.statusCode, 200, res.body);
    const d = res.json().data;
    assert.equal(d.status, 'pending_payment');
    assert.equal(d.payment.method, 'checkout');
    assert.ok(String(d.payment.checkoutUrl).startsWith('https://pay.test/'));
    assert.ok(String(d.payment.reference).startsWith('tier_'));
    const pay = await q<{ amount_kobo: string }>(`SELECT amount_kobo FROM payment.payment WHERE reference=$1`, [d.payment.reference]);
    assert.equal(Number(pay[0].amount_kobo), 250_000, 'server-set amount');

    assert.equal(await tierService.onCheckoutPaid(d.payment.reference, 1n), false, 'wrong amount never marks it paid');
    assert.equal(await tierService.onCheckoutPaid(d.payment.reference, 250_000n), true);
    const view = (await call('GET', '/v1/provider/tier', uid)).json().data;
    assert.equal(view.application.status, 'under_review');

    const adm = await admin();
    const noReason = await call('POST', `/v1/admin/tier-applications/${d.applicationId}/reject`, adm, {});
    assert.equal(noReason.statusCode, 400);
    const rej = await call('POST', `/v1/admin/tier-applications/${d.applicationId}/reject`, adm, { reason: 'Utility bill is not in your name' });
    assert.equal(rej.statusCode, 200, rej.body);
    assert.equal(await walletService.getBalance(uid), 250_000, 'rejection refunds the fee to the wallet');
    const v2 = (await call('GET', '/v1/provider/tier', uid)).json().data;
    assert.equal(v2.tier, 1);
    assert.equal(v2.application.status, 'rejected');
    assert.equal(v2.application.reason, 'Utility bill is not in your name');
  });
});

describe('enforcement', () => {
  it('blocks accepting a job above the Tier 1 cap', async () => {
    const { uid, pid } = await pro();
    const customer = await user('CUSTOMER', 'Ngozi');
    const mk = async (agreed: number) => {
      const r = await q<{ id: string }>(
        `INSERT INTO booking.service_request (user_id, category_id, title, idempotency_key, status, agreed_kobo, lat, lng) VALUES ($1,'cleaning','Deep clean',$2,'OFFERED',$3,6.5,3.4) RETURNING id`,
        [customer, randomUUID(), agreed],
      );
      return String((await q<{ id: string }>(`INSERT INTO booking.request_offer (request_id, provider_id) VALUES ($1,$2) RETURNING id`, [r[0].id, pid]))[0].id);
    };
    const bigOffer = await mk(6_000_000);
    const res = await call('POST', `/v1/provider/requests/${bigOffer}/respond`, uid, { accept: true });
    assert.equal(res.statusCode, 403, res.body);
    assert.match(res.json().error.message, /job_cap/);

    const counter = await call('POST', `/v1/provider/requests/${await mk(1_000_000)}/respond`, uid, { counterKobo: '9000000' });
    assert.equal(counter.statusCode, 403, 'a counter-price above the cap is refused too');

    assert.equal(await eligibility.allowed(pid, 'cleaning', { amountKobo: 4_000_000n }), true);
    assert.equal(await eligibility.allowed(pid, 'cleaning', { amountKobo: 6_000_000n }), false);
  });

  it('enforces the open-job limit of the tier', async () => {
    const { pid } = await pro();
    const customer = await user('CUSTOMER', 'Emeka');
    for (let i = 0; i < 3; i++) {
      const b = await q<{ id: string }>(
        `INSERT INTO booking.booking (user_id, service_id, status, price_kobo, price_snapshot, idempotency_key) VALUES ($1,'cleaning','IN_PROGRESS',1000000,'{}',$2) RETURNING id`,
        [customer, randomUUID()],
      );
      await q(`INSERT INTO dispatch.assignment (job_id, provider_id, status) VALUES ($1,$2,'accepted')`, [String(b[0].id), pid]);
    }
    const e = await eligibility.evaluate(pid, 'cleaning');
    assert.ok(e.missing.includes('capacity'), 'Tier 1: 3 open jobs at a time');
    await call('POST', `/v1/admin/providers/${pid}/tier`, await admin(), { tier: 2, reason: 'Known agency partner' });
    assert.ok(!(await eligibility.evaluate(pid, 'cleaning')).missing.includes('capacity'), 'Tier 2 allows 10');
  });

  it('locks trades above the provider tier', async () => {
    const { pid } = await pro();
    assert.ok((await eligibility.evaluate(pid, 'home-care')).missing.includes('kyc_tier_3'));
    assert.ok((await eligibility.evaluate(pid, 'solar-inverter')).missing.includes('kyc_tier_2'));
    assert.ok(!(await eligibility.evaluate(pid, 'cleaning')).missing.some((m) => m.startsWith('kyc_tier')));
    await call('POST', `/v1/admin/providers/${pid}/tier`, await admin(), { tier: 3, reason: 'Licensed care agency, documents checked' });
    assert.ok(!(await eligibility.evaluate(pid, 'home-care')).missing.includes('kyc_tier_3'));
  });

  it('caps active product listings by tier', async () => {
    const { pid } = await pro();
    for (let i = 0; i < 10; i++) {
      await q(`INSERT INTO provider.offering (provider_id, category_id, name, price_kobo, price_unit, kind) VALUES ($1,'prod-cleaning-supplies',$2,150000,'item','product')`, [pid, `Soap ${i}`]);
    }
    await assert.rejects(() => offerings.checkListingCap(pid), /LISTING_LIMIT:10/);
  });
});

describe('Kendibo Pro subscription', () => {
  it('needs Tier 2, starts from the wallet, lowers commission, cancels at period end and expires', async () => {
    const { uid, pid } = await pro();
    const low = await call('POST', '/v1/provider/subscription', uid, { plan: 'pro_monthly' });
    assert.equal(low.statusCode, 409, low.body);
    assert.equal(low.json().error.code, 'TIER_TOO_LOW');

    await call('POST', `/v1/admin/providers/${pid}/tier`, await admin(), { tier: 2, reason: 'Verified in person' });
    await walletService.credit(uid, 300_000, `wt_${uid}_pro`, 'topup');
    const res = await call('POST', '/v1/provider/subscription', uid, { plan: 'pro_monthly' });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json().data.payment, { method: 'wallet', paid: true });
    assert.equal(await walletService.getBalance(uid), 0);

    let v = (await call('GET', '/v1/provider/tier', uid)).json().data;
    assert.equal(v.subscription.active, true);
    assert.ok(v.subscription.renewsAt);
    assert.equal(v.limits.commissionBps, 1200, '15% -> 12% with Pro');
    assert.equal(await tierService.commissionBpsFor(pid, 1500), 1200);

    const cancel = await call('DELETE', '/v1/provider/subscription', uid);
    assert.equal(cancel.statusCode, 200, cancel.body);
    v = (await call('GET', '/v1/provider/tier', uid)).json().data;
    assert.equal(v.subscription.active, true, 'stays on until the period ends');
    assert.equal(v.subscription.renewsAt, null);

    await q(`UPDATE provider.subscription SET current_period_end=$2 WHERE provider_id=$1`, [pid, new Date(Date.now() - 1000).toISOString()]);
    v = (await call('GET', '/v1/provider/tier', uid)).json().data;
    assert.equal(v.subscription.active, false);
    assert.equal(v.limits.commissionBps, 1500);
    const kinds = (await q<{ kind: string }>(`SELECT kind FROM provider.subscription_event WHERE provider_id=$1 ORDER BY created_at`, [pid])).map((r) => r.kind);
    assert.deepEqual([...kinds].sort(), ['cancel', 'expire', 'start']);
  });

  it('renews from the wallet at period end, and expires when the wallet is short', async () => {
    const { uid, pid } = await pro();
    await call('POST', `/v1/admin/providers/${pid}/tier`, await admin(), { tier: 2, reason: 'Verified in person' });
    await walletService.credit(uid, 600_000, `wt_${uid}_two`, 'topup');
    assert.equal((await call('POST', '/v1/provider/subscription', uid, { plan: 'pro_monthly' })).statusCode, 200);
    await q(`UPDATE provider.subscription SET current_period_end=$2 WHERE provider_id=$1`, [pid, new Date(Date.now() - 1000).toISOString()]);
    let v = (await call('GET', '/v1/provider/tier', uid)).json().data;
    assert.equal(v.subscription.active, true, 'renewed');
    assert.equal(await walletService.getBalance(uid), 0);
    await q(`UPDATE provider.subscription SET current_period_end=$2 WHERE provider_id=$1`, [pid, new Date(Date.now() - 1000).toISOString()]);
    v = (await call('GET', '/v1/provider/tier', uid)).json().data;
    assert.equal(v.subscription.active, false, 'no balance: expired');
    const kinds = (await q<{ kind: string }>(`SELECT kind FROM provider.subscription_event WHERE provider_id=$1 ORDER BY created_at`, [pid])).map((r) => r.kind);
    assert.deepEqual([...kinds].sort(), ['expire', 'renew', 'start']);
  });
});

describe('admin tier changes', () => {
  it('sets / downgrades a tier with a reason, audit-logged; admins only', async () => {
    const { uid, pid } = await pro();
    const adm = await admin();
    assert.equal((await call('POST', `/v1/admin/providers/${pid}/tier`, uid, { tier: 3, reason: 'self-promote' })).statusCode, 403);
    assert.equal((await call('POST', `/v1/admin/providers/${pid}/tier`, adm, { tier: 2 })).statusCode, 400, 'reason required');
    assert.equal((await call('POST', `/v1/admin/providers/${pid}/tier`, adm, { tier: 3, reason: 'Registered business, site visit done' })).statusCode, 200);
    assert.equal((await call('GET', '/v1/provider/tier', uid)).json().data.tier, 3);
    const down = await call('POST', `/v1/admin/providers/${pid}/tier`, adm, { tier: 1, reason: 'Two no-shows this month' });
    assert.equal(down.statusCode, 200, down.body);
    assert.equal(down.json().data.tier, 1);
    const v = (await call('GET', '/v1/provider/tier', uid)).json().data;
    assert.equal(v.tier, 1);
    assert.equal(v.limits.maxJobKobo, '5000000');
    const logs = await q<{ reason: string }>(`SELECT reason FROM audit.log WHERE action='provider.tier.set' AND entity_id=$1 ORDER BY created_at`, [pid]);
    assert.deepEqual(logs.map((l) => l.reason), ['Registered business, site visit done', 'Two no-shows this month']);
  });
});

// ── Tier config in the database (admin editable) ─────────────────────────────
describe('tier config in the database', () => {
  it('migration 060 seeded the full default config; GET returns config, defaults and metadata', async () => {
    const sa = await user('SUPER_ADMIN', 'Root Admin');
    assert.equal((await app.inject({ method: 'GET', url: '/v1/admin/settings/tiers', remoteAddress: ip() })).statusCode, 401);
    assert.equal((await call('GET', '/v1/admin/settings/tiers', await user('PROVIDER'))).statusCode, 403);
    const res = await call('GET', '/v1/admin/settings/tiers', sa);
    assert.equal(res.statusCode, 200, res.body);
    const d = res.json().data;
    assert.deepEqual(d.config, d.defaults, 'seed equals the built-in defaults');
    assert.equal(d.config.tiers['1'].maxJobKobo, '5000000');
    assert.equal(d.config.tiers['3'].maxJobKobo, null);
    assert.equal(d.config.upgradeFeeKobo['3'].business, '2000000');
    assert.equal(d.config.pro.priceKobo, '300000');
    assert.ok('updatedAt' in d && 'updatedBy' in d);
  });

  it('PUT validates, saves, audit-logs before/after and takes effect immediately', async () => {
    const sa = await user('SUPER_ADMIN', 'Root Admin');
    const cur = (await call('GET', '/v1/admin/settings/tiers', sa)).json().data.config;
    const bad = await call('PUT', '/v1/admin/settings/tiers', sa, { ...cur, standardCommissionBps: 20000, pro: { ...cur.pro, priceKobo: '12.5', benefits: new Array(11).fill('x') } });
    assert.equal(bad.statusCode, 400, bad.body);
    assert.equal(bad.json().error.code, 'VALIDATION_ERROR');
    assert.ok(bad.json().error.fields.standardCommissionBps);
    assert.ok(bad.json().error.fields['pro.priceKobo']);
    assert.ok(bad.json().error.fields['pro.benefits']);
    assert.equal((await call('PUT', '/v1/admin/settings/tiers', await user('PROVIDER'), cur)).statusCode, 403);

    const next = { ...cur, pro: { ...cur.pro, priceKobo: '350000' }, upgradeFeeKobo: { ...cur.upgradeFeeKobo, '2': '300000' } };
    const ok = await call('PUT', '/v1/admin/settings/tiers', sa, next);
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().data.config.pro.priceKobo, '350000');
    const { uid } = await pro();
    const v = (await call('GET', '/v1/provider/tier', uid)).json().data;
    assert.equal(v.next.feeKobo, '300000');
    assert.equal(v.subscription.priceKobo, '350000');
    const logs = await q<{ meta: unknown }>(`SELECT meta FROM audit.log WHERE action='settings.tiers.update' AND actor=$1`, [sa]);
    assert.equal(logs.length, 1);
    const meta = (typeof logs[0].meta === 'string' ? JSON.parse(logs[0].meta) : logs[0].meta) as any;
    assert.equal(meta.before.pro.priceKobo, '300000');
    assert.equal(meta.after.pro.priceKobo, '350000');
    const g = (await call('GET', '/v1/admin/settings/tiers', sa)).json().data;
    assert.ok(g.updatedAt);
    assert.equal(g.updatedBy, sa);
    // restore defaults for the other tests
    assert.equal((await call('PUT', '/v1/admin/settings/tiers', sa, cur)).statusCode, 200);
  });

  it('falls back to the code defaults (with a warning) when the row is missing or invalid', async () => {
    const { tierConfig, resetTierConfigCache, DEFAULT_TIER_CONFIG } = await import('../modules/tiers/tier.config.js');
    const saved = (await q<{ value: unknown }>(`SELECT value FROM configuration.platform_setting WHERE key='tiers.config'`))[0].value;
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => { warns.push(a.join(' ')); };
    try {
      await q(`UPDATE configuration.platform_setting SET value='{"pro":{"priceKobo":"abc"}}'::jsonb WHERE key='tiers.config'`);
      resetTierConfigCache();
      assert.equal((await tierConfig()).pro.priceKobo, DEFAULT_TIER_CONFIG.pro.priceKobo);
      await q(`DELETE FROM configuration.platform_setting WHERE key='tiers.config'`);
      resetTierConfigCache();
      assert.equal((await tierConfig()).upgradeFeeKobo[2], DEFAULT_TIER_CONFIG.upgradeFeeKobo[2]);
    } finally {
      console.warn = orig;
      await q(`DELETE FROM configuration.platform_setting WHERE key='tiers.config'`);
      await q(`INSERT INTO configuration.platform_setting (key, value) VALUES ('tiers.config', $1::jsonb)`, [typeof saved === 'string' ? saved : JSON.stringify(saved)]);
      resetTierConfigCache();
    }
    assert.equal(warns.filter((w) => w.includes('[tiers]')).length, 2);
  });
});

// ── Provider tier view: everything the app used to hardcode ──────────────────
describe('GET /v1/provider/tier extras', () => {
  it('sends accountType, next details, subscription extras and references', async () => {
    const { uid } = await pro({ accountType: 'business' });
    await call('POST', '/v1/provider/tier/references', uid, { name: 'Mama Tee', phone: '08030001111' });
    const v = (await call('GET', '/v1/provider/tier', uid)).json().data;
    assert.equal(v.accountType, 'business');
    assert.equal(v.next.name, 'Verified');
    assert.equal(v.next.refundAfterJobs, 3);
    assert.equal(v.next.limits.maxJobKobo, '50000000');
    assert.equal(v.next.limits.payoutHoldHours, 24);
    assert.equal(v.subscription.cancelAtPeriodEnd, false);
    assert.equal(v.subscription.periodDays, 30);
    assert.equal(v.subscription.minTier, 2);
    assert.equal(v.references.length, 1);
    assert.deepEqual(Object.keys(v.references[0]).sort(), ['id', 'kind', 'name', 'status']);
  });

  it('shows refundedKobo on a rejected, refunded application and notifies the provider', async () => {
    const { uid, pid } = await pro();
    await meetTier2(pid, uid);
    await walletService.credit(uid, 250_000, `wt_${uid}_rf`, 'topup');
    const ap = await call('POST', '/v1/provider/tier/apply', uid, { targetTier: 2 });
    assert.equal(ap.statusCode, 200, ap.body);
    const id = ap.json().data.applicationId;
    const rj = await call('POST', `/v1/admin/tier-applications/${id}/reject`, await admin(), { reason: 'Blurry photos' });
    assert.equal(rj.statusCode, 200, rj.body);
    const v = (await call('GET', '/v1/provider/tier', uid)).json().data;
    assert.equal(v.application.status, 'rejected');
    assert.equal(v.application.refundedKobo, '250000');
    const inbox = await q<{ body: string }>(`SELECT body FROM notification.notification WHERE recipient_id=$1 AND template='tier.application_rejected'`, [uid]);
    assert.ok(inbox.length >= 1, 'provider notified');
    assert.match(String(inbox[0].body), /Blurry photos/);
  });

  it('tells the provider on approval', async () => {
    const { uid, pid } = await pro();
    await meetTier2(pid, uid);
    await walletService.credit(uid, 250_000, `wt_${uid}_ap`, 'topup');
    const ap = await call('POST', '/v1/provider/tier/apply', uid, { targetTier: 2 });
    const ok = await call('POST', `/v1/admin/tier-applications/${ap.json().data.applicationId}/approve`, await admin());
    assert.equal(ok.statusCode, 200, ok.body);
    const n = await q(`SELECT 1 FROM notification.notification WHERE recipient_id=$1 AND template='tier.application_approved'`, [uid]);
    assert.ok(n.length >= 1);
  });
});

describe('apply prices by account type', () => {
  it('derives the price kind from the account and ignores a client-sent businessKind', async () => {
    const { uid, pid } = await pro({ accountType: 'individual' });
    await meetTier2(pid, uid);
    await q(`UPDATE provider.provider SET office_address='1 Shop Rd', cac_number='RC123' WHERE id=$1`, [pid]);
    await q(`UPDATE provider.provider SET tier=2 WHERE id=$1`, [pid]);
    for (let i = 0; i < 10; i++) {
      await q(`INSERT INTO provider.earning (provider_id, job_id, amount_kobo) VALUES ($1,$2,1000)`, [pid, `job-${randomUUID()}`]);
    }
    for (let i = 0; i < 10; i++) await q(`INSERT INTO payment.review (booking_id, provider_id, provider, quality, punctuality, professionalism, result) VALUES ($1,$2,5,5,5,5,5)`, [randomUUID(), pid]);
    const res = await call('POST', '/v1/provider/tier/apply', uid, { targetTier: 3, businessKind: 'business' });
    assert.equal(res.statusCode, 200, res.body);
    const row = (await q<{ fee_kobo: string; business_kind: string }>(`SELECT fee_kobo, business_kind FROM provider.tier_application WHERE id=$1`, [res.json().data.applicationId]))[0];
    assert.equal(row.business_kind, 'individual');
    assert.equal(String(row.fee_kobo), '1000000', 'individual Tier 3 fee, not the business one');
  });
});

// ── Pro for Tier 3, renewal race, reads without side effects ────────────────
describe('Kendibo Pro and Tier 3', () => {
  it('409 INCLUDED_BY_TIER for Tier 3', async () => {
    const { uid, pid } = await pro();
    await call('POST', `/v1/admin/providers/${pid}/tier`, await admin(), { tier: 3, reason: 'Registered business' });
    const res = await call('POST', '/v1/provider/subscription', uid, { plan: 'pro_monthly' });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().error.code, 'INCLUDED_BY_TIER');
  });

  it('does not charge a Tier 3 provider at renewal: expires as included_by_tier', async () => {
    const { uid, pid } = await pro();
    const adm = await admin();
    await call('POST', `/v1/admin/providers/${pid}/tier`, adm, { tier: 2, reason: 'Verified' });
    await walletService.credit(uid, 900_000, `wt_${uid}_t3`, 'topup');
    assert.equal((await call('POST', '/v1/provider/subscription', uid, { plan: 'pro_monthly' })).statusCode, 200);
    const balance = await walletService.getBalance(uid);
    await call('POST', `/v1/admin/providers/${pid}/tier`, adm, { tier: 3, reason: 'Upgraded' });
    await q(`UPDATE provider.subscription SET current_period_end=$2 WHERE provider_id=$1`, [pid, new Date(Date.now() - 1000).toISOString()]);
    await tierService.refreshSubscription(pid);
    assert.equal(await walletService.getBalance(uid), balance, 'no debit');
    const sub = (await q<{ status: string }>(`SELECT status FROM provider.subscription WHERE provider_id=$1`, [pid]))[0];
    assert.equal(sub.status, 'expired');
    const inbox = await q<{ body: string }>(`SELECT body FROM notification.notification WHERE recipient_id=$1 AND template='tier.pro_expired'`, [uid]);
    assert.ok(inbox.length >= 1);
    assert.match(String(inbox[0].body), /included with your Tier 3/);
  });

  it('concurrent renewals debit and extend once (activation is compare-and-set)', async () => {
    const { uid, pid } = await pro();
    await call('POST', `/v1/admin/providers/${pid}/tier`, await admin(), { tier: 2, reason: 'Verified' });
    await walletService.credit(uid, 900_000, `wt_${uid}_race`, 'topup');
    assert.equal((await call('POST', '/v1/provider/subscription', uid, { plan: 'pro_monthly' })).statusCode, 200);
    assert.equal(await walletService.getBalance(uid), 600_000);
    await q(`UPDATE provider.subscription SET current_period_end=$2 WHERE provider_id=$1`, [pid, new Date(Date.now() - 1000).toISOString()]);
    await Promise.all([tierService.refreshSubscription(pid), tierService.refreshSubscription(pid), tierService.refreshSubscription(pid)]);
    assert.equal(await walletService.getBalance(uid), 300_000, 'one debit');
    const sub = (await q<{ periods: number; current_period_end: string }>(`SELECT periods, current_period_end FROM provider.subscription WHERE provider_id=$1`, [pid]))[0];
    assert.equal(Number(sub.periods), 2);
    const days = (new Date(String(sub.current_period_end)).getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 29 && days < 31, `extended once (${days.toFixed(1)}d)`);
    const renews = await q(`SELECT 1 FROM provider.subscription_event WHERE provider_id=$1 AND kind='renew'`, [pid]);
    assert.equal(renews.length, 1);
    // A duplicate activation of a settled period is a no-op.
    const sid = String((await q<{ id: string }>(`SELECT id FROM provider.subscription WHERE provider_id=$1`, [pid]))[0].id);
    assert.equal(await tierService.activate(sid, 'dup', 300_000n), null);
  });

  it('snapshot() has no side effects; the sweeper expires lapsed periods and reminds once per period', async () => {
    const { uid, pid } = await pro();
    await call('POST', `/v1/admin/providers/${pid}/tier`, await admin(), { tier: 2, reason: 'Verified' });
    await walletService.credit(uid, 300_000, `wt_${uid}_sw`, 'topup');
    assert.equal((await call('POST', '/v1/provider/subscription', uid, { plan: 'pro_monthly' })).statusCode, 200);
    await q(`UPDATE provider.subscription SET current_period_end=$2 WHERE provider_id=$1`, [pid, new Date(Date.now() - 1000).toISOString()]);
    await tierService.snapshot(pid);
    const mid = (await q<{ status: string; periods: number }>(`SELECT status, periods FROM provider.subscription WHERE provider_id=$1`, [pid]))[0];
    assert.equal(mid.status, 'active');
    assert.equal(Number(mid.periods), 1);
    await tierService.sweepSubscriptions();
    assert.equal((await q<{ status: string }>(`SELECT status FROM provider.subscription WHERE provider_id=$1`, [pid]))[0].status, 'expired');

    const b = await pro();
    await call('POST', `/v1/admin/providers/${b.pid}/tier`, await admin(), { tier: 2, reason: 'Verified' });
    await walletService.credit(b.uid, 300_000, `wt_${b.uid}_sw`, 'topup');
    assert.equal((await call('POST', '/v1/provider/subscription', b.uid, { plan: 'pro_monthly' })).statusCode, 200);
    await q(`UPDATE provider.subscription SET current_period_end=$2 WHERE provider_id=$1`, [b.pid, new Date(Date.now() + 2 * 86_400_000).toISOString()]);
    const r1 = await tierService.sweepSubscriptions();
    const r2 = await tierService.sweepSubscriptions();
    assert.ok(r1.reminded >= 1);
    assert.equal(r2.reminded, 0, 'once per period');
    const n = await q(`SELECT 1 FROM notification.notification WHERE recipient_id=$1 AND template='tier.pro_renewal_reminder' AND channel='inapp'`, [b.uid]);
    assert.equal(n.length, 1);
  });
});

describe('tier/sub checkout status for the provider', () => {
  it('GET /v1/payments/:reference is visible to the owning provider only', async () => {
    const { uid, pid } = await pro();
    await meetTier2(pid, uid);
    const ap = await call('POST', '/v1/provider/tier/apply', uid, { targetTier: 2 }); // empty wallet -> checkout
    assert.equal(ap.statusCode, 200, ap.body);
    const reference = ap.json().data.payment.reference;
    assert.match(reference, /^tier_/);
    const mine = await call('GET', `/v1/payments/${reference}`, uid);
    assert.equal(mine.statusCode, 200, mine.body);
    assert.equal(mine.json().data.reference, reference);
    assert.ok(['pending', 'successful', 'failed'].includes(mine.json().data.status));
    assert.equal((await call('GET', `/v1/payments/${reference}`, await user('PROVIDER'))).statusCode, 404);
  });
});

describe('error handler', () => {
  it('hides driver details on 5xx in production only', async () => {
    const { errorBody } = await import('../apps/api/src/safe-error.js');
    const pgErr = Object.assign(new Error('password authentication failed for user "x"'), { code: '28P01', statusCode: 500 });
    assert.deepEqual(errorBody(500, pgErr, true), { statusCode: 500, error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
    assert.equal(errorBody(500, pgErr, false), pgErr);
    const e4 = Object.assign(new Error('Bad'), { statusCode: 404 });
    assert.equal(errorBody(404, e4, true), e4, '4xx unchanged');
  });
});
