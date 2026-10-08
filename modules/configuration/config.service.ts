// Configuration — versioned data from Postgres (never code deploys).
import { q } from '../../packages/database/db.js';

export interface PriceBook { version: string; vatBps: number; platformFeeBps: number; perKmKobo: number }
export const configurationService = {
  async priceBook(): Promise<PriceBook> {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM catalog.pricebook ORDER BY effective_from DESC LIMIT 1`);
    const r = rows[0];
    if (!r) return { version: 'pricebook_2026-10-06', vatBps: 750, platformFeeBps: 1000, perKmKobo: 20000 };
    return { version: String(r.version), vatBps: Number(r.vat_bps), platformFeeBps: Number(r.platform_fee_bps), perKmKobo: Number(r.per_km_kobo) };
  },
  async flags(): Promise<Record<string, boolean>> {
    const rows = await q<{ key: string; value: boolean }>(`SELECT key, value FROM configuration.flag`);
    const flags = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    try {
      const { config } = await import('../../packages/config/env.js');
      const launchCity = config.GEOLOCK_CITY?.split(',')[0]?.trim().toLowerCase();
      if (launchCity) (flags as any).launchCity = launchCity;
    } catch {}
    return flags;
  },
  async setFlag(k: string, v: boolean, actor: string) {
    const exists = await q(`SELECT 1 FROM configuration.flag WHERE key=$1`, [k]);
    if (exists.length === 0) await q(`INSERT INTO configuration.flag (key, value, updated_by) VALUES ($1,$2,$3)`, [k, v, actor]);
    else await q(`UPDATE configuration.flag SET value=$2, updated_by=$3 WHERE key=$1`, [k, v, actor]);
    return { k, v };
  },
  dispatchPolicy(name = 'default') { void name; return { radiusKm: 15 }; },
};
