// Provider / vendor tiers: every price, limit and perk in ONE place.
// The DATABASE is the source of truth: configuration.platform_setting key
// 'tiers.config' (seeded by migration 060, edited by admins through
// PUT /v1/admin/settings/tiers). DEFAULT_TIER_CONFIG below is only a last-resort
// fallback when that row is missing or invalid (a warning is logged then).
// Never trust a client amount: every fee/price charged comes from here.
import { z } from 'zod';
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
      minTier: ([1, 2, 3].includes(pro.minTier as number) ? pro.minTier : base.pro.minTier) as TierNo,
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
  let value: TierConfig;
  if (raw === null || raw === undefined) {
    console.warn(`[tiers] platform_setting '${SETTING_KEY}' is missing: using built-in default tier config`);
    value = DEFAULT_TIER_CONFIG;
  } else if (!tierConfigSchema.safeParse(raw).success) {
    console.warn(`[tiers] platform_setting '${SETTING_KEY}' is invalid: using built-in default tier config`);
    value = DEFAULT_TIER_CONFIG;
  } else {
    value = mergeTierConfig(raw);
  }
  cache = { at: Date.now(), value };
  return value;
}

/** Drop the memo (tests, or right after an admin edits the setting). */
export function resetTierConfigCache(): void { cache = null; }

export function upgradeFee(cfg: TierConfig, target: 2 | 3, kind: BusinessKind): bigint {
  return target === 2 ? cfg.upgradeFeeKobo[2] : cfg.upgradeFeeKobo[3][kind];
}

// ── Admin-editable JSON shape (GET/PUT /v1/admin/settings/tiers) ─────────────
export interface TierConfigJSON {
  standardCommissionBps: number;
  tiers: Record<'1' | '2' | '3', {
    name: string; badge: string; businessBadge?: string;
    maxJobKobo: string | null; maxOpenJobs: number | null; maxListings: number | null;
    payoutHoldHours: number; commissionBps: number | null; rankBoost: number;
  }>;
  upgradeFeeKobo: { '2': string; '3': { individual: string; business: string } };
  refundAfterJobs: { '2': number; '3': number };
  tier1: { minCategories: number };
  tier2: { minPortfolioPhotos: number; minReferences: number };
  tier3: { minCompletedJobs: number; minRating: number; largeJobFlagKobo: string };
  pro: { plan: 'pro_monthly'; priceKobo: string; periodDays: number; minTier: number; commissionBps: number; rankBoost: number; benefits: string[] };
}

const koboStr = z.string().regex(/^d{1,18}$/, 'must be a whole number of kobo (digits only)');
const nonNegInt = z.number().int().min(0);
const bps = z.number().int().min(0).max(10000);
const tierDefSchema = z.object({
  name: z.string().trim().min(1).max(60),
  badge: z.string().trim().min(1).max(60),
  businessBadge: z.string().trim().min(1).max(60).optional(),
  maxJobKobo: koboStr.nullable(),
  maxOpenJobs: nonNegInt.nullable(),
  maxListings: nonNegInt.nullable(),
  payoutHoldHours: nonNegInt,
  commissionBps: bps.nullable(),
  rankBoost: nonNegInt,
});
export const tierConfigSchema = z.object({
  standardCommissionBps: bps,
  tiers: z.object({ '1': tierDefSchema, '2': tierDefSchema, '3': tierDefSchema }),
  upgradeFeeKobo: z.object({ '2': koboStr, '3': z.object({ individual: koboStr, business: koboStr }) }),
  refundAfterJobs: z.object({ '2': nonNegInt, '3': nonNegInt }),
  tier1: z.object({ minCategories: nonNegInt }),
  tier2: z.object({ minPortfolioPhotos: nonNegInt, minReferences: nonNegInt }),
  tier3: z.object({ minCompletedJobs: nonNegInt, minRating: z.number().min(0).max(5), largeJobFlagKobo: koboStr }),
  pro: z.object({
    plan: z.literal('pro_monthly'),
    priceKobo: koboStr,
    periodDays: z.number().int().min(1).max(366),
    minTier: z.number().int().min(1).max(3),
    commissionBps: bps,
    rankBoost: nonNegInt,
    benefits: z.array(z.string().trim().min(1).max(200)).max(10),
  }),
});

/** Runtime config -> the JSON shape the admin UI reads and writes. */
export function tierConfigToJSON(cfg: TierConfig): TierConfigJSON {
  const tier = (n: TierNo) => {
    const d = cfg.tiers[n];
    return {
      name: d.name, badge: d.badge, ...(d.businessBadge ? { businessBadge: d.businessBadge } : {}),
      maxJobKobo: d.maxJobKobo === null ? null : d.maxJobKobo.toString(),
      maxOpenJobs: d.maxOpenJobs, maxListings: d.maxListings, payoutHoldHours: d.payoutHoldHours,
      commissionBps: d.commissionBps, rankBoost: d.rankBoost,
    };
  };
  return {
    standardCommissionBps: cfg.standardCommissionBps,
    tiers: { '1': tier(1), '2': tier(2), '3': tier(3) },
    upgradeFeeKobo: { '2': cfg.upgradeFeeKobo[2].toString(), '3': { individual: cfg.upgradeFeeKobo[3].individual.toString(), business: cfg.upgradeFeeKobo[3].business.toString() } },
    refundAfterJobs: { '2': cfg.refundAfterJobs[2], '3': cfg.refundAfterJobs[3] },
    tier1: { ...cfg.tier1 },
    tier2: { ...cfg.tier2 },
    tier3: { minCompletedJobs: cfg.tier3.minCompletedJobs, minRating: cfg.tier3.minRating, largeJobFlagKobo: cfg.tier3.largeJobFlagKobo.toString() },
    pro: { plan: cfg.pro.plan, priceKobo: cfg.pro.priceKobo.toString(), periodDays: cfg.pro.periodDays, minTier: cfg.pro.minTier, commissionBps: cfg.pro.commissionBps, rankBoost: cfg.pro.rankBoost, benefits: [...cfg.pro.benefits] },
  };
}
