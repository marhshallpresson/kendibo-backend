// Vendor eligibility — "may this vendor take work in this category right now?"
// One function answers it for dispatch, request broadcast, offer acceptance,
// storefront publishing and the app's "what's left" checklist, so the rules
// can never drift between surfaces.
import { q } from '../../packages/database/db.js';
import { emit } from '../../packages/observability/emit.js';
import { categoryRulesService } from './category-rules.service.js';

export type MissingRequirement =
  | 'account_active' | 'kyc_approved' | `kyc_tier_${number}` | 'face_match' | 'cac'
  | 'licence' | 'insurance' | 'certificate' | `experience_${number}y` | 'capacity';

export interface Eligibility { providerId: string; categoryId: string; eligible: boolean; missing: MissingRequirement[] }

/** Enforced in production (and wherever VENDOR_ELIGIBILITY_ENFORCED=true). In
 *  local/test runs unverified seed vendors still receive work so flows can be
 *  exercised; the decision is still computed and emitted for visibility. */
export function eligibilityEnforced(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.VENDOR_ELIGIBILITY_ENFORCED === 'true';
}

const ACTIVE_JOB_STATES =['PROVIDER_ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'CHECK_IN', 'INSPECTION', 'PRE_SERVICE', 'IN_PROGRESS', 'AWAITING_APPROVAL'];

export const vendorEligibilityService = {
  async evaluate(providerId: string, categoryId: string): Promise<Eligibility> {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM provider.provider WHERE id=$1`, [providerId]);
    const p = rows[0];
    if (!p) throw new Error('PROVIDER_NOT_FOUND');
    const rule = await categoryRulesService.ruleFor(categoryId);
    const missing: MissingRequirement[] = [];

    if (String(p.status ?? 'active') !== 'active') missing.push('account_active');
    if (String(p.kyc_status ?? '').toUpperCase() !== 'VERIFIED') missing.push('kyc_approved');
    if (Number(p.kyc_tier ?? 0) < rule.minKycTier) missing.push(`kyc_tier_${rule.minKycTier}`);
    if (rule.requireFaceMatch && p.face_verified !== true) missing.push('face_match');
    if (rule.requireCac && p.cac_verified !== true) missing.push('cac');

    const needed = new Set<string>(rule.requiredDocuments);
    if (rule.licenceRequired) needed.add('licence');
    if (rule.insuranceRequired) needed.add('insurance');
    if (needed.size) {
      const creds = await q<{ kind: string; expires_at: string | null; category_id: string | null }>(
        `SELECT kind, expires_at, category_id FROM provider.credential WHERE provider_id=$1 AND status='approved'`, [providerId],
      );
      const today = new Date().toISOString().slice(0, 10);
      for (const kind of needed) {
        const ok = creds.some((c) => String(c.kind) === kind
          && (!c.category_id || String(c.category_id) === categoryId)
          && (!c.expires_at || String(c.expires_at).slice(0, 10) >= today));
        if (!ok) missing.push(kind as MissingRequirement);
      }
    }

    if (rule.minExperienceYears > 0) {
      const exp = await q<{ years: number }>(
        `SELECT COALESCE(MAX(k.experience_years),0) AS years FROM provider.skill k
           JOIN catalog.service s ON s.id = COALESCE(k.skill_tag, k.service_id) OR s.requires_skill = COALESCE(k.skill_tag, k.service_id)
          WHERE k.provider_id=$1 AND s.category_id=$2`, [providerId, categoryId],
      );
      if (Number(exp[0]?.years ?? 0) < rule.minExperienceYears) missing.push(`experience_${rule.minExperienceYears}y`);
    }

    const busy = await q<{ n: string }>(
      `SELECT COUNT(*) AS n FROM dispatch.assignment a JOIN booking.booking b ON b.id::text = a.job_id
        WHERE a.provider_id=$1 AND a.status='accepted' AND b.status = ANY($2)`, [providerId, ACTIVE_JOB_STATES],
    ).catch(() => [{ n: '0' }]);
    if (Number(busy[0]?.n ?? 0) >= rule.maxConcurrentJobs) missing.push('capacity');

    return { providerId, categoryId, eligible: missing.length === 0, missing };
  },

  /** Record (or refresh) a vendor's enrollment in a trade. Capacity is a live
   *  condition, so it never downgrades the stored enrollment. */
  async enroll(providerId: string, categoryId: string): Promise<Eligibility> {
    const e = await this.evaluate(providerId, categoryId);
    const stored = e.missing.filter((m) => m !== 'capacity');
    await q(`DELETE FROM provider.category_enrollment WHERE provider_id=$1 AND category_id=$2`, [providerId, categoryId]);
    await q(
      `INSERT INTO provider.category_enrollment (provider_id, category_id, status, missing, evaluated_at) VALUES ($1,$2,$3,$4, now())`,
      [providerId, categoryId, stored.length ? 'pending' : 'eligible', JSON.stringify(stored)],
    );
    emit('vendor.enrollment_evaluated', { providerId, categoryId, eligible: stored.length === 0 });
    // One-time onboarding fee for the trade (if ops set one), recovered from
    // earnings at payout — never charged up front. Reference makes it idempotent.
    if (stored.length === 0) {
      const rule = await categoryRulesService.ruleFor(categoryId);
      const fee = BigInt(rule.verificationFeeKobo || '0');
      if (fee > 0n) {
        const { vendorFinanceService } = await import('./vendor-finance.service.js');
        await vendorFinanceService.addFee(providerId, 'kyc_verification', fee, `catfee:${providerId}:${categoryId}`);
      }
    }
    return e;
  },

  async enrollments(providerId: string): Promise<Eligibility[]> {
    const rows = await q<{ category_id: string }>(
      `SELECT category_id FROM provider.category_enrollment WHERE provider_id=$1 ORDER BY category_id`, [providerId],
    );
    const out: Eligibility[] = [];
    for (const r of rows) out.push(await this.evaluate(providerId, String(r.category_id)));
    return out;
  },

  /** Re-check every trade a vendor is in (after KYC approval, credential review…). */
  async refreshAll(providerId: string): Promise<void> {
    const rows = await q<{ category_id: string }>(`SELECT category_id FROM provider.category_enrollment WHERE provider_id=$1`, [providerId]);
    for (const r of rows) await this.enroll(providerId, String(r.category_id));
  },

  /** The gate dispatch, broadcast and offer acceptance call. */
  async allowed(providerId: string, categoryId: string | null | undefined): Promise<boolean> {
    const ok = await this.canWork(providerId, categoryId).catch(() => false);
    if (!ok) emit('vendor.eligibility_blocked', { providerId, categoryId: categoryId ?? null, enforced: eligibilityEnforced() });
    return ok || !eligibilityEnforced();
  },

  async canWork(providerId: string, categoryId: string | null | undefined): Promise<boolean> {
    if (!categoryId) {
      // Uncategorised request: the vendor must at least be cleared in some trade.
      const any = await q(`SELECT 1 FROM provider.category_enrollment WHERE provider_id=$1 AND status='eligible' LIMIT 1`, [providerId]);
      return !!any[0];
    }
    return (await this.evaluate(providerId, categoryId)).eligible;
  },

  async submitCredential(providerId: string, input: { kind: 'licence' | 'insurance' | 'certificate'; assetId: string; categoryId?: string; label?: string; number?: string; expiresAt?: string }) {
    const asset = await q<{ id: string }>(`SELECT id FROM media.asset WHERE id=$1`, [input.assetId]);
    if (!asset[0]) throw new Error('ASSET_NOT_FOUND');
    const rows = await q<Record<string, unknown>>(
      `INSERT INTO provider.credential (provider_id, category_id, kind, asset_id, label, number, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, kind, status, created_at`,
      [providerId, input.categoryId ?? null, input.kind, input.assetId, input.label ?? null, input.number ?? null, input.expiresAt ?? null],
    );
    emit('vendor.credential_submitted', { providerId, kind: input.kind });
    return rows[0];
  },

  async credentials(providerId: string) {
    return q(`SELECT id, category_id, kind, label, number, expires_at, status, created_at FROM provider.credential WHERE provider_id=$1 ORDER BY created_at DESC`, [providerId]);
  },

  async pendingCredentials() {
    return q(`SELECT c.*, p.business_name FROM provider.credential c JOIN provider.provider p ON p.id=c.provider_id WHERE c.status='submitted' ORDER BY c.created_at LIMIT 100`);
  },

  async reviewCredential(id: string, approve: boolean, by: string) {
    const rows = await q<{ provider_id: string }>(
      `UPDATE provider.credential SET status=$2, reviewed_by=$3, reviewed_at=now() WHERE id=$1 AND status='submitted' RETURNING provider_id`,
      [id, approve ? 'approved' : 'rejected', by],
    );
    if (!rows[0]) throw new Error('CREDENTIAL_GONE');
    await this.refreshAll(String(rows[0].provider_id));
    return { id, status: approve ? 'approved' : 'rejected' };
  },
};
