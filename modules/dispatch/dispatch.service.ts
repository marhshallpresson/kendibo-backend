// Dispatch — hard eligibility filters first, then configurable scoring.
// Ratings/loads read from provider.quality; fairness from assignment counts.
import { providerService } from '../providers/provider.service.js';
import { catalogService } from '../catalog/catalog.service.js';
import { q } from '../../packages/database/db.js';
import { observability } from '../../packages/observability/watchup.adapter.js';

export interface Candidate { providerId: string; score: number; distanceKm: number }
const WEIGHTS = { distance: 0.5, rating: 0.25, workload: 0.15, fairness: 0.1 };

function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371; const dLa = ((b[0] - a[0]) * Math.PI) / 180; const dLo = ((b[1] - a[1]) * Math.PI) / 180;
  const s = Math.sin(dLa / 2) ** 2 + Math.cos((a[0] * Math.PI) / 180) * Math.cos((b[0] * Math.PI) / 180) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export const dispatchService = {
  weights: WEIGHTS,
  async findCandidates(job: { serviceId: string; lat: number; lng: number; radiusKm?: number }): Promise<Candidate[]> {
    const svc = await catalogService.get(job.serviceId);
    const radius = job.radiusKm ?? 15;
    const out: Candidate[] = [];
    for (const p of await providerService.allOnline()) {
      if (svc?.requiresSkill && !p.skills.includes(svc.requiresSkill)) continue;
      if (p.lat === undefined || p.lng === undefined) continue;
      const d = haversineKm([job.lat, job.lng], [p.lat, p.lng]);
      if (d > radius) continue;
      if (svc?.requiresSkill) {
        const prov = await q<{ kyc_status: string }>(`SELECT kyc_status FROM provider.provider WHERE id=$1`, [p.id]);
        if (prov[0]?.kyc_status !== 'VERIFIED') continue; // skilled work needs KYC
      }
      const qual = await q<Record<string, unknown>>(`SELECT * FROM provider.quality WHERE provider_id=$1`, [p.id]);
      const rating = Number(qual[0]?.rating ?? 4.5) || 4.5;
      const loadRows = await q<{ c: number }>(`SELECT count(*) c FROM dispatch.assignment WHERE provider_id=$1 AND status='accepted'`, [p.id]);
      const load = Number(loadRows[0]?.c ?? 0);
      const score = 100 - WEIGHTS.distance * d * 4 + WEIGHTS.rating * rating * 10 - WEIGHTS.workload * load * 5 + Math.random() * WEIGHTS.fairness * 10;
      out.push({ providerId: p.id, score: Math.round(score * 10) / 10, distanceKm: Math.round(d * 100) / 100 });
    }
    return out.sort((a, b) => b.score - a.score);
  },
  async assign(jobId: string, providerId: string) {
    const offer = await providerService.offer(jobId, providerId);
    try { observability.track('dispatch.assigned', { jobId, providerId }); } catch { /* fail open */ }
    return offer;
  },
};
