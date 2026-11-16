// KYC spend control. Every Prembly/Dojah call costs money, so identity lookups
// go through this guard:
//   1. Cache  — an ID-number lookup (NIN, BVN, CAC, bank) that already passed is
//               reused for KYC_CACHE_DAYS; a not-found result for 1 day. The key
//               is an HMAC of kind + number, so the raw number is never stored.
//   2. Limit  — at most KYC_MAX_ATTEMPTS_PER_DAY billable calls per subject and
//               kind in 24h (stops retry loops and abuse burning credit).
//   3. Budget — hard daily / monthly caps (KYC_DAILY_BUDGET_KOBO,
//               KYC_MONTHLY_BUDGET_KOBO). When hit, checks fail closed with a
//               clear reason and ops are alerted instead of the bill growing.
//   4. Ledger — every call is written to kyc.verification_cost with its unit
//               cost (KYC_COST_<KIND>_KOBO from your vendor contract), and with
//               KYC_FEE_PASSTHROUGH=true a vendor's own check cost is added to
//               their fee ledger and recovered from earnings at payout.
// Face matches depend on a live selfie and are never cached.
import crypto from 'node:crypto';
import { q } from '../../packages/database/db.js';
import { emit } from '../../packages/observability/emit.js';
import { observability } from '../../packages/observability/watchup.adapter.js';
import type { KycAdapter, KycCheckResult } from './kyc.service.js';
import { isKycUnavailable, unavailableFromError } from './kyc-availability.js';

type Kind = 'nin' | 'nin_face' | 'bvn' | 'bvn_face' | 'doc_face' | 'liveness' | 'cac' | 'bank';

const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v >= 0 ? v : d;
};
const unitCost = (kind: Kind) => BigInt(Math.round(num(`KYC_COST_${kind.toUpperCase()}_KOBO`, 0)));
const cacheSecret = () => process.env.KYC_CACHE_SECRET || process.env.JWT_ACCESS_SECRET || 'dev-kyc-cache-INSECURE';
const lookupHash = (kind: Kind, id: string) =>
  crypto.createHmac('sha256', cacheSecret()).update(`${kind}:${id.replace(/\s+/g, '').toUpperCase()}`).digest('hex');

// Only what downstream logic needs; vendor `raw` payloads and phone numbers are dropped.
const cacheable = (r: KycCheckResult): KycCheckResult => ({
  passed: r.passed, provider: r.provider, confidence: r.confidence, reference: r.reference, reason: r.reason,
  verifiedName: r.verifiedName, companyName: r.companyName, rcNumber: r.rcNumber,
  // Kept so a cached NIN/BVN lookup can still be checked against the typed date of birth.
  ...(r.verifiedDob ? { verifiedDob: r.verifiedDob } : {}),
});

async function readCache(kind: Kind, id: string): Promise<KycCheckResult | null> {
  const rows = await q<{ result: KycCheckResult; expires_at: string }>(
    `SELECT result, expires_at FROM kyc.verification_cache WHERE lookup_hash=$1`, [lookupHash(kind, id)],
  ).catch(() => []);
  const r = rows[0];
  if (!r || new Date(String(r.expires_at)).getTime() < Date.now()) return null;
  return { ...(r.result as KycCheckResult), reference: (r.result as KycCheckResult).reference ?? 'cache' };
}

async function writeCache(kind: Kind, id: string, r: KycCheckResult) {
  // Cache passes long, definite "not found" briefly, and never transient errors.
  const definiteFail = !r.passed && !isKycUnavailable(r) && /NOT_FOUND|MISMATCH|INVALID/.test(String(r.reason ?? ''));
  if (!r.passed && !definiteFail) return;
  const days = r.passed ? num('KYC_CACHE_DAYS', 180) : 1;
  const hash = lookupHash(kind, id);
  await q(`DELETE FROM kyc.verification_cache WHERE lookup_hash=$1`, [hash]).catch(() => undefined);
  await q(
    `INSERT INTO kyc.verification_cache (lookup_hash, kind, result, expires_at) VALUES ($1,$2,$3, now() + ($4 || ' days')::interval)`,
    [hash, kind, JSON.stringify(cacheable(r)), String(days)],
  ).catch(() => undefined);
}

async function spentSince(sinceIso: string): Promise<bigint> {
  const rows = await q<{ t: string }>(`SELECT COALESCE(SUM(unit_cost_kobo),0) AS t FROM kyc.verification_cost WHERE created_at >= $1`, [sinceIso]).catch(() => [{ t: '0' }]);
  return BigInt(String(rows[0]?.t ?? '0').split('.')[0] || '0');
}

async function budgetBlock(kind: Kind): Promise<string | null> {
  const cost = unitCost(kind);
  const now = new Date();
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const dailyCap = BigInt(Math.round(num('KYC_DAILY_BUDGET_KOBO', 0)));
  const monthlyCap = BigInt(Math.round(num('KYC_MONTHLY_BUDGET_KOBO', 0)));
  if (dailyCap > 0n && (await spentSince(day)) + cost > dailyCap) return 'KYC_DAILY_BUDGET_REACHED';
  if (monthlyCap > 0n && (await spentSince(month)) + cost > monthlyCap) return 'KYC_MONTHLY_BUDGET_REACHED';
  return null;
}

async function attemptsToday(subjectType: string, subjectId: string, kind: Kind): Promise<number> {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const rows = await q<{ n: string }>(
    // Provider-side outages ('unavailable:...') are not the applicant's attempts.
    `SELECT COUNT(*) AS n FROM kyc.verification_cost WHERE subject_type=$1 AND subject_id=$2 AND kind=$3 AND cached=FALSE AND created_at >= $4 AND outcome NOT LIKE 'unavailable:%'`,
    [subjectType, subjectId, kind, since],
  ).catch(() => [{ n: '0' }]);
  return Number(rows[0]?.n ?? 0);
}

async function logCost(vendor: string, kind: Kind, subjectType: string, subjectId: string, cost: bigint, cached: boolean, outcome: string) {
  const rows = await q<{ id: string }>(
    `INSERT INTO kyc.verification_cost (vendor, kind, subject_type, subject_id, unit_cost_kobo, cached, outcome)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [vendor, kind, subjectType, subjectId, String(cost), cached, outcome],
  ).catch(() => []);
  if (!cached && cost > 0n && subjectType === 'provider' && process.env.KYC_FEE_PASSTHROUGH === 'true' && rows[0]) {
    const { vendorFinanceService } = await import('../vendors/vendor-finance.service.js');
    await vendorFinanceService.addFee(subjectId, 'kyc_verification', cost, `kyc:${String(rows[0].id)}`).catch(() => undefined);
  }
}

export function guardKycAdapter(inner: KycAdapter, subjectType: string, subjectId: string): KycAdapter {
  const vendor = inner.name;
  const billable = !/sandbox|stub/i.test(vendor);

  async function run(kind: Kind, idForCache: string | null, call: () => Promise<KycCheckResult>): Promise<KycCheckResult> {
    if (idForCache) {
      const hit = await readCache(kind, idForCache);
      if (hit) { await logCost(vendor, kind, subjectType, subjectId, 0n, true, hit.passed ? 'passed' : 'failed'); return hit; }
    }
    if (billable) {
      const limit = num('KYC_MAX_ATTEMPTS_PER_DAY', 3);
      if ((await attemptsToday(subjectType, subjectId, kind)) >= limit) {
        return { passed: false, provider: vendor, reason: 'KYC_ATTEMPT_LIMIT' };
      }
      const blocked = await budgetBlock(kind);
      if (blocked) {
        emit('kyc.budget_blocked', { kind, reason: blocked });
        observability.captureMessage?.(`kyc.budget_blocked kind=${kind} reason=${blocked}`);
        return { passed: false, provider: vendor, reason: blocked, unavailable: true };
      }
    }
    let r: KycCheckResult;
    try { r = await call(); } catch (e) { r = unavailableFromError(e, vendor); }
    // Vendors bill for conclusive answers; a transport error or any provider-side
    // outage is logged at 0 and does not count toward the daily attempt limit.
    const unavailable = isKycUnavailable(r);
    if (unavailable) r = { ...r, unavailable: true };
    const conclusive = !unavailable && (r.passed || /NOT_FOUND|MISMATCH|INVALID|FACE/.test(String(r.reason ?? '')));
    const outcome = r.passed ? 'passed' : unavailable ? `unavailable:${String(r.reason ?? 'unknown').slice(0, 120)}` : (r.reason ?? 'failed');
    await logCost(vendor, kind, subjectType, subjectId, billable && conclusive ? unitCost(kind) : 0n, false, outcome);
    if (idForCache) await writeCache(kind, idForCache, r);
    return r;
  }

  const guarded: KycAdapter = {
    name: vendor,
    verifyNin: (nin) => run('nin', nin, () => inner.verifyNin(nin)),
    verifyBvn: (bvn) => run('bvn', bvn, () => inner.verifyBvn(bvn)),
    verifyDocAndFace: (id, selfie) => run('doc_face', null, () => inner.verifyDocAndFace(id, selfie)),
    verifyCac: (rc, name) => run('cac', rc, () => inner.verifyCac(rc, name)),
  };
  if (inner.verifyNinWithFace) guarded.verifyNinWithFace = (nin, s) => run('nin_face', null, () => inner.verifyNinWithFace!(nin, s));
  if (inner.verifyBvnWithFace) guarded.verifyBvnWithFace = (bvn, s) => run('bvn_face', null, () => inner.verifyBvnWithFace!(bvn, s));
  if (inner.verifyFaceLiveness) guarded.verifyFaceLiveness = (s) => run('liveness', null, () => inner.verifyFaceLiveness!(s));
  if (inner.verifyBankAccount) guarded.verifyBankAccount = (acct, bank) => run('bank', `${bank}:${acct}`, () => inner.verifyBankAccount!(acct, bank));
  return guarded;
}

/** Ops view: spend by kind for a window, plus cache savings. */
export async function kycSpendReport(days = 30) {
  const since = new Date(Date.now() - Math.min(days, 366) * 86_400_000).toISOString();
  const rows = await q<{ kind: string; calls: string; cached: string; spend: string }>(
    `SELECT kind, COUNT(*) AS calls, SUM(CASE WHEN cached THEN 1 ELSE 0 END) AS cached, COALESCE(SUM(unit_cost_kobo),0) AS spend
       FROM kyc.verification_cost WHERE created_at >= $1 GROUP BY kind ORDER BY kind`, [since],
  );
  const byKind = rows.map((r) => ({ kind: String(r.kind), calls: Number(r.calls), cachedHits: Number(r.cached), spendKobo: String(r.spend) }));
  const total = byKind.reduce((s, r) => s + BigInt(r.spendKobo.split('.')[0] || '0'), 0n);
  return {
    days, byKind, totalSpendKobo: total.toString(),
    caps: { dailyKobo: String(num('KYC_DAILY_BUDGET_KOBO', 0)), monthlyKobo: String(num('KYC_MONTHLY_BUDGET_KOBO', 0)) },
    feePassthrough: process.env.KYC_FEE_PASSTHROUGH === 'true',
  };
}
