// Dispatch — hard eligibility filters first, then configurable scoring.
// Ratings/loads read from provider.quality; fairness from assignment counts.
import { providerService } from '../providers/provider.service.js';
import { catalogService } from '../catalog/catalog.service.js';
import { q } from '../../packages/database/db.js';
import { observability } from '../../packages/observability/watchup.adapter.js';
import { geoService } from '../geo/geo.service.js';

export interface Candidate { providerId: string; score: number; distanceKm: number }
const WEIGHTS = { distance: 0.5, rating: 0.25, workload: 0.15, fairness: 0.1 };

function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371; const dLa = ((b[0] - a[0]) * Math.PI) / 180; const dLo = ((b[1] - a[1]) * Math.PI) / 180;
  const s = Math.sin(dLa / 2) ** 2 + Math.cos((a[0] * Math.PI) / 180) * Math.cos((b[0] * Math.PI) / 180) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const OFFER_SLA_SECONDS = Number(process.env.DISPATCH_OFFER_SLA_SECONDS ?? 180);

export const dispatchService = {
  weights: WEIGHTS,
  async findCandidates(job: { serviceId: string; lat: number; lng: number; radiusKm?: number }): Promise<Candidate[]> {
    const svc = await catalogService.get(job.serviceId);
    const catRow = await q<{ category_id: string }>(`SELECT category_id FROM catalog.service WHERE id=$1`, [job.serviceId]);
    const categoryId = catRow[0]?.category_id ? String(catRow[0].category_id) : null;
    const { vendorEligibilityService } = await import('../vendors/eligibility.service.js');
    const radius = job.radiusKm ?? 15;
    const userZone = await geoService.checkZone(job.lat, job.lng);
    const out: Candidate[] = [];
    for (const p of await providerService.allOnline()) {
      if (svc?.requiresSkill && !p.skills.includes(svc.requiresSkill)) continue;
      if (p.lat === undefined || p.lng === undefined) continue;
      
      const providerZone = await geoService.checkZone(p.lat, p.lng);
      // Strict city match required for dispatch (Uber/Bolt model)
      if (!userZone.serviceable || !providerZone.serviceable || userZone.cityId !== providerZone.cityId) continue;
      
      const d = haversineKm([job.lat, job.lng], [p.lat, p.lng]);
      if (d > radius) continue;
      if (svc?.requiresSkill) {
        const prov = await q<{ kyc_status: string }>(`SELECT kyc_status FROM provider.provider WHERE id=$1`, [p.id]);
        if (prov[0]?.kyc_status !== 'VERIFIED') continue; // skilled work needs KYC
      }
      // Category rules (KYC tier, face match, licence, capacity) decide who may be offered the job.
      if (!(await vendorEligibilityService.allowed(p.id, categoryId))) continue;
      const qual = await q<Record<string, unknown>>(`SELECT * FROM provider.quality WHERE provider_id=$1`, [p.id]);
      const rating = Number(qual[0]?.rating ?? 4.5) || 4.5;
      const loadRows = await q<{ c: number }>(`SELECT count(*) c FROM dispatch.assignment WHERE provider_id=$1 AND status='accepted'`, [p.id]);
      const load = Number(loadRows[0]?.c ?? 0);
      const score = 100 - WEIGHTS.distance * d * 4 + WEIGHTS.rating * rating * 10 - WEIGHTS.workload * load * 5 + Math.random() * WEIGHTS.fairness * 10;
      out.push({ providerId: p.id, score: Math.round(score * 10) / 10, distanceKm: Math.round(d * 100) / 100 });
    }
    return out.sort((a, b) => b.score - a.score);
  },
  async assign(jobId: string, providerId: string, expiresInSeconds?: number) {
    const sla = expiresInSeconds ?? OFFER_SLA_SECONDS;
    // offer() takes the SLA in seconds (it was being handed a Date, which made
    // every offer INSERT fail with an interval parse error).
    const offer = await providerService.offer(jobId, providerId, sla);
    try { observability.track('dispatch.assigned', { jobId, providerId }); } catch { /* fail open */ }
    return offer;
  },
  getSlaSeconds() {
    return OFFER_SLA_SECONDS;
  },
  async expireOverdueOffers() {
    // Two-step (select then update by id) so the relative-time comparison is
    // evaluated in JS: pg-mem ignores NOW() in an UPDATE's WHERE clause.
    const rows = await q<{ id: string; expires_at: unknown }>(
      `SELECT id, expires_at FROM dispatch.assignment WHERE status='offered' AND expires_at IS NOT NULL`,
    );
    const now = Date.now();
    for (const r of rows) {
      if (new Date(String(r.expires_at)).getTime() < now) {
        await q(`UPDATE dispatch.assignment SET status='expired' WHERE id=$1`, [r.id]);
      }
    }
  },
  async getJobCandidatesWithStatus(jobId: string) {
    const rows = await q<Record<string, unknown>>(`SELECT provider_id, status FROM dispatch.assignment WHERE job_id=$1`, [jobId]);
    return rows.map(r => ({ providerId: String(r.provider_id), status: String(r.status) }));
  },
  async allCandidatesExhausted(jobId: string) {
    const rows = await q<Record<string, unknown>>(`SELECT 1 FROM dispatch.assignment WHERE job_id=$1 AND status IN ('offered', 'accepted')`, [jobId]);
    if (rows.length > 0) return false;
    // Check if there are any candidates at all that were considered - but also if all offered/declined/expired
    // Another check: any pending offered?
    const pending = await q<Record<string, unknown>>(`SELECT 1 FROM dispatch.assignment WHERE job_id=$1 AND status='offered'`, [jobId]);
    if (pending.length > 0) return false;
    // If there exists at least one assignment that's declined/expired or if we want to know if we've tried all from candidates pool
    // For the requirement: "After ALL candidates are exhausted (declined/expired/none left)"
    return true;
  },
  async escalateNext(jobId: string, serviceId: string, lat: number, lng: number) {
    // Get all provider IDs already considered for this job
    const considered = await q<Record<string, unknown>>(`SELECT provider_id FROM dispatch.assignment WHERE job_id=$1`, [jobId]);
    const consideredSet = new Set(considered.map(r => String(r.provider_id)));
    
    const candidates = await this.findCandidates({ serviceId, lat, lng });
    const next = candidates.find(c => !consideredSet.has(c.providerId));
    if (next) {
      await this.assign(jobId, next.providerId);
      return true;
    }
    return false;
  },
};
