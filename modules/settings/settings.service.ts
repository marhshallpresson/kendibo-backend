// COMPAT MODULE — recreated locally because the original was missing from this
// checkout (imported by modules/kyc/kyc.service.ts). Replace with the version
// from marhshallpresson/kendibo-backend when the repo is synced.
//
// Reads/writes configuration.platform_setting (key TEXT, value JSONB), the same
// table modules/geo/maps.port.ts uses for the map-provider switch.
import { q } from '../../packages/database/db.js';

export async function getSetting<T = unknown>(key: string): Promise<T | null> {
  const rows = await q<{ value: unknown }>(`SELECT value FROM configuration.platform_setting WHERE key=$1`, [key]).catch(() => []);
  if (!rows[0]) return null;
  const v = rows[0].value;
  // pg returns JSONB parsed; pg-mem may hand back the raw string.
  if (typeof v === 'string') {
    try { return JSON.parse(v) as T; } catch { return v as unknown as T; }
  }
  return v as T;
}

export async function setSetting(key: string, value: unknown, updatedBy?: string): Promise<void> {
  await q(`DELETE FROM configuration.platform_setting WHERE key=$1`, [key]);
  await q(
    `INSERT INTO configuration.platform_setting (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, now())`,
    [key, JSON.stringify(value), updatedBy ?? null],
  );
}
