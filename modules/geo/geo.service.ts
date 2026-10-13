// Geo + Tracking — zones, geocode stubs (MapsPort adapter boundary), provider location w/ active-journey guard.
// Batch points persist to geo.provider_location; read path stays journey-gated.
import { q } from '../../packages/database/db.js';
import { config as appConfig } from '../../packages/config/env.js';

// checkZone/coverage run on every address save and booking start; zones and
// cities are launch reference data (a handful of rows, change rarely). A short
// memo removes two full-table scans per call against the cross-WAN Postgres.
const ZONE_TTL_MS = 60_000;
let zoneRowsCache: { at: number; rows: any[] } | null = null;
let cityRowsCache: { at: number; rows: any[] } | null = null;

async function zoneRows(): Promise<any[]> {
  if (zoneRowsCache && Date.now() - zoneRowsCache.at < ZONE_TTL_MS) return zoneRowsCache.rows;
  const rows = await q<any>(
    `SELECT z.name as zone, c.id as city_id, c.name as city, z.radius_km AS "radiusKm", z.lat, z.lng
       FROM geo.zone z JOIN geo.city c ON z.city_id = c.id`,
  );
  zoneRowsCache = { at: Date.now(), rows };
  return rows;
}
async function cityRows(): Promise<any[]> {
  if (cityRowsCache && Date.now() - cityRowsCache.at < ZONE_TTL_MS) return cityRowsCache.rows;
  const rows = await q<any>(
    `SELECT id, name, lat, lng, radius_km FROM geo.city WHERE lat IS NOT NULL AND lng IS NOT NULL ORDER BY name`,
  );
  cityRowsCache = { at: Date.now(), rows };
  return rows;
}

export const geoService = {
  /** Cities allowed by GEOLOCK_CITY (empty lock = all). */
  allowed(): string[] {
    return appConfig.GEOLOCK_CITY
      ? appConfig.GEOLOCK_CITY.split(',').map((c) => c.trim().toLowerCase())
      : [];
  },

  /**
   * City-wide serviceability: named zones first (hotspots), then the whole
   * city circle (geo.city.lat/lng + radius_km) so Uyo & Eket are covered
   * everywhere inside the city, not only around the seed zones.
   */
  async checkZone(lat: number, lng: number) {
    const allowed = this.allowed();
    const inLock = (id: string, name: string) =>
      allowed.length === 0 ||
      allowed.includes(id.toLowerCase()) ||
      allowed.includes(name.toLowerCase());

    const zones = await zoneRows();
    for (const z of zones) {
      if (!inLock(String(z.city_id), String(z.city))) continue;
      const d = Math.hypot(lat - z.lat, lng - z.lng) * 111; // approx km
      if (d <= Number(z.radiusKm)) {
        return {
          serviceable: true, scope: 'zone' as const,
          city: String(z.city), cityId: String(z.city_id), zone: String(z.zone),
          lat: Number(z.lat), lng: Number(z.lng), radiusKm: Number(z.radiusKm),
        };
      }
    }

    const cities = await cityRows();
    for (const c of cities) {
      if (!inLock(String(c.id), String(c.name))) continue;
      const d = Math.hypot(lat - c.lat, lng - c.lng) * 111;
      if (d <= Number(c.radius_km)) {
        return {
          serviceable: true, scope: 'city' as const,
          city: String(c.name), cityId: String(c.id), zone: String(c.name),
          lat: Number(c.lat), lng: Number(c.lng), radiusKm: Number(c.radius_km),
        };
      }
    }
    return { serviceable: false as const };
  },

  /**
   * Supported coverage for the client: every city + zone the lock allows,
   * with the exact latitude/longitude a user can check themselves against.
   */
  async coverage() {
    const allowed = this.allowed();
    const inLock = (id: string, name: string) =>
      allowed.length === 0 ||
      allowed.includes(id.toLowerCase()) ||
      allowed.includes(name.toLowerCase());

    // zoneRows aliases radius_km AS "radiusKm" — the old inline SELECT did
    // not, so coverage() z.radiusKm was undefined → NaN radiusKm payloads.
    const cities = await cityRows();
    const zones = await zoneRows();

    return cities
      .filter((c) => inLock(String(c.id), String(c.name)))
      .map((c) => ({
        cityId: String(c.id),
        city: String(c.name),
        lat: Number(c.lat),
        lng: Number(c.lng),
        radiusKm: Number(c.radius_km),
        zones: zones
          .filter((z) => String(z.city_id) === String(c.id))
          .map((z) => ({
            zone: String(z.zone),
            lat: Number(z.lat),
            lng: Number(z.lng),
            radiusKm: Number(z.radius_km),
          })),
      }));
  },
  async openJourney(jobId: string) {
    const rows = await q(`SELECT 1 FROM geo.journey_status WHERE job_id=$1`, [jobId]);
    if (rows.length === 0) await q(`INSERT INTO geo.journey_status (job_id, is_active) VALUES ($1, true)`, [jobId]);
    else await q(`UPDATE geo.journey_status SET is_active = true WHERE job_id=$1`, [jobId]);
  },
  async closeJourney(jobId: string) {
    await q(`UPDATE geo.journey_status SET is_active = false WHERE job_id=$1`, [jobId]);
  },
  async isJourneyActive(jobId: string) {
    const rows = await q<{ is_active: boolean }>(`SELECT is_active FROM geo.journey_status WHERE job_id=$1`, [jobId]);
    return rows[0]?.is_active ?? false;
  },
  haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
    const R = 6371; const dLa = ((bLat - aLat) * Math.PI) / 180; const dLo = ((bLng - aLng) * Math.PI) / 180;
    const s = Math.sin(dLa / 2) ** 2 + Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLo / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  },
  async etaMinutes(jobId: string, addressId: string): Promise<number> { 
    // Dynamically calculate ETA based on provider's last location and property address
    const providers = await q<any>(`SELECT lat, lng FROM geo.provider_location WHERE provider_id = (SELECT provider_id FROM booking.booking WHERE id = $1 LIMIT 1) ORDER BY created_at DESC LIMIT 1`, [jobId]);
    const address = await q<any>(`SELECT lat, lng FROM property.address WHERE id=$1`, [addressId]);
    if (providers[0] && address[0]) {
       const d = this.haversineKm(Number(providers[0].lat), Number(providers[0].lng), Number(address[0].lat), Number(address[0].lng));
       return Math.round(d * 3 + 5);
    }
    return 15; // default fallback
  },
  async providerLocation(jobId: string, lat: number, lng: number) {
    if (!(await this.isJourneyActive(jobId))) throw new Error('LOCATION_CLOSED'); // only during active journey
    const booking = await q<any>(`SELECT provider_id FROM booking.booking WHERE id=$1`, [jobId]);
    if (booking[0]?.provider_id) {
       await q(`INSERT INTO geo.provider_location (provider_id, lat, lng) VALUES ($1,$2,$3)`, [booking[0].provider_id, lat, lng]);
    }
    return { jobId, lat, lng, at: new Date().toISOString() };
  },
  /** Batch ingest from Android tracker: validates + caps; read path stays journey-gated. */
  async ingestBatch(providerId: string, points: { lat: number; lng: number; at: string }[]) {
    if (points.length > 100) throw new Error('BATCH_TOO_LARGE');
    let applied = 0, rejected = 0;
    for (const p of points) {
      if (typeof p.lat !== 'number' || typeof p.lng !== 'number') { rejected++; continue; }
      if (Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) { rejected++; continue; }
      try {
        await q(`INSERT INTO geo.provider_location (provider_id, lat, lng) VALUES ($1,$2,$3)`, [providerId, p.lat, p.lng]);
        applied++;
      } catch { rejected++; }
    }
    return { applied, rejected };
  },
  async batchFor(providerId: string) {
    try {
      return await q(`SELECT lat, lng, created_at AS at FROM geo.provider_location WHERE provider_id=$1 ORDER BY created_at DESC LIMIT 500`, [providerId]);
    } catch { return []; }
  },
};
