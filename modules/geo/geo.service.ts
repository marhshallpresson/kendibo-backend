// Geo + Tracking — zones, geocode stubs (MapsPort adapter boundary), provider location w/ active-journey guard.
// Batch points persist to geo.provider_location; read path stays journey-gated.
import { q } from '../../packages/database/db.js';
import { config as appConfig } from '../../packages/config/env.js';

export const geoService = {
  async checkZone(lat: number, lng: number) {
    const zones = await q<any>(`SELECT z.name as zone, c.id as city_id, c.name as city, z.radius_km as radiusKm, z.lat, z.lng FROM geo.zone z JOIN geo.city c ON z.city_id = c.id`);
    for (const z of zones) {
      // If GEOLOCK_CITY is defined, skip zones that don't match the geolock city
      if (appConfig.GEOLOCK_CITY && z.city_id !== appConfig.GEOLOCK_CITY && z.city !== appConfig.GEOLOCK_CITY) continue;
      
      const d = Math.hypot(lat - z.lat, lng - z.lng) * 111; // approx km
      if (d <= Number(z.radiuskm)) return { serviceable: true, city: String(z.city), cityId: String(z.city_id), zone: String(z.zone), lat: Number(z.lat), lng: Number(z.lng), radiusKm: Number(z.radiuskm) };
    }
    return { serviceable: false as const };
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
  async etaMinutes(jobId: string, addressId: string): Promise<number> { 
    // Dynamically calculate ETA based on provider's last location and property address
    const providers = await q<any>(`SELECT lat, lng FROM geo.provider_location WHERE provider_id = (SELECT provider_id FROM booking.booking WHERE id = $1 LIMIT 1) ORDER BY created_at DESC LIMIT 1`, [jobId]);
    const address = await q<any>(`SELECT lat, lng FROM property.address WHERE id=$1`, [addressId]);
    if (providers[0] && address[0]) {
       const d = Math.hypot(Number(providers[0].lat) - Number(address[0].lat), Number(providers[0].lng) - Number(address[0].lng)) * 111;
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
