// Trains the vendor-matching model on Kendibo's own outcomes.
//
// Label per (request, vendor shown): 1 when the vendor accepted the job AND it
// was not later cancelled/failed (a rating of 1–2 also counts as 0); 0 when they
// were shown but did not win or the job went badly. "Chosen by the customer"
// is kept as a separate signal for analysis.
//
// Split by request (not by row) so one request's vendors never sit in both
// train and test. Activation guard: the new model must reach AUC ≥ 0.6 on the
// holdout and not be worse than the active one, with at least MIN_ROWS rows.
import { q } from '../../packages/database/db.js';
import { emit } from '../../packages/observability/emit.js';
import { FEATURES, DEFAULT_WEIGHTS, score, resetModelCache, type FeatureVector, type ModelWeights } from './matching.service.js';

export const MIN_ROWS = 200;
const GOOD = new Set(['COMPLETED', 'CUSTOMER_CONFIRMATION', 'SETTLEMENT', 'WARRANTY_ACTIVE', 'CLOSED']);

/** Fill accepted/completed/rating on logged rankings from what really happened. */
export async function backfillLabels(): Promise<number> {
  const rows = await q<{ id: string; request_id: string; provider_id: string }>(
    `SELECT id, request_id, provider_id FROM ml.match_event WHERE accepted IS NULL AND created_at < now() - interval '2 hours' LIMIT 5000`,
  ).catch(() => []);
  let n = 0;
  for (const r of rows) {
    const offer = await q<{ status: string }>(`SELECT status FROM booking.request_offer WHERE request_id=$1 AND provider_id=$2`, [r.request_id, r.provider_id]).catch(() => []);
    const accepted = String(offer[0]?.status ?? '') === 'accepted';
    let completed: boolean | null = null; let rating: number | null = null;
    if (accepted) {
      const b = await q<{ id: string; status: string }>(
        `SELECT b.id, b.status FROM booking.service_request s JOIN booking.booking b ON b.id = s.booking_id WHERE s.id=$1`, [r.request_id],
      ).catch(() => []);
      if (b[0]) {
        completed = GOOD.has(String(b[0].status)) ? true : String(b[0].status) === 'CANCELLED' ? false : null;
        const rev = await q<{ provider: number }>(`SELECT provider FROM payment.review WHERE booking_id=$1 LIMIT 1`, [String(b[0].id)]).catch(() => []);
        rating = rev[0] ? Number(rev[0].provider) : null;
      }
    }
    await q(`UPDATE ml.match_event SET accepted=$2, completed=$3, rating=$4 WHERE id=$1`, [r.id, accepted, completed, rating]).catch(() => undefined);
    n++;
  }
  return n;
}

export interface Example { requestId: string; x: FeatureVector; y: 0 | 1 }

export function labelOf(e: { accepted: boolean | null; completed: boolean | null; rating: number | null }): 0 | 1 {
  if (!e.accepted) return 0;
  if (e.completed === false) return 0;
  if (e.rating !== null && e.rating <= 2) return 0;
  return 1;
}

/** Plain batch gradient descent on logistic loss with L2. Deterministic. */
export function fit(train: Example[], opts: { epochs?: number; lr?: number; l2?: number } = {}): ModelWeights {
  const epochs = opts.epochs ?? 400; const lr = opts.lr ?? 0.5; const l2 = opts.l2 ?? 0.01;
  const m: ModelWeights = { bias: DEFAULT_WEIGHTS.bias, w: { ...DEFAULT_WEIGHTS.w } };
  if (!train.length) return m;
  for (let e = 0; e < epochs; e++) {
    let gb = 0; const g: Record<string, number> = Object.fromEntries(FEATURES.map((k) => [k, 0]));
    for (const ex of train) {
      const err = score(ex.x, m) - ex.y;
      gb += err;
      for (const k of FEATURES) g[k] += err * (ex.x[k] ?? 0);
    }
    m.bias -= (lr * gb) / train.length;
    for (const k of FEATURES) m.w[k] -= lr * (g[k] / train.length + l2 * m.w[k]);
  }
  return m;
}

/** Rank-based AUC (probability a random positive outscores a random negative). */
export function auc(examples: Example[], m: ModelWeights): number {
  const pos = examples.filter((e) => e.y === 1).map((e) => score(e.x, m));
  const neg = examples.filter((e) => e.y === 0).map((e) => score(e.x, m));
  if (!pos.length || !neg.length) return 0.5;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

const holdout = (requestId: string) => {
  let h = 0; for (const c of requestId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 5 === 0; // ~20% of requests
};

export async function trainAndMaybeActivate(): Promise<{ rows: number; version: number | null; auc: number; baselineAuc: number; activated: boolean; reason: string }> {
  await backfillLabels();
  const raw = await q<{ request_id: string; features: FeatureVector | string; accepted: boolean | null; completed: boolean | null; rating: number | null }>(
    `SELECT request_id, features, accepted, completed, rating FROM ml.match_event WHERE accepted IS NOT NULL`,
  ).catch(() => []);
  const data: Example[] = raw.map((r) => ({
    requestId: String(r.request_id),
    x: (typeof r.features === 'string' ? JSON.parse(r.features) : r.features) as FeatureVector,
    y: labelOf(r),
  }));
  const train = data.filter((e) => !holdout(e.requestId));
  const test = data.filter((e) => holdout(e.requestId));
  const current = await q<{ weights: ModelWeights | string; version: number }>(
    `SELECT weights, version FROM ml.model WHERE name='vendor_match' AND active ORDER BY version DESC LIMIT 1`,
  ).catch(() => []);
  const curW = current[0] ? (typeof current[0].weights === 'string' ? JSON.parse(current[0].weights) : current[0].weights) as ModelWeights : DEFAULT_WEIGHTS;
  const baselineAuc = auc(test, curW);
  if (data.length < MIN_ROWS) return { rows: data.length, version: null, auc: baselineAuc, baselineAuc, activated: false, reason: `Need ${MIN_ROWS} labelled rankings, have ${data.length}. Keep the cold-start weights.` };

  const model = fit(train);
  const newAuc = auc(test, model);
  const last = await q<{ v: number | null }>(`SELECT MAX(version) AS v FROM ml.model WHERE name='vendor_match'`).catch(() => [{ v: 0 }]);
  const version = Number(last[0]?.v ?? 0) + 1;
  const activate = newAuc >= 0.6 && newAuc >= baselineAuc - 0.005;
  if (activate) await q(`UPDATE ml.model SET active=FALSE WHERE name='vendor_match'`);
  await q(
    `INSERT INTO ml.model (name, version, weights, metrics, trained_rows, active) VALUES ('vendor_match',$1,$2,$3,$4,$5)`,
    [version, JSON.stringify(model), JSON.stringify({ auc: newAuc, baselineAuc, train: train.length, test: test.length }), data.length, activate],
  );
  resetModelCache();
  emit('matching.model_trained', { version, auc: newAuc, baselineAuc, activated: activate });
  return { rows: data.length, version, auc: newAuc, baselineAuc, activated: activate, reason: activate ? 'Activated' : 'Kept the current model (no holdout improvement)' };
}
