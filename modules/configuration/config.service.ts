// Configuration — versioned data from Postgres (never code deploys).
import { q } from '../../packages/database/db.js';

export interface PriceBook { version: string; vatBps: number; platformFeeBps: number; perKmKobo: number }

// priceBook/flags feed /v1/mobile/config which every app boot fetches; the
// underlying rows are reference data that changes at most a few times a day,
// so a short in-process memo removes two DB round-trips per call on the
// hottest cold-start path (perf audit: WAN Postgres × polling).
const CACHE_TTL_MS = 30_000;
let priceBookCache: { at: number; value: PriceBook } | null = null;
let flagsCache: { at: number; value: Record<string, boolean> } | null = null;

export const configurationService = {
  async priceBook(): Promise<PriceBook> {
    if (priceBookCache && Date.now() - priceBookCache.at < CACHE_TTL_MS) return priceBookCache.value;
    const rows = await q<Record<string, unknown>>(`SELECT * FROM catalog.pricebook ORDER BY effective_from DESC LIMIT 1`);
    const r = rows[0];
    const value: PriceBook = !r
      ? { version: 'pricebook_2026-10-06', vatBps: 750, platformFeeBps: 1000, perKmKobo: 20000 }
      : { version: String(r.version), vatBps: Number(r.vat_bps), platformFeeBps: Number(r.platform_fee_bps), perKmKobo: Number(r.per_km_kobo) };
    priceBookCache = { at: Date.now(), value };
    return value;
  },
  async flags(): Promise<Record<string, boolean>> {
    if (flagsCache && Date.now() - flagsCache.at < CACHE_TTL_MS) return { ...flagsCache.value };
    const rows = await q<{ key: string; value: boolean }>(`SELECT key, value FROM configuration.flag`);
    const flags = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    try {
      const { config } = await import('../../packages/config/env.js');
      const launchCity = config.GEOLOCK_CITY?.split(',')[0]?.trim().toLowerCase();
      if (launchCity) (flags as any).launchCity = launchCity;
    } catch {}
    flagsCache = { at: Date.now(), value: flags };
    return { ...flags };
  },
  async setFlag(k: string, v: boolean, actor: string) {
    const exists = await q(`SELECT 1 FROM configuration.flag WHERE key=$1`, [k]);
    if (exists.length === 0) await q(`INSERT INTO configuration.flag (key, value, updated_by) VALUES ($1,$2,$3)`, [k, v, actor]);
    else await q(`UPDATE configuration.flag SET value=$2, updated_by=$3 WHERE key=$1`, [k, v, actor]);
    flagsCache = null; // admin just changed it — next read must be fresh
    return { k, v };
  },
  dispatchPolicy(name = 'default') { void name; return { radiusKm: 15 }; },
};
