// Provider / vendor tiers: every price, limit and perk in ONE place.
// Defaults below are the owner-approved values. Ops may override any of them at
// runtime with configuration.platform_setting key 'tiers.config' (a partial
// JSON object of the same shape; kobo values as strings or integers), e.g.
//   {"upgradeFeeKobo":{"2":"300000"},"tiers":{"1":{"maxOpenJobs":4}}}
// Never trust a client amount: every fee/price charged comes from here.
import { getSetting } from '../settings/settings.service.js';

export type TierNo = 1 | 2 | 3;
export type BusinessKind = 'individual' | 'business';

export interface TierDef {
  tier: TierNo;
  name: string;
  badge: string;
  /** Business badge (Tier 3 only differs). */
  businessBadge?: string;
  /** null = no per-job cap. */
  maxJobKobo: bigint | null;
  maxOpenJobs: number | null;
  /** Active product listings (vendors). null = unlimited. */
  maxListings: number | null;
  payoutHoldHours: number;
  /** null = the trade's standard commission (category rule, default 1500 bps). */
  commissionBps: number | null;
  /** Ranking points added in dispatch (0-100 score scale). */
  rankBoost: number;
}

export interface TierConfig {
  tiers: Record<TierNo, TierDef>;
  standardCommissionBps: number;
  /** One-off upgrade fee, charged on apply. */
  upgradeFeeKobo: { 2: bigint; 3: Record<BusinessKind, bigint> };
  /** Fee refunded as wallet credit after this many completed jobs at the new tier. */
  refundAfterJobs: { 2: number; 3: number };
  tier1: { minCategories: number };
  tier2: { minPortfolioPhotos: number; minReferences: number };
  tier3: { minCompletedJobs: number; minRating: number; largeJobFlagKobo: bigint };
  pro: {
    plan: 'pro_monthly';
    priceKobo: bigint;
    periodDays: number;
    minTier: TierNo;
    commissionBps: number;
    rankBoost: number;
    benefits: string[];
  };
}

export const DEFAULT_TIER_CONFIG: TierConfig = {
  tiers: {
    1: { tier: 1, name: 'Starter', badge: 'ID checked', maxJobKobo: 5_000_000n, maxOpenJobs: 3, maxListings: 10, payoutHoldHours: 48, commissionBps: null, rankBoost: 0 },
    2: { tier: 2, name: 'Verified', badge: 'Verified pro', maxJobKobo: 50_000_000n, maxOpenJobs: 10, maxListings: 100, payoutHoldHours: 24, commissionBps: null, rankBoost: 3 },
    3: { tier: 3, name: 'Pro / Business', badge: 'Kendibo Pro', businessBadge: 'Verified business', maxJobKobo: null, maxOpenJobs: null, maxListings: null, payoutHoldHours: 0, commissionBps: 1200, rankBoost: 8 },
  },
  standardCommissionBps: 1500,
  upgradeFeeKobo: { 2: 250_000n, 3: { individual: 1_000_000n, business: 2_000_000n } },
  refundAfterJobs: { 2: 3, 3: 10 },
  tier1: { minCategories: 1 },
  tier2: { minPortfolioPhotos: 2, minReferences: 1 },
  tier3: { minCompletedJobs: 10, minRating: 4.5, largeJobFlagKobo: 200_000_000n },
  pro: {
    plan: 'pro_monthly',
    priceKobo: 300_000n,
    periodDays: 30,
    minTier: 2,
    commissionBps: 1200,
    rankBoost: 5,
    benefits: ['Ranking boost', 'Commission 12% instead of 15%', 'Featured in WhatsApp suggestions', 'Performance analytics'],
  },
};

const SETTING_KEY = 'tiers.config';
const TTL_MS = 30_000;
let cache: { at: number; value: TierConfig } | null = null;

const kobo = (v: unknown, d: bigint): bigint => {
  if (v === null) return d;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  return d;
};
const koboOrNull = (v: unknown, d: bigint | null): bigint | null => (v === null ? null : v === undefined ? d : kobo(v, d ?? 0n));
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);
const numOrNull = (v: unknown, d: number | null): number | null => (v === null ? null : v === undefined ? d : num(v, d ?? 0));
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** Defaults merged with the platform_setting override (unknown keys ignored). */
export function mergeTierConfig(raw: unknown, base: TierConfig = DEFAULT_TIER_CONFIG): TierConfig {
  const o = obj(raw);
  const t = obj(o.tiers);
  const tiers = {} as Record<TierNo, TierDef>;
  for (const n of [1, 2, 3] as TierNo[]) {
    const b = base.tiers[n];
    const x = obj(t[String(n)]);
    tiers[n] = {
      ...b,
      name: typeof x.name === 'string' ? x.name : b.name,
      badge: typeof x.badge === 'string' ? x.badge : b.badge,
      businessBadge: typeof x.businessBadge === 'string' ? x.businessBadge : b.businessBadge,
      maxJobKobo: koboOrNull(x.maxJobKobo, b.maxJobKobo),
      maxOpenJobs: numOrNull(x.maxOpenJobs, b.maxOpenJobs),
      maxListings: numOrNull(x.maxListings, b.maxListings),
      payoutHoldHours: num(x.payoutHoldHours, b.payoutHoldHours),
      commissionBps: numOrNull(x.commissionBps, b.commissionBps),
      rankBoost: num(x.rankBoost, b.rankBoost),
    };
  }
  const fee = obj(o.upgradeFeeKobo);
  const fee3 = obj(fee['3']);
  const refund = obj(o.refundAfterJobs);
  const t1 = obj(o.tier1); const t2 = obj(o.tier2); const t3 = obj(o.tier3); const pro = obj(o.pro);
  return {
    tiers,
    standardCommissionBps: num(o.standardCommissionBps, base.standardCommissionBps),
    upgradeFeeKobo: {
      2: kobo(fee['2'], base.upgradeFeeKobo[2]),
      3: { individual: kobo(fee3.individual, base.upgradeFeeKobo[3].individual), business: kobo(fee3.business, base.upgradeFeeKobo[3].business) },
    },
    refundAfterJobs: { 2: num(refund['2'], base.refundAfterJobs[2]), 3: num(refund['3'], base.refundAfterJobs[3]) },
    tier1: { minCategories: num(t1.minCategories, base.tier1.minCategories) },
    tier2: { minPortfolioPhotos: num(t2.minPortfolioPhotos, base.tier2.minPortfolioPhotos), minReferences: num(t2.minReferences, base.tier2.minReferences) },
    tier3: {
      minCompletedJobs: num(t3.minCompletedJobs, base.tier3.minCompletedJobs),
      minRating: num(t3.minRating, base.tier3.minRating),
      largeJobFlagKobo: kobo(t3.largeJobFlagKobo, base.tier3.largeJobFlagKobo),
    },
    pro: {
      ...base.pro,
      priceKobo: kobo(pro.priceKobo, base.pro.priceKobo),
      periodDays: num(pro.periodDays, base.pro.periodDays) || base.pro.periodDays,
      commissionBps: num(pro.commissionBps, base.pro.commissionBps),
      rankBoost: num(pro.rankBoost, base.pro.rankBoost),
      benefits: Array.isArray(pro.benefits) && pro.benefits.every((b) => typeof b === 'string') ? (pro.benefits as string[]) : base.pro.benefits,
    },
  };
}

export async function tierConfig(): Promise<TierConfig> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const raw = await getSetting<unknown>(SETTING_KEY).catch(() => null);
  const value = mergeTierConfig(raw);
  cache = { at: Date.now(), value };
  return value;
}

/** Drop the memo (tests, or right after an admin edits the setting). */
export function resetTierConfigCache(): void { cache = null; }

export function upgradeFee(cfg: TierConfig, target: 2 | 3, kind: BusinessKind): bigint {
  return target === 2 ? cfg.upgradeFeeKobo[2] : cfg.upgradeFeeKobo[3][kind];
}
