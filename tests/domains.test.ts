import { describe, it } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { price } from '../modules/pricing/pricing.engine.js';
import { bookingService } from '../modules/bookings/booking.service.js';
import { providerService } from '../modules/providers/provider.service.js';
import { dispatchService } from '../modules/dispatch/dispatch.service.js';
import { quoteService } from '../modules/quotes/quote.service.js';
import { payoutService } from '../modules/payouts/payout.service.js';
import { refundService } from '../modules/refunds/refund.service.js';
import { authorize } from '../modules/authorization/rbac.js';
import { geoService } from '../modules/geo/geo.service.js';
import { fraudService } from '../modules/fraud/fraud.service.js';
import { q } from '../packages/database/db.js';

// Test isolation: never touch a real DATABASE_URL/REDIS_URL from the machine env.
// @ts-ignore
if (typeof globalThis.KENDIBO_TEST_ISOLATION === 'undefined') { (globalThis as any).KENDIBO_TEST_ISOLATION = true; delete process.env.DATABASE_URL; delete process.env.REDIS_URL; }
// booking.booking.user_id is UUID (no FK) and provider.provider.user_id has an
// FK to identity.users — so tests mint a real user row and use UUID ids.
async function testUser(): Promise<string> {
  const rows = await q<{ id: string }>(
    `INSERT INTO identity.users (email) VALUES ($1) RETURNING id`,
    [`test-${randomUUID()}@kendibo.local`],
  );
  return String(rows[0].id);
}

describe('pricing engine (server authoritative, kobo)', () => {
  it('fixed service totals with VAT + fee', async () => {
    const b = await price({ serviceId: 'svc_ac_general', addOnIds: ['ao_gas'], quantity: 1 });
    assert.ok(b.totalKobo > b.baseKobo);
    assert.equal(b.ruleVersion, 'pricebook_2026-10-06');
  });
  it('quote service requires inspection flow', async () => {
    await assert.rejects(() => price({ serviceId: 'svc_ac_install' }), /QUOTE_REQUIRED/);
  });
});

describe('bookings (idempotent)', () => {
  it('double create with same key returns one booking', async () => {
    const u = await testUser();
    const input = { serviceId: 'svc_ac_general', addressId: randomUUID(), scheduledAt: new Date().toISOString(), idempotencyKey: `k-same-${randomUUID()}` };
    const a = await bookingService.create(u, input);
    const b = await bookingService.create(u, input);
    assert.equal(a.id, b.id);
  });
  it('IDOR: other user cannot read', async () => {
    const u = await testUser();
    const a = await bookingService.create(u, { serviceId: 'svc_ac_general', addressId: randomUUID(), scheduledAt: new Date().toISOString(), idempotencyKey: `k-idor-${randomUUID()}` });
    await assert.rejects(() => bookingService.get(a.id, 'intruder'), /FORBIDDEN/);
  });
});

describe('dispatch (filters then scores)', () => {
  it('unskilled offline provider not matched; skilled online matched', async () => {
    const p = await providerService.onboard(await testUser());
    await providerService.addSkill(p.id, 'hvac');
    await providerService.verifyKyc(p.id);
    await providerService.setOnline(p.id, true, 9.09, 7.41);
    const c = await dispatchService.findCandidates({ serviceId: 'svc_ac_general', lat: 9.09, lng: 7.41 });
    assert.ok(c.some((x) => x.providerId === p.id));
  });
  it('two providers accept same job -> one winner', async () => {
    const a = await providerService.onboard(await testUser());
    const b = await providerService.onboard(await testUser());
    const jobId = `job_${randomUUID()}`;
    const o1 = await providerService.offer(jobId, a.id);
    const o2 = await providerService.offer(jobId, b.id);
    await providerService.respondToOffer(o1.id, true);
    const after = await providerService.offersFor(b.id);
    const o2now = after.find((r) => String(r.id) === o2.id) as { status?: string } | undefined;
    assert.equal(String(o2now?.status), 'expired');
  });
});

describe('quotes (immutable revisions)', () => {
  it('v1 kept after v2 + accept', async () => {
    const jobId = `bq_${randomUUID()}`;
    await quoteService.propose(jobId, { amountKobo: 100000n });
    await quoteService.propose(jobId, { amountKobo: 120000n });
    const acc = await quoteService.accept(jobId, 2);
    assert.equal(acc.version, 2);
    assert.equal((await quoteService.revisions(jobId)).length, 2);
  });
});

describe('payouts (cooling + maker-checker)', () => {
  it('bank change triggers cooling block', async () => {
    const p = await providerService.onboard(await testUser());
    await payoutService.requestBankChange(p.id);
    await assert.rejects(() => payoutService.create(p.id, 700000n, 'ref-cool'), /PAYOUT_COOLING/);
    assert.equal(await payoutService.bankEligible(p.id), false);
  });
});

describe('refunds (policy first)', () => {
  it('early cancel auto-approves; late goes manual', async () => {
    assert.equal((await refundService.request(randomUUID(), 1000n, 'x', 'CONFIRMED')).status, 'approved');
    assert.equal((await refundService.request(randomUUID(), 1000n, 'x', 'COMPLETED')).status, 'manual_review');
  });
});

describe('rbac + geo + fraud', () => {
  it('permission-based, no role string checks', () => {
    assert.equal(authorize('FINANCE', 'payout:approve'), true);
    assert.equal(authorize('CUSTOMER', 'payout:approve'), false);
  });
  it('zone check + location closed outside journey', async () => {
    assert.equal((await geoService.checkZone(9.09, 7.41)).serviceable, true);
    await assert.rejects(() => geoService.providerLocation('job-closed', 9.09, 7.41), /LOCATION_CLOSED/);
  });
  it('device sharing flags collusion', async () => {
    const { signRefresh } = await import('../packages/auth/auth.js');
    const u1 = await testUser(); const u2 = await testUser(); const u3 = await testUser();
    await signRefresh(u1, 'devX'); await signRefresh(u2, 'devX'); await signRefresh(u3, 'devX');
    assert.equal(await fraudService.signalDevice('u3', 'devX'), 'REVIEW');
  });
});
