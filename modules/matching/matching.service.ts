// Vendor matching — "which verified vendors should this customer see, in what
// order, and why?"
//
// 1. Hard filters (never learned): trade eligibility (category rules), active
//    account, within the service radius of the job.
// 2. Learned ranking: a logistic-regression model over explainable features.
//    It starts from hand-set weights (cold start) and is retrained from OUR
//    outcomes — every list shown is logged to ml.match_event with its features,
//    then labelled with what happened (offer accepted, job completed, rating).
//    See scripts/train-matcher.ts.
// 3. Reasons: the top contributing features become plain-language lines
//    ("4.8 from 23 reviews · 2.1 km away · fits your ₦20,000 budget").
//
// Exact vendor coordinates are never returned — only rounded distance.
import { q } from '../../packages/database/db.js';
import { emit } from '../../packages/observability/emit.js';
import { vendorEligibilityService } from '../vendors/eligibility.service.js';

export const FEATURES = ['dist', 'rating', 'reviews', 'jobs', 'accept', 'ontime', 'reliability', 'text', 'budget', 'online', 'newcomer'] as const;
export type FeatureName = (typeof FEATURES)[number];
export type FeatureVector = Record<FeatureName, number>;
export interface ModelWeights { bias: number; w: Record<FeatureName, number> }

// Cold-start weights: proximity and trust first, with a small boost so new,
// verified vendors still get seen (marketplace fairness).
export const DEFAULT_WEIGHTS: ModelWeights = {
  bias: -3,
  w: { dist: 2.0, rating: 1.2, reviews: 0.6, jobs: 0.6, accept: 0.8, ontime: 0.8, reliability: 0.6, text: 1.2, budget: 0.8, online: 0.7, newcomer: 0.3 },
};

export interface MatchRequest {
  requestId?: string;
  categoryId: string | null;
  lat: number; lng: number;
  need?: string | null;
  budgetKobo?: bigint | null;
  serviceId?: string | null;
}
export interface RankedVendor {
  providerId: string; name: string; score: number; distanceKm: number;
  rating: number | null; reviewCount: number; completedJobs: number;
  badges: { identityVerified: boolean; faceVerified: boolean; businessRegistered: boolean };
  reasons: string[]; slug: string | null; online: boolean;
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const clamp01 = (x: number) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));

export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371; const r = Math.PI / 180;
  const dLat = (bLat - aLat) * r; const dLng = (bLng - aLng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const STOP = new Set(['the', 'and', 'for', 'my', 'is', 'in', 'of', 'to', 'a', 'an', 'it', 'on', 'at', 'with', 'i', 'need', 'please', 'abeg', 'dey', 'wey', 'fix', 'help']);
const tokens = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOP.has(t)));
export function textMatch(need: string, profile: string): number {
  const a = tokens(need); const b = tokens(profile);
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const t of a) if (b.has(t) || [...b].some((x) => x.startsWith(t.slice(0, 5)) && t.length >= 5)) hit++;
  return clamp01(hit / Math.min(a.size, 6));
}

export function score(f: FeatureVector, m: ModelWeights = DEFAULT_WEIGHTS): number {
  let z = m.bias;
  for (const k of FEATURES) z += (m.w[k] ?? 0) * (f[k] ?? 0);
  return sigmoid(z);
}

let cache: { at: number; version: number; weights: ModelWeights } | null = null;
export async function activeModel(): Promise<{ version: number; weights: ModelWeights }> {
  if (cache && Date.now() - cache.at < 60_000) return cache;
  const rows = await q<{ version: number; weights: ModelWeights }>(
    `SELECT version, weights FROM ml.model WHERE name='vendor_match' AND active ORDER BY version DESC LIMIT 1`,
  ).catch(() => []);
  const w = rows[0] ? (typeof rows[0].weights === 'string' ? JSON.parse(rows[0].weights) : rows[0].weights) as ModelWeights : DEFAULT_WEIGHTS;
  cache = { at: Date.now(), version: rows[0] ? Number(rows[0].version) : 0, weights: w };
  return cache;
}
export function resetModelCache() { cache = null; }

const naira = (k: bigint | number) => `₦${(Number(k) / 100).toLocaleString('en-NG', { maximumFractionDigits: 0 })}`;

function reasonsFor(f: FeatureVector, v: { distanceKm: number; rating: number | null; reviewCount: number; completedJobs: number; budgetKobo?: bigint | null; online: boolean }, m: ModelWeights): string[] {
  const parts: { w: number; text: string }[] = [];
  if (v.rating !== null && v.reviewCount > 0) parts.push({ w: m.w.rating * f.rating + m.w.reviews * f.reviews, text: `${v.rating.toFixed(1)} from ${v.reviewCount} review${v.reviewCount === 1 ? '' : 's'}` });
  else parts.push({ w: 0.1, text: 'New on Kendibo' });
  parts.push({ w: m.w.dist * f.dist, text: `${v.distanceKm < 1 ? 'Under 1' : v.distanceKm.toFixed(1)} km away` });
  if (v.completedJobs > 0) parts.push({ w: m.w.jobs * f.jobs, text: `${v.completedJobs} job${v.completedJobs === 1 ? '' : 's'} done` });
  if (f.text >= 0.34) parts.push({ w: m.w.text * f.text, text: 'Matches what you described' });
  if (v.budgetKobo && f.budget >= 0.99) parts.push({ w: m.w.budget * f.budget, text: `Usually within ${naira(v.budgetKobo)}` });
  if (v.online) parts.push({ w: m.w.online, text: 'Available now' });
  return parts.sort((a, b) => b.w - a.w).slice(0, 3).map((p) => p.text);
}

export const matchingService = {
  /** Feature vector for one vendor and one job. Pure given its inputs. */
  features(input: {
    distanceKm: number; radiusKm: number; avgRating: number | null; reviewCount: number; completedJobs: number;
    acceptanceRate: number; onTime: number; cancellations: number; need: string; profile: string;
    budgetKobo?: bigint | null; typicalKobo?: bigint | null; online: boolean;
  }): FeatureVector {
    // Bayesian average pulls thin review histories toward a 4.2 prior.
    const bayes = input.reviewCount > 0 && input.avgRating !== null
      ? (input.avgRating * input.reviewCount + 4.2 * 5) / (input.reviewCount + 5) : 4.2;
    let budget = 0.5;
    if (input.budgetKobo && input.budgetKobo > 0n && input.typicalKobo && input.typicalKobo > 0n) {
      budget = input.typicalKobo <= input.budgetKobo ? 1 : Number(input.budgetKobo) / Number(input.typicalKobo);
    }
    return {
      dist: clamp01(Math.exp(-input.distanceKm / Math.max(3, input.radiusKm / 3))),
      rating: clamp01((bayes - 3) / 2),
      reviews: clamp01(Math.log1p(input.reviewCount) / Math.log1p(50)),
      jobs: clamp01(Math.log1p(input.completedJobs) / Math.log1p(100)),
      accept: clamp01(input.acceptanceRate),
      ontime: clamp01(input.onTime),
      reliability: clamp01(1 - input.cancellations / 10),
      text: input.need ? textMatch(input.need, input.profile) : 0,
      budget: clamp01(budget),
      online: input.online ? 1 : 0,
      newcomer: input.completedJobs === 0 ? 1 : 0,
    };
  },

  async rank(req: MatchRequest, limit = 8): Promise<RankedVendor[]> {
    const model = await activeModel();
    const rows = await q<Record<string, unknown>>(
      `SELECT p.id, p.business_name, p.lat, p.lng, p.online, p.status, p.service_radius_km, p.slug, p.headline, p.bio,
              p.face_verified, p.cac_verified, p.kyc_status, u.name AS user_name
         FROM provider.provider p LEFT JOIN identity.users u ON u.id = p.user_id
        WHERE p.lat IS NOT NULL AND p.lng IS NOT NULL`,
    );
    let typicalKobo: bigint | null = null;
    if (req.serviceId) {
      const s = await q<{ base_price_kobo: string }>(`SELECT base_price_kobo FROM catalog.service WHERE id=$1`, [req.serviceId]).catch(() => []);
      typicalKobo = s[0] ? BigInt(String(s[0].base_price_kobo)) : null;
    } else if (req.categoryId) {
      const s = await q<{ p: string | null }>(`SELECT MIN(base_price_kobo) AS p FROM catalog.service WHERE category_id=$1 AND base_price_kobo > 0`, [req.categoryId]).catch(() => []);
      typicalKobo = s[0]?.p ? BigInt(String(s[0].p).split('.')[0]) : null;
    }
    const out: (RankedVendor & { features: FeatureVector })[] = [];
    for (const p of rows) {
      if (String(p.status ?? 'active') !== 'active') continue;
      const d = haversineKm(req.lat, req.lng, Number(p.lat), Number(p.lng));
      const radius = Number(p.service_radius_km ?? 15) || 15;
      if (d > radius) continue;
      const id = String(p.id);
      if (!(await vendorEligibilityService.allowed(id, req.categoryId))) continue;
      const [rev, jobs, qual, skills] = await Promise.all([
        q<{ n: string; avg: string | null }>(`SELECT COUNT(*) AS n, AVG(provider) AS avg FROM payment.review WHERE provider_id=$1`, [id]).catch(() => [{ n: '0', avg: null }]),
        q<{ n: string }>(`SELECT COUNT(*) AS n FROM provider.earning WHERE provider_id=$1`, [id]).catch(() => [{ n: '0' }]),
        q<Record<string, unknown>>(`SELECT * FROM provider.quality WHERE provider_id=$1`, [id]).catch(() => []),
        q<{ s: string }>(`SELECT COALESCE(k.skill_tag, k.service_id) AS s FROM provider.skill k WHERE k.provider_id=$1`, [id]).catch(() => []),
      ]);
      const reviewCount = Number(rev[0]?.n ?? 0);
      const avg = rev[0]?.avg != null ? Number(rev[0].avg) : null;
      const completedJobs = Number(jobs[0]?.n ?? 0);
      const profile = [p.business_name, p.headline, p.bio, ...skills.map((s) => s.s)].filter(Boolean).join(' ');
      const f = this.features({
        distanceKm: d, radiusKm: radius, avgRating: avg, reviewCount, completedJobs,
        acceptanceRate: Number(qual[0]?.acceptance_rate ?? 0.8), onTime: Number(qual[0]?.on_time ?? 0.8),
        cancellations: Number(qual[0]?.cancellations ?? 0), need: req.need ?? '', profile,
        budgetKobo: req.budgetKobo ?? null, typicalKobo, online: p.online === true,
      });
      const s = score(f, model.weights);
      const rating = reviewCount > 0 && avg !== null ? Math.round(avg * 10) / 10 : null;
      out.push({
        providerId: id,
        name: String(p.business_name || p.user_name || 'Kendibo vendor'),
        score: Math.round(s * 1000) / 1000,
        distanceKm: Math.round(d * 10) / 10,
        rating, reviewCount, completedJobs,
        badges: { identityVerified: String(p.kyc_status ?? '').toUpperCase() === 'VERIFIED', faceVerified: p.face_verified === true, businessRegistered: p.cac_verified === true },
        reasons: reasonsFor(f, { distanceKm: d, rating, reviewCount, completedJobs, budgetKobo: req.budgetKobo, online: p.online === true }, model.weights),
        slug: p.slug ? String(p.slug) : null,
        online: p.online === true,
        features: f,
      });
    }
    out.sort((a, b) => b.score - a.score);
    const top = out.slice(0, limit);
    if (req.requestId) {
      for (let i = 0; i < top.length; i++) {
        await q(
          `INSERT INTO ml.match_event (request_id, provider_id, rank, score, model_version, features) VALUES ($1,$2,$3,$4,$5,$6)`,
          [req.requestId, top[i].providerId, i + 1, top[i].score, model.version, JSON.stringify(top[i].features)],
        ).catch(() => undefined);
      }
      emit('matching.ranked', { requestId: req.requestId, shown: top.length, modelVersion: model.version });
    }
    return top.map(({ features: _f, ...v }) => v);
  },

  /** Customer picked a vendor from the list — a strong training signal. */
  async markChosen(requestId: string, providerId: string) {
    await q(`UPDATE ml.match_event SET chosen=TRUE WHERE request_id=$1 AND provider_id=$2`, [requestId, providerId]).catch(() => undefined);
  },
};
