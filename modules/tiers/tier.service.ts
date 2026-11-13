// Provider / vendor tiers — what a pro has proved, what that unlocks, and the
// paid upgrade + "Kendibo Pro" subscription flows.
//
//   Tier 1 Starter   contact (phone or email), NIN, selfie, >=1 trade, service area.
//                    Reached automatically. No documents or CAC needed.
//   Tier 2 Verified  + proof of address, 2+ portfolio photos, bank account in the
//                    same name (name match or BVN), 1 reference/guarantor.
//   Tier 3 Pro/Biz   + CAC (business) or trade certificate/licence (individual),
//                    workshop/office address, >=10 completed jobs at rating >=4.5,
//                    no open disputes.
// Tier 2 and 3 need an application (fee charged on apply, admin approves) or an
// admin decision. provider.tier holds what was granted; the effective tier is
// max(granted, auto Tier 1) — see effective().
//
// NIN in manual review (identity provider down/unfunded, kyc_pending_reason
// 'manual_verification'): counts as done for Tier 1, so the pro can finish
// onboarding, go online and take low-risk jobs, but the effective tier is
// capped at 1 (Tier 1 job cap, open-job limit and payout hold) until an admin
// clears the KYC. Their selfie must be on file (face check, or a 'selfie'
// document uploaded with POST /v1/provider/kyc) — the face match itself is
// waived only while the review is open.
//
// Limits and prices: modules/tiers/tier.config.ts. Enforcement (job caps,
// open jobs, locked trades, listing caps, payout hold) follows the vendor
// eligibility switch (production, or VENDOR_ELIGIBILITY_ENFORCED=true).
import { randomUUID } from 'node:crypto';
import { q } from '../../packages/database/db.js';
import { emit } from '../../packages/observability/emit.js';
import { walletService } from '../wallet/wallet.service.js';
import { auditService, type AuditContext } from '../audit/audit.service.js';
import { MANUAL_VERIFICATION } from '../kyc/kyc-availability.js';
import { tierConfig, upgradeFee, type BusinessKind, type TierConfig, type TierNo } from './tier.config.js';

export type ApplicationStatus = 'pending_payment' | 'under_review' | 'approved' | 'rejected';
export interface Requirement { key: string; label: string; tier: TierNo; done: boolean }
export interface TierLimits { maxJobKobo: string | null; maxOpenJobs: number | null; maxListings: number | null; payoutHoldHours: number; commissionBps: number }
export type TierPayment = { method: 'wallet'; paid: true } | { method: 'checkout'; checkoutUrl: string; reference: string };

/** What tier.service needs from PaymentService (passed in by the routes). */
export interface CheckoutPort {
  createCheckout(input: { bookingId: string; amountKobo: bigint; customerEmail?: string; customerName?: string; reference: string; idempotencyKey: string; metadata?: Record<string, string> }): Promise<{ checkoutUrl: string | null; reference: string }>;
}

export class TierError extends Error {
  constructor(public code: string, message: string, public status = 400, public missing: string[] = []) { super(message); }
}

/** Checkout references: settleSuccessfulPayment routes these prefixes here. */
export const TIER_REF_PREFIX = 'tier_';
export const SUB_REF_PREFIX = 'sub_';

const big = (v: unknown) => BigInt(String(v ?? 0).split('.')[0] || '0');
const ms = (v: unknown) => (v ? new Date(String(v)).getTime() : 0);
const str = (v: unknown) => (v == null ? null : String(v));

type Row = Record<string, unknown>;

async function providerRow(providerId: string): Promise<Row | null> {
  const r = await q<Row>(
    `SELECT p.*, u.phone AS user_phone, u.email AS user_email, u.name AS user_name
       FROM provider.provider p LEFT JOIN identity.users u ON u.id = p.user_id WHERE p.id=$1`, [providerId],
  );
  return r[0] ?? null;
}

const count = async (sql: string, params: unknown[]) => Number((await q<{ n: string }>(sql, params).catch(() => [{ n: '0' }]))[0]?.n ?? 0);

export function isManualReview(p: Row): boolean {
  return String(p.kyc_status ?? '').toUpperCase() === 'UNDER_REVIEW' && String(p.kyc_pending_reason ?? '') === MANUAL_VERIFICATION;
}

/** Every requirement for every tier, with whether it is met now. */
async function requirementsOf(p: Row, cfg: TierConfig): Promise<Requirement[]> {
  const id = String(p.id);
  const verified = String(p.kyc_status ?? '').toUpperCase() === 'VERIFIED';
  const manual = isManualReview(p);

  const selfieDocs = await count(`SELECT COUNT(*) AS n FROM kyc.submission_document WHERE provider_id=$1 AND kind='selfie'`, [id]);
  const faceChecks = await count(
    `SELECT COUNT(*) AS n FROM kyc.verification_check WHERE subject_type='provider' AND subject_id=$1 AND check_kind IN ('doc_face', 'face_liveness')`, [id],
  );
  const skills = await count(`SELECT COUNT(*) AS n FROM provider.skill WHERE provider_id=$1`, [id]);
  const enrolled = await count(`SELECT COUNT(*) AS n FROM provider.category_enrollment WHERE provider_id=$1`, [id]);
  const addressDocs = await count(`SELECT COUNT(*) AS n FROM kyc.submission_document WHERE provider_id=$1 AND kind='address'`, [id]);
  const addressChecks = await count(
    `SELECT COUNT(*) AS n FROM kyc.verification_check WHERE subject_type='provider' AND subject_id=$1 AND check_kind='address' AND status='passed'`, [id],
  );
  const photos = await count(`SELECT COUNT(*) AS n FROM provider.gallery WHERE provider_id=$1`, [id]);
  const refs = await count(`SELECT COUNT(*) AS n FROM provider.tier_reference WHERE provider_id=$1 AND status<>'rejected'`, [id]);
  const certs = await count(
    `SELECT COUNT(*) AS n FROM provider.credential WHERE provider_id=$1 AND kind IN ('certificate', 'licence') AND status IN ('submitted', 'approved')`, [id],
  );
  const completed = await count(`SELECT COUNT(*) AS n FROM provider.earning WHERE provider_id=$1`, [id]);
  const rating = await q<{ avg: string | null; n: string }>(
    `SELECT AVG(provider) AS avg, COUNT(*) AS n FROM payment.review WHERE provider_id=$1`, [id],
  ).catch(() => []);
  const avg = rating[0]?.avg != null ? Number(rating[0].avg) : null;
  const disputes = await count(
    `SELECT COUNT(*) AS n FROM payment.dispute d JOIN dispatch.assignment a ON a.job_id = d.job_id
      WHERE a.provider_id=$1 AND a.status='accepted' AND d.status IN ('open', 'review')`, [id],
  );

  const business = String(p.account_type ?? '') === 'business';
  return [
    { key: 'contact', label: 'Phone number or email', tier: 1, done: Boolean(p.user_phone || p.user_email) },
    { key: 'nin', label: 'NIN verified (or in manual review)', tier: 1, done: manual || (verified && Boolean(p.nin_masked || Number(p.kyc_tier ?? 0) >= 1)) },
    { key: 'selfie', label: 'Selfie', tier: 1, done: p.face_verified === true || selfieDocs > 0 || faceChecks > 0 },
    { key: 'service_category', label: 'At least one service category', tier: 1, done: Math.max(skills, enrolled) >= cfg.tier1.minCategories },
    { key: 'service_area', label: 'Service area', tier: 1, done: (p.lat != null && p.lng != null) || Boolean(p.office_city) },
    { key: 'proof_of_address', label: 'Proof of address (utility bill or address check)', tier: 2, done: addressDocs > 0 || addressChecks > 0 },
    { key: 'portfolio', label: `${cfg.tier2.minPortfolioPhotos}+ work photos`, tier: 2, done: photos >= cfg.tier2.minPortfolioPhotos },
    { key: 'bank_name_match', label: 'Bank account in your own name', tier: 2, done: Boolean(p.account_number) && (p.name_aligned === true || Boolean(p.bvn_masked)) },
    { key: 'reference', label: 'One reference or guarantor', tier: 2, done: refs >= cfg.tier2.minReferences },
    {
      key: 'cac_or_certificate', label: business ? 'CAC registration' : 'Trade certificate or licence (or CAC)', tier: 3,
      done: business ? Boolean(p.cac_verified === true || p.cac_number) : Boolean(certs > 0 || p.cac_verified === true || p.cac_number),
    },
    { key: 'workshop_address', label: 'Workshop or office address', tier: 3, done: Boolean(p.office_address || p.office_street) },
    { key: 'completed_jobs', label: `${cfg.tier3.minCompletedJobs}+ completed jobs`, tier: 3, done: completed >= cfg.tier3.minCompletedJobs },
    { key: 'rating', label: `Rating ${cfg.tier3.minRating}+`, tier: 3, done: avg !== null && avg >= cfg.tier3.minRating },
    { key: 'no_open_disputes', label: 'No open disputes', tier: 3, done: disputes === 0 },
  ];
}

export interface TierSnapshot {
  providerId: string; userId: string; row: Row;
  /** Effective tier; 0 = Tier 1 not complete yet (cannot take tiered work). */
  tier: 0 | TierNo;
  granted: number;
  manualReview: boolean;
  requirements: Requirement[];
  proActive: boolean;
  subscription: Row | null;
  cfg: TierConfig;
}

function effective(granted: number, tier1Done: boolean, manual: boolean, verified: boolean): 0 | TierNo {
  let t = Math.max(Math.min(Math.max(granted, 0), 3), tier1Done ? 1 : 0);
  if (manual && !verified) t = Math.min(t, 1);
  return t as 0 | TierNo;
}

async function currentSubscription(providerId: string): Promise<Row | null> {
  const r = await q<Row>(`SELECT * FROM provider.subscription WHERE provider_id=$1 ORDER BY created_at DESC LIMIT 5`, [providerId]);
  return r.find((s) => String(s.status) === 'active') ?? r.find((s) => String(s.status) === 'pending_payment') ?? r[0] ?? null;
}
const subActive = (s: Row | null) => Boolean(s && String(s.status) === 'active' && ms(s.current_period_end) > Date.now());

export function limitsFor(cfg: TierConfig, tier: 0 | TierNo, proActive: boolean): TierLimits {
  const d = cfg.tiers[tier === 0 ? 1 : tier];
  const base = d.commissionBps ?? cfg.standardCommissionBps;
  return {
    maxJobKobo: d.maxJobKobo === null ? null : d.maxJobKobo.toString(),
    maxOpenJobs: d.maxOpenJobs,
    maxListings: d.maxListings,
    payoutHoldHours: d.payoutHoldHours,
    commissionBps: proActive ? Math.min(base, cfg.pro.commissionBps) : base,
  };
}

export const tierService = {
  async snapshot(providerId: string): Promise<TierSnapshot> {
    const cfg = await tierConfig();
    const row = await providerRow(providerId);
    if (!row) throw new TierError('NOT_FOUND', 'Provider profile not found', 404);
    await this.refreshSubscription(providerId).catch(() => undefined);
    const requirements = await requirementsOf(row, cfg);
    const tier1Done = requirements.filter((r) => r.tier === 1).every((r) => r.done);
    const manual = isManualReview(row);
    const verified = String(row.kyc_status ?? '').toUpperCase() === 'VERIFIED';
    const granted = Number(row.tier ?? 0);
    const tier = effective(granted, tier1Done, manual, verified);
    const subscription = await currentSubscription(providerId);
    const proActive = tier === 3 || (tier >= cfg.pro.minTier && subActive(subscription));
    return { providerId, userId: String(row.user_id), row, tier, granted, manualReview: manual, requirements, proActive, subscription, cfg };
  },

  async effectiveTier(providerId: string): Promise<0 | TierNo> {
    return (await this.snapshot(providerId)).tier;
  },

  /** Tier 1 complete (manual-review NIN included)? Used by onboarding and going online. */
  async tier1Status(providerId: string): Promise<{ done: boolean; missing: string[]; manualReview: boolean }> {
    const s = await this.snapshot(providerId);
    const missing = s.requirements.filter((r) => r.tier === 1 && !r.done).map((r) => r.key);
    return { done: missing.length === 0 || s.granted >= 1, missing, manualReview: s.manualReview };
  },

  /** Price of a job/offer for the per-job cap: booking price, agreed/counter/quoted, proposed, budget. */
  async jobAmountKobo(ref: { bookingId?: string | null; assignmentId?: string | null; requestId?: string | null; requestOfferId?: string | null }): Promise<bigint | null> {
    if (ref.assignmentId) {
      const a = await q<{ job_id: string }>(`SELECT job_id FROM dispatch.assignment WHERE id=$1`, [ref.assignmentId]).catch(() => []);
      return a[0] ? this.jobAmountKobo({ bookingId: String(a[0].job_id) }) : null;
    }
    if (ref.bookingId) {
      const b = await q<{ price_kobo: string }>(`SELECT price_kobo FROM booking.booking WHERE id::text=$1`, [ref.bookingId]).catch(() => []);
      return b[0]?.price_kobo != null ? big(b[0].price_kobo) : null;
    }
    let requestId = ref.requestId ?? null;
    let offerKobo: bigint | null = null;
    if (ref.requestOfferId) {
      const o = await q<{ request_id: string; counter_kobo: string | null; quoted_kobo: string | null }>(
        `SELECT request_id, counter_kobo, quoted_kobo FROM booking.request_offer WHERE id=$1`, [ref.requestOfferId],
      ).catch(() => []);
      if (!o[0]) return null;
      requestId = String(o[0].request_id);
      offerKobo = o[0].counter_kobo != null ? big(o[0].counter_kobo) : o[0].quoted_kobo != null ? big(o[0].quoted_kobo) : null;
    }
    if (!requestId) return null;
    const r = await q<Record<string, unknown>>(
      `SELECT agreed_kobo, proposed_kobo, budget_kobo FROM booking.service_request WHERE id=$1`, [requestId],
    ).catch(() => []);
    if (!r[0]) return offerKobo;
    if (r[0].agreed_kobo != null) return big(r[0].agreed_kobo);
    if (offerKobo !== null) return offerKobo;
    if (r[0].proposed_kobo != null) return big(r[0].proposed_kobo);
    if (r[0].budget_kobo != null) return big(r[0].budget_kobo);
    return null;
  },

  /** Ranking points (0-100 dispatch scale) from tier and an active Pro subscription. */
  async rankBoost(providerId: string): Promise<number> {
    const s = await this.snapshot(providerId).catch(() => null);
    if (!s || s.tier === 0) return 0;
    const t = s.cfg.tiers[s.tier].rankBoost;
    return s.tier < 3 && s.proActive ? t + s.cfg.pro.rankBoost : t;
  },

  /** Commission for a settlement: the trade's rate, lowered for Pro / Tier 3. */
  async commissionBpsFor(providerId: string, categoryBps: number): Promise<number> {
    const s = await this.snapshot(providerId).catch(() => null);
    if (!s) return categoryBps;
    const d = s.tier === 0 ? null : s.cfg.tiers[s.tier].commissionBps;
    let bps = d !== null && d !== undefined ? Math.min(categoryBps, d) : categoryBps;
    if (s.proActive) bps = Math.min(bps, s.cfg.pro.commissionBps);
    return bps;
  },

  async payoutHoldHours(providerId: string): Promise<number> {
    const s = await this.snapshot(providerId).catch(() => null);
    if (!s) return 0;
    return s.cfg.tiers[s.tier === 0 ? 1 : s.tier].payoutHoldHours;
  },

  async maxListings(providerId: string): Promise<number | null> {
    const s = await this.snapshot(providerId);
    return s.cfg.tiers[s.tier === 0 ? 1 : s.tier].maxListings;
  },

  async addReference(providerId: string, input: { kind?: 'reference' | 'guarantor'; name: string; phone: string; relationship?: string }) {
    const r = await q<Row>(
      `INSERT INTO provider.tier_reference (provider_id, kind, name, phone, relationship) VALUES ($1,$2,$3,$4,$5) RETURNING id, kind, name, status, created_at`,
      [providerId, input.kind ?? 'reference', input.name.slice(0, 120), input.phone.slice(0, 32), input.relationship?.slice(0, 80) ?? null],
    );
    emit('provider.tier_reference_added', { providerId, kind: input.kind ?? 'reference' });
    return { id: String(r[0].id), kind: String(r[0].kind), name: String(r[0].name), status: String(r[0].status) };
  },

  /** GET /v1/provider/tier */
  async view(providerId: string) {
    await this.checkRefunds(providerId).catch(() => undefined);
    const s = await this.snapshot(providerId);
    const { cfg, tier } = s;
    const shown: TierNo = tier === 0 ? 1 : tier;
    const def = cfg.tiers[shown];
    const business = String(s.row.account_type ?? '') === 'business';
    const apps = await q<Row>(`SELECT * FROM provider.tier_application WHERE provider_id=$1 ORDER BY created_at DESC LIMIT 1`, [providerId]);
    const app = apps[0] ?? null;
    let next: { tier: TierNo; feeKobo: string; canApply: boolean; missing: string[] } | null = null;
    if (tier < 3) {
      const target = (tier <= 1 ? 2 : 3) as 2 | 3;
      const missing = s.requirements.filter((r) => r.tier <= target && !r.done && (tier === 0 || r.tier > 1)).map((r) => r.key);
      const reviewing = Boolean(app && String(app.status) === 'under_review');
      next = { tier: target, feeKobo: upgradeFee(cfg, target, business ? 'business' : 'individual').toString(), canApply: tier >= 1 && missing.length === 0 && !reviewing, missing };
    }
    const locked = await q<{ id: string; name: string; min_kyc_tier: number }>(
      `SELECT c.id, c.name, r.min_kyc_tier FROM catalog.category c JOIN catalog.category_rule r ON r.category_id = c.id
        WHERE c.active AND r.min_kyc_tier > $1 ORDER BY r.min_kyc_tier, c.name`, [tier],
    );
    const sub = s.subscription;
    const active = subActive(sub);
    return {
      tier: shown,
      /** Additive: false while Tier 1 is not complete (no tiered work yet). */
      active: tier >= 1,
      name: def.name,
      badge: shown === 3 && business && def.businessBadge ? def.businessBadge : def.badge,
      limits: limitsFor(cfg, tier, s.proActive),
      requirements: s.requirements,
      next,
      application: app ? {
        id: String(app.id), targetTier: Number(app.target_tier), status: String(app.status) as ApplicationStatus,
        ...(app.reason ? { reason: String(app.reason) } : {}),
      } : null,
      subscription: {
        active,
        renewsAt: active && sub && sub.cancel_at_period_end !== true ? new Date(String(sub.current_period_end)).toISOString() : null,
        /** Additive: last day of a cancelled (or running) period. */
        endsAt: active && sub ? new Date(String(sub.current_period_end)).toISOString() : null,
        /** Additive: Tier 3 gets the Pro perks without subscribing. */
        includedByTier: tier === 3,
        priceKobo: cfg.pro.priceKobo.toString(),
        benefits: cfg.pro.benefits,
      },
      lockedCategories: locked.map((c) => ({ id: String(c.id), name: String(c.name), minTier: Number(c.min_kyc_tier) })),
    };
  },

  /** Pay from the wallet when the balance covers it, else open a PSP checkout. */
  async charge(userId: string, amountKobo: bigint, reference: string, payments: CheckoutPort, email: string | null, name: string | null): Promise<TierPayment> {
    if (amountKobo <= 0n) return { method: 'wallet', paid: true };
    const balance = await walletService.getBalance(userId);
    if (BigInt(balance) >= amountKobo) {
      try {
        await walletService.debit(userId, Number(amountKobo), reference, 'payment');
        return { method: 'wallet', paid: true };
      } catch (e) {
        if ((e as Error).message !== 'INSUFFICIENT_FUNDS') throw e;
      }
    }
    let session: { checkoutUrl: string | null; reference: string };
    try {
      session = await payments.createCheckout({
        bookingId: 'wallet_topup', amountKobo, reference, idempotencyKey: reference,
        ...(email ? { customerEmail: email } : {}), ...(name ? { customerName: name } : {}),
        metadata: { purpose: reference.startsWith(SUB_REF_PREFIX) ? 'pro_subscription' : 'tier_upgrade' },
      });
    } catch {
      throw new TierError('PSP_UNAVAILABLE', 'Payment is unavailable right now. Top up your wallet or try again shortly.', 502);
    }
    if (!session.checkoutUrl) throw new TierError('PSP_UNAVAILABLE', 'Payment is unavailable right now.', 502);
    return { method: 'checkout', checkoutUrl: session.checkoutUrl, reference };
  },

  /** POST /v1/provider/tier/apply */
  async apply(providerId: string, targetTier: 2 | 3, businessKind: BusinessKind | undefined, payments: CheckoutPort) {
    const s = await this.snapshot(providerId);
    if (s.tier === 0) {
      throw new TierError('REQUIREMENTS_UNMET', 'Finish Tier 1 first.', 409,
        s.requirements.filter((r) => r.tier === 1 && !r.done).map((r) => r.key));
    }
    if (s.tier >= targetTier) throw new TierError('ALREADY_AT_TIER', `You are already at Tier ${s.tier}.`, 409);
    // Tier 3 builds on Tier 2: every Tier 2 and Tier 3 requirement must be met.
    const missing = s.requirements.filter((r) => r.tier <= targetTier && r.tier > 1 && !r.done).map((r) => r.key);
    if (missing.length) throw new TierError('REQUIREMENTS_UNMET', 'Some requirements are not met yet.', 409, missing);

    const kind: BusinessKind = businessKind ?? (String(s.row.account_type ?? '') === 'business' ? 'business' : 'individual');
    const fee = upgradeFee(s.cfg, targetTier, kind);

    const open = await q<Row>(
      `SELECT * FROM provider.tier_application WHERE provider_id=$1 AND status IN ('pending_payment', 'under_review') ORDER BY created_at DESC`, [providerId],
    );
    if (open.some((a) => String(a.status) === 'under_review')) throw new TierError('APPLICATION_OPEN', 'Your application is being reviewed.', 409);
    let app = open.find((a) => Number(a.target_tier) === targetTier && String(a.business_kind) === kind && big(a.fee_kobo) === fee) ?? null;
    // A different unpaid application is replaced by this one.
    for (const a of open) if (!app || String(a.id) !== String(app.id)) {
      await q(`UPDATE provider.tier_application SET status='rejected', reason='Replaced by a newer application', updated_at=now() WHERE id=$1 AND status='pending_payment'`, [a.id]);
    }
    if (!app) {
      const id = randomUUID();
      const ref = `${TIER_REF_PREFIX}${id}`;
      const rows = await q<Row>(
        `INSERT INTO provider.tier_application (id, provider_id, target_tier, business_kind, status, fee_kobo, payment_reference, requirements)
         VALUES ($1,$2,$3,$4,'pending_payment',$5,$6,$7) RETURNING *`,
        [id, providerId, targetTier, kind, fee.toString(), ref, JSON.stringify(s.requirements)],
      );
      app = rows[0];
    }
    const applicationId = String(app.id);
    const reference = String(app.payment_reference);
    const payment = await this.charge(s.userId, fee, reference, payments, str(s.row.user_email), str(s.row.user_name));
    if (payment.method === 'wallet') {
      await this.markPaid(applicationId, fee > 0n ? 'wallet' : 'none');
      return { applicationId, status: 'under_review' as ApplicationStatus, payment };
    }
    await q(`UPDATE provider.tier_application SET payment_method='checkout', updated_at=now() WHERE id=$1`, [applicationId]);
    return { applicationId, status: 'pending_payment' as ApplicationStatus, payment };
  },

  async markPaid(applicationId: string, method: 'wallet' | 'checkout' | 'none') {
    const rows = await q<Row>(
      `UPDATE provider.tier_application SET status='under_review', payment_method=$2, paid_at=now(), updated_at=now()
        WHERE id=$1 AND status='pending_payment' RETURNING *`, [applicationId, method],
    );
    if (rows[0]) {
      emit('provider.tier_application', {
        providerId: String(rows[0].provider_id), applicationId, targetTier: Number(rows[0].target_tier),
        feeKobo: String(rows[0].fee_kobo), method,
      });
    }
    return rows[0] ?? null;
  },

  /** A PSP checkout for a tier fee or a subscription settled (main.ts settleSuccessfulPayment). */
  // The caller runs this once per payment (first successful transition only),
  // so a checkout landing on something no longer awaiting payment (paid from
  // the wallet meanwhile, replaced, rejected) is a duplicate: it goes back to
  // the pro as wallet credit under a stable reference.
  async onCheckoutPaid(reference: string, amountKobo: bigint): Promise<boolean> {
    const giveBack = async (providerId: unknown) => {
      const prov = await q<{ user_id: string }>(`SELECT user_id FROM provider.provider WHERE id=$1`, [providerId]);
      if (prov[0]) await walletService.credit(String(prov[0].user_id), Number(amountKobo), `dup_${reference}`, 'refund');
      emit('provider.tier_payment_returned', { reference, amountKobo: amountKobo.toString() });
      return true;
    };
    if (reference.startsWith(TIER_REF_PREFIX)) {
      const a = await q<Row>(`SELECT * FROM provider.tier_application WHERE payment_reference=$1`, [reference]);
      if (!a[0]) return false;
      if (big(a[0].fee_kobo) !== amountKobo) { emit('provider.tier_payment_mismatch', { reference, amountKobo: amountKobo.toString() }); return false; }
      if (String(a[0].status) !== 'pending_payment') return giveBack(a[0].provider_id);
      return Boolean(await this.markPaid(String(a[0].id), 'checkout'));
    }
    if (reference.startsWith(SUB_REF_PREFIX)) {
      const s = await q<Row>(`SELECT * FROM provider.subscription WHERE payment_reference=$1`, [reference]);
      if (!s[0] || big(s[0].price_kobo) !== amountKobo) return false;
      if (String(s[0].status) !== 'pending_payment') return giveBack(s[0].provider_id);
      await this.activate(String(s[0].id), reference, amountKobo);
      return true;
    }
    return false;
  },

  async listApplications(status?: string, limit = 100) {
    const where = status ? `WHERE a.status=$1` : '';
    const rows = await q<Row>(
      `SELECT a.*, p.business_name, p.account_type, u.name AS user_name, u.phone AS user_phone
         FROM provider.tier_application a JOIN provider.provider p ON p.id = a.provider_id LEFT JOIN identity.users u ON u.id = p.user_id
         ${where} ORDER BY a.created_at DESC LIMIT ${Math.min(Math.max(limit, 1), 200)}`, status ? [status] : [],
    );
    return rows.map((a) => ({
      id: String(a.id), providerId: String(a.provider_id),
      providerName: String(a.business_name ?? a.user_name ?? 'Provider'), phone: str(a.user_phone),
      targetTier: Number(a.target_tier), businessKind: String(a.business_kind), status: String(a.status) as ApplicationStatus,
      feeKobo: String(a.fee_kobo), paymentMethod: str(a.payment_method), paidAt: a.paid_at ? String(a.paid_at) : null,
      requirements: typeof a.requirements === 'string' ? JSON.parse(a.requirements) : (a.requirements ?? []),
      reason: str(a.reason), decidedBy: str(a.decided_by), decidedAt: a.decided_at ? String(a.decided_at) : null,
      refundStatus: String(a.refund_status), createdAt: String(a.created_at),
    }));
  },

  async setGranted(providerId: string, tier: number, source: string, by: string, reason: string | null) {
    await q(
      `UPDATE provider.provider SET tier=$2, tier_source=$3, tier_set_by=$4, tier_reason=$5, tier_set_at=now() WHERE id=$1`,
      [providerId, tier, source, by, reason],
    );
    const { vendorEligibilityService } = await import('../vendors/eligibility.service.js');
    await vendorEligibilityService.refreshAll(providerId).catch(() => undefined);
  },

  async approve(applicationId: string, by: string, ctx: AuditContext = {}) {
    const a = (await q<Row>(`SELECT * FROM provider.tier_application WHERE id=$1`, [applicationId]))[0];
    if (!a) throw new TierError('NOT_FOUND', 'Application not found', 404);
    if (String(a.status) !== 'under_review') throw new TierError('APPLICATION_NOT_REVIEWABLE', `Application is ${String(a.status)}.`, 409);
    const fee = big(a.fee_kobo);
    const jobs = await count(`SELECT COUNT(*) AS n FROM provider.earning WHERE provider_id=$1`, [a.provider_id]);
    const upd = await q<Row>(
      `UPDATE provider.tier_application SET status='approved', decided_by=$2, decided_at=now(), refund_status=$3, jobs_at_decision=$4, updated_at=now()
        WHERE id=$1 AND status='under_review' RETURNING *`, [applicationId, by, fee > 0n ? 'pending' : 'none', jobs],
    );
    if (!upd[0]) throw new TierError('APPLICATION_NOT_REVIEWABLE', 'Application already decided.', 409);
    const providerId = String(a.provider_id);
    const target = Number(a.target_tier);
    const prev = Number((await q<{ tier: number }>(`SELECT tier FROM provider.provider WHERE id=$1`, [providerId]))[0]?.tier ?? 0);
    await this.setGranted(providerId, Math.max(prev, target), 'application', by, null);
    await auditService.log(by, 'provider.tier.application_approved', applicationId, { ...ctx, entityType: 'tier_application', meta: { providerId, from: prev, to: target } });
    emit('provider.tier_changed', { providerId, from: prev, to: target, by, via: 'application' });
    return { id: applicationId, status: 'approved' as ApplicationStatus, providerId, tier: target };
  },

  async reject(applicationId: string, by: string, reason: string, ctx: AuditContext = {}) {
    const a = (await q<Row>(`SELECT * FROM provider.tier_application WHERE id=$1`, [applicationId]))[0];
    if (!a) throw new TierError('NOT_FOUND', 'Application not found', 404);
    if (!['under_review', 'pending_payment'].includes(String(a.status))) throw new TierError('APPLICATION_NOT_REVIEWABLE', `Application is ${String(a.status)}.`, 409);
    const paid = String(a.status) === 'under_review' && big(a.fee_kobo) > 0n;
    const upd = await q<Row>(
      `UPDATE provider.tier_application SET status='rejected', reason=$3, decided_by=$2, decided_at=now(), updated_at=now()
        WHERE id=$1 AND status IN ('under_review', 'pending_payment') RETURNING *`, [applicationId, by, reason],
    );
    if (!upd[0]) throw new TierError('APPLICATION_NOT_REVIEWABLE', 'Application already decided.', 409);
    const providerId = String(a.provider_id);
    let refundedKobo = '0';
    if (paid) {
      const prov = await q<{ user_id: string }>(`SELECT user_id FROM provider.provider WHERE id=$1`, [providerId]);
      const ref = `tierrefund_${applicationId}`;
      await walletService.credit(String(prov[0].user_id), Number(big(a.fee_kobo)), ref, 'refund');
      await q(`UPDATE provider.tier_application SET refund_status='refunded', refund_reference=$2, refunded_at=now() WHERE id=$1`, [applicationId, ref]);
      refundedKobo = String(a.fee_kobo);
    }
    await auditService.log(by, 'provider.tier.application_rejected', applicationId, { ...ctx, entityType: 'tier_application', reason, meta: { providerId, refundedKobo } });
    emit('provider.tier_application_rejected', { providerId, applicationId, reason });
    return { id: applicationId, status: 'rejected' as ApplicationStatus, providerId, reason, refundedKobo };
  },

  /** Admin sets or downgrades a provider's tier (always with a reason; audit-logged). */
  async adminSetTier(providerId: string, tier: TierNo, reason: string, by: string, ctx: AuditContext = {}) {
    const p = await q<{ tier: number }>(`SELECT tier FROM provider.provider WHERE id=$1`, [providerId]);
    if (!p[0]) throw new TierError('NOT_FOUND', 'Provider not found', 404);
    const prev = Number(p[0].tier ?? 0);
    await this.setGranted(providerId, tier, 'admin', by, reason);
    await auditService.log(by, 'provider.tier.set', providerId, { ...ctx, entityType: 'provider', reason, meta: { from: prev, to: tier } });
    emit('provider.tier_changed', { providerId, from: prev, to: tier, by, via: 'admin', reason });
    const s = await this.snapshot(providerId);
    return { providerId, granted: tier, tier: s.tier, previous: prev, reason };
  },

  /** Upgrade fee back as wallet credit after N completed jobs at the new tier (idempotent ref). */
  async checkRefunds(providerId: string): Promise<number> {
    const cfg = await tierConfig();
    const apps = await q<Row>(
      `SELECT * FROM provider.tier_application WHERE provider_id=$1 AND status='approved' AND refund_status='pending'`, [providerId],
    );
    if (!apps.length) return 0;
    const prov = await q<{ user_id: string; tier: number }>(`SELECT user_id, tier FROM provider.provider WHERE id=$1`, [providerId]);
    if (!prov[0]) return 0;
    let n = 0;
    for (const a of apps) {
      const target = Number(a.target_tier) as 2 | 3;
      if (Number(prov[0].tier ?? 0) < target) continue; // downgraded: not "at the new tier"
      // Jobs completed since approval (earning rows then vs now).
      const total = await count(`SELECT COUNT(*) AS n FROM provider.earning WHERE provider_id=$1`, [providerId]);
      if (total - Number(a.jobs_at_decision ?? 0) < cfg.refundAfterJobs[target]) continue;
      const ref = `tierrefund_${String(a.id)}`;
      await walletService.credit(String(prov[0].user_id), Number(big(a.fee_kobo)), ref, 'refund');
      await q(`UPDATE provider.tier_application SET refund_status='refunded', refund_reference=$2, refunded_at=now() WHERE id=$1`, [a.id, ref]);
      emit('provider.tier_fee_refunded', { providerId, applicationId: String(a.id), amountKobo: String(a.fee_kobo) });
      n++;
    }
    return n;
  },

  // ── Kendibo Pro subscription ───────────────────────────────────────────────
  async activate(subscriptionId: string, reference: string, amountKobo: bigint) {
    const cfg = await tierConfig();
    const s = (await q<Row>(`SELECT * FROM provider.subscription WHERE id=$1`, [subscriptionId]))[0];
    if (!s) return null;
    const now = Date.now();
    const startMs = String(s.status) === 'active' && ms(s.current_period_end) > now ? ms(s.current_period_end) : now;
    const endMs = startMs + cfg.pro.periodDays * 86_400_000;
    const renewing = Number(s.periods ?? 0) > 0;
    await q(
      `UPDATE provider.subscription SET status='active', periods=periods+1, current_period_start=$2, current_period_end=$3,
              payment_reference=$4, expired_at=NULL, updated_at=now() WHERE id=$1`,
      [subscriptionId, new Date(startMs).toISOString(), new Date(endMs).toISOString(), reference],
    );
    await q(
      `INSERT INTO provider.subscription_event (subscription_id, provider_id, kind, amount_kobo, reference) VALUES ($1,$2,$3,$4,$5)`,
      [subscriptionId, s.provider_id, renewing ? 'renew' : 'start', amountKobo.toString(), reference],
    );
    emit(renewing ? 'provider.subscription_renewed' : 'provider.subscription_started', { providerId: String(s.provider_id), subscriptionId });
    return { periodEnd: new Date(endMs).toISOString() };
  },

  /** POST /v1/provider/subscription */
  async subscribe(providerId: string, payments: CheckoutPort) {
    const s = await this.snapshot(providerId);
    if (s.tier < s.cfg.pro.minTier) {
      throw new TierError('TIER_TOO_LOW', `Kendibo Pro is for Tier ${s.cfg.pro.minTier} and above.`, 409,
        s.requirements.filter((r) => r.tier <= s.cfg.pro.minTier && !r.done).map((r) => r.key));
    }
    const cur = s.subscription;
    if (cur && subActive(cur)) {
      if (cur.cancel_at_period_end === true) {
        // Resume: the running period is already paid for.
        await q(`UPDATE provider.subscription SET cancel_at_period_end=FALSE, cancelled_at=NULL, updated_at=now() WHERE id=$1`, [cur.id]);
        await q(`INSERT INTO provider.subscription_event (subscription_id, provider_id, kind) VALUES ($1,$2,'resume')`, [cur.id, providerId]);
        return { subscriptionId: String(cur.id), status: 'active', payment: { method: 'wallet', paid: true } as TierPayment };
      }
      throw new TierError('ALREADY_SUBSCRIBED', 'Kendibo Pro is already active.', 409);
    }
    const price = s.cfg.pro.priceKobo;
    let subId: string;
    let reference: string;
    if (cur && String(cur.status) === 'pending_payment' && big(cur.price_kobo) === price && cur.payment_reference) {
      subId = String(cur.id); reference = String(cur.payment_reference);
    } else {
      subId = randomUUID();
      reference = `${SUB_REF_PREFIX}${subId}_1`;
      await q(
        `INSERT INTO provider.subscription (id, provider_id, plan, status, price_kobo, payment_reference) VALUES ($1,$2,$3,'pending_payment',$4,$5)`,
        [subId, providerId, s.cfg.pro.plan, price.toString(), reference],
      );
    }
    const payment = await this.charge(s.userId, price, reference, payments, str(s.row.user_email), str(s.row.user_name));
    if (payment.method === 'wallet') {
      await this.activate(subId, reference, price);
      return { subscriptionId: subId, status: 'active', payment };
    }
    return { subscriptionId: subId, status: 'pending_payment', payment };
  },

  /** DELETE /v1/provider/subscription — cancel at period end. */
  async cancelSubscription(providerId: string) {
    await this.refreshSubscription(providerId);
    const cur = await currentSubscription(providerId);
    if (!cur || !subActive(cur)) throw new TierError('NO_SUBSCRIPTION', 'You have no active Kendibo Pro subscription.', 404);
    if (cur.cancel_at_period_end !== true) {
      await q(`UPDATE provider.subscription SET cancel_at_period_end=TRUE, cancelled_at=now(), updated_at=now() WHERE id=$1`, [cur.id]);
      await q(`INSERT INTO provider.subscription_event (subscription_id, provider_id, kind) VALUES ($1,$2,'cancel')`, [cur.id, providerId]);
      emit('provider.subscription_cancelled', { providerId, subscriptionId: String(cur.id) });
    }
    return { subscriptionId: String(cur.id), active: true, cancelAtPeriodEnd: true, endsAt: new Date(String(cur.current_period_end)).toISOString(), renewsAt: null };
  },

  /**
   * Period over: cancelled -> expired; otherwise renew from the wallet (stable
   * ref per period), and expire when the balance is short or the pro has
   * dropped below Tier 2. Runs lazily on every tier read.
   */
  async refreshSubscription(providerId: string): Promise<void> {
    const cfg = await tierConfig();
    const rows = await q<Row>(`SELECT * FROM provider.subscription WHERE provider_id=$1 AND status='active'`, [providerId]);
    for (const s of rows) {
      if (ms(s.current_period_end) > Date.now()) continue;
      const expire = async (why: string) => {
        await q(`UPDATE provider.subscription SET status='expired', expired_at=now(), updated_at=now() WHERE id=$1 AND status='active'`, [s.id]);
        await q(`INSERT INTO provider.subscription_event (subscription_id, provider_id, kind) VALUES ($1,$2,'expire')`, [s.id, providerId]);
        emit('provider.subscription_expired', { providerId, subscriptionId: String(s.id), why });
      };
      if (s.cancel_at_period_end === true) { await expire('cancelled'); continue; }
      const p = await q<Row>(`SELECT user_id, tier FROM provider.provider WHERE id=$1`, [providerId]);
      if (!p[0] || Number(p[0].tier ?? 0) < cfg.pro.minTier) { await expire('tier_too_low'); continue; }
      const price = cfg.pro.priceKobo;
      const reference = `${SUB_REF_PREFIX}${String(s.id)}_${Number(s.periods ?? 1) + 1}`;
      try {
        await walletService.debit(String(p[0].user_id), Number(price), reference, 'payment');
        await q(`UPDATE provider.subscription SET price_kobo=$2 WHERE id=$1`, [s.id, price.toString()]);
        await this.activate(String(s.id), reference, price);
      } catch {
        await expire('insufficient_funds');
      }
    }
  },

  /** One-message summary for the WhatsApp /tier command. */
  async tierText(providerId: string): Promise<string> {
    const v = await this.view(providerId);
    const naira = (k: string | null) => (k === null ? 'no cap' : `₦${(Number(k) / 100).toLocaleString('en-NG')}`);
    const lines = [
      `Your Kendibo tier: Tier ${v.tier} ${v.name}${v.active ? ` (${v.badge})` : ' (not complete yet)'}`,
      `Max per job: ${naira(v.limits.maxJobKobo)} · Open jobs: ${v.limits.maxOpenJobs ?? 'unlimited'} · Payout hold: ${v.limits.payoutHoldHours}h`,
    ];
    const todo = v.requirements.filter((r) => !r.done && r.tier <= (v.next?.tier ?? v.tier));
    if (v.application && ['pending_payment', 'under_review'].includes(v.application.status)) {
      lines.push(`Upgrade to Tier ${v.application.targetTier}: ${v.application.status === 'under_review' ? 'being reviewed' : 'waiting for payment'}.`);
    } else if (v.next) {
      lines.push(v.next.canApply
        ? `You can upgrade to Tier ${v.next.tier} (fee ${naira(v.next.feeKobo)}, refunded after your first jobs). Open the Kendibo app to apply.`
        : `To reach Tier ${v.next.tier}: ${todo.map((r) => r.label).join('; ') || 'finish your profile'}.`);
    }
    lines.push(v.subscription.active ? 'Kendibo Pro: active.' : v.subscription.includedByTier ? 'Kendibo Pro perks: included with Tier 3.' : `Kendibo Pro: ${naira(v.subscription.priceKobo)}/month (Tier 2+).`);
    return lines.join('\n');
  },
};
