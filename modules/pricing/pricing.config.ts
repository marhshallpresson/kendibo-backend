// Pricing + cancellation numbers, from the database instead of code.
//   - VAT, platform fee and per-km rate: the latest catalog.pricebook row
//     (versioned; every admin change inserts a new row, so old bookings keep
//     the version frozen in their snapshot).
//   - Urgent / weekend surcharges and the cancellation refund matrix:
//     configuration.platform_setting key 'pricing.config'.
// Anything missing falls back to DEFAULT_PRICING_CONFIG, which equals the
// values that used to be hard-coded, so behaviour is unchanged until an admin
// edits them.
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { q } from '../../packages/database/db.js';
import { getSetting, setSetting } from '../settings/settings.service.js';
import { configurationService } from '../configuration/config.service.js';

export const CANCEL_STAGES = ['before_assignment', 'assigned_no_travel', 'en_route', 'arrived', 'work_started'] as const;
export type CancelStage = (typeof CANCEL_STAGES)[number];

const bps = z.number().int().min(0).max(10000);
const stage = z.object({ refundBps: bps, calloutApplies: z.boolean() });

export const pricingConfigSchema = z.object({
  vatBps: bps,
  platformFeeBps: bps,
  perKmKobo: z.number().int().min(0).max(10_000_000),
  urgencyBps: bps,
  weekendBps: bps,
  cancellation: z.object({
    before_assignment: stage,
    assigned_no_travel: stage,
    en_route: stage,
    arrived: stage,
    work_started: stage,
  }),
}).strict();
export type PricingConfig = z.infer<typeof pricingConfigSchema> & { version: string };

export const DEFAULT_PRICING_CONFIG: PricingConfig = {
  version: 'pricebook_2026-10-06',
  vatBps: 750,
  platformFeeBps: 1000,
  perKmKobo: 20000,
  urgencyBps: 2000,
  weekendBps: 1000,
  cancellation: {
    before_assignment: { refundBps: 10000, calloutApplies: false },
    assigned_no_travel: { refundBps: 10000, calloutApplies: false },
    en_route: { refundBps: 8500, calloutApplies: false },
    arrived: { refundBps: 8000, calloutApplies: true },
    work_started: { refundBps: 5000, calloutApplies: true },
  },
};

const SETTING_KEY = 'pricing.config';
const CACHE_TTL_MS = 30_000;
let cache: { at: number; value: PricingConfig } | null = null;

export function resetPricingConfigCache() { cache = null; }

export async function pricingConfig(): Promise<PricingConfig> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  const d = DEFAULT_PRICING_CONFIG;
  const book = await configurationService.priceBook().catch(() => null);
  const saved = (await getSetting<Record<string, unknown>>(SETTING_KEY).catch(() => null)) ?? {};
  const num = (v: unknown, fb: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fb);
  const savedCancel = (saved.cancellation ?? {}) as Record<string, { refundBps?: unknown; calloutApplies?: unknown }>;
  const cancellation = Object.fromEntries(CANCEL_STAGES.map((s) => [s, {
    refundBps: num(savedCancel[s]?.refundBps, d.cancellation[s].refundBps),
    calloutApplies: typeof savedCancel[s]?.calloutApplies === 'boolean' ? Boolean(savedCancel[s]!.calloutApplies) : d.cancellation[s].calloutApplies,
  }])) as PricingConfig['cancellation'];
  const value: PricingConfig = {
    version: book?.version ?? d.version,
    vatBps: book?.vatBps ?? d.vatBps,
    platformFeeBps: book?.platformFeeBps ?? d.platformFeeBps,
    perKmKobo: book?.perKmKobo ?? d.perKmKobo,
    urgencyBps: num(saved.urgencyBps, d.urgencyBps),
    weekendBps: num(saved.weekendBps, d.weekendBps),
    cancellation,
  };
  cache = { at: Date.now(), value };
  return value;
}

/** Save an admin edit. A pricebook change inserts a new versioned row; the rest goes to platform_setting. */
export async function savePricingConfig(next: z.infer<typeof pricingConfigSchema>, actor: string): Promise<PricingConfig> {
  const cur = await pricingConfig();
  if (next.vatBps !== cur.vatBps || next.platformFeeBps !== cur.platformFeeBps || next.perKmKobo !== cur.perKmKobo) {
    // Unique even for two edits in the same second.
    const version = `pricebook_${new Date().toISOString().replace(/[-:.]/g, '').replace('Z', '')}_${randomBytes(2).toString('hex')}`;
    await q(
      `INSERT INTO catalog.pricebook (version, vat_bps, platform_fee_bps, per_km_kobo, effective_from) VALUES ($1,$2,$3,$4, now())`,
      [version, next.vatBps, next.platformFeeBps, next.perKmKobo],
    );
    configurationService.resetCache?.();
  }
  await setSetting(SETTING_KEY, { urgencyBps: next.urgencyBps, weekendBps: next.weekendBps, cancellation: next.cancellation }, actor);
  resetPricingConfigCache();
  return pricingConfig();
}
