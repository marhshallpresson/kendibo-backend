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
