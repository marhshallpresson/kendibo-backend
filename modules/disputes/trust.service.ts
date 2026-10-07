// Disputes (bilateral, PRD §34) + Reviews (PRD §44) — Postgres-backed.
import { q } from '../../packages/database/db.js';
import { emit } from '../../packages/observability/emit.js';

export const CUSTOMER_REASONS = ['incomplete', 'poor_quality', 'property_damage', 'misconduct', 'wrong_quote', 'unauthorised_charge', 'missed_appointment', 'billing'] as const;
export const PROVIDER_REASONS = ['false_claim', 'customer_damage', 'unsafe_property', 'non_payment', 'wrong_scope', 'unfair_rating'] as const;
export type Resolution = 'no_adjustment' | 'partial_refund' | 'full_refund' | 'rework' | 'warranty_service' | 'escalated';
export interface Dispute {
  id: string; bookingId: string; raisedBy: 'customer' | 'provider'; reason: string;
  description?: string; status: 'open' | 'review' | 'resolved' | 'rejected';
  priority: 'low' | 'normal' | 'high'; resolution?: Resolution; caseFile: Record<string, unknown>;
  createdAt: string;
}
const toDispute = (r: Record<string, unknown>): Dispute => ({
  id: String(r.id), bookingId: String(r.job_id), raisedBy: r.opened_by as Dispute['raisedBy'],
  reason: String(r.reason), description: (r.description as string) ?? undefined,
  status: r.status as Dispute['status'], priority: (r.priority as Dispute['priority']) ?? 'normal',
  resolution: (r.resolution as Resolution) ?? undefined, caseFile: (r.case_file as Record<string, unknown>) ?? {},
  createdAt: String(r.created_at),
});
export const disputeService = {
  async open(bookingId: string, raisedBy: 'customer' | 'provider', reason: string, description?: string): Promise<Dispute> {
    const valid = raisedBy === 'customer' ? (CUSTOMER_REASONS as readonly string[]) : (PROVIDER_REASONS as readonly string[]);
    if (!valid.includes(reason)) throw new Error('BAD_DISPUTE_REASON');
    const rows = await q<Record<string, unknown>>(
      `INSERT INTO payment.dispute (job_id, opened_by, reason, description) VALUES ($1,$2,$3,$4) RETURNING *`,
      [bookingId, raisedBy, reason, description ?? null],
    );
    const d = toDispute(rows[0]);
    emit('dispute.filed', { disputeId: d.id, bookingId });
    return d;
  },
  async attach(id: string, section: string, data: unknown) {
    const cur = await q<Record<string, unknown>>(`SELECT * FROM payment.dispute WHERE id=$1`, [id]);
    if (!cur[0]) throw new Error('NOT_FOUND');
    const file = { ...((cur[0].case_file as Record<string, unknown>) ?? {}), [section]: data };
    const upd = await q<Record<string, unknown>>(
      `UPDATE payment.dispute SET case_file=$2, status='review' WHERE id=$1 RETURNING *`, [id, JSON.stringify(file)],
    );
    return toDispute(upd[0]);
  },
  async resolve(id: string, resolution: Resolution) {
    const upd = await q<Record<string, unknown>>(`UPDATE payment.dispute SET resolution=$2, status='resolved' WHERE id=$1 RETURNING *`, [id, resolution]);
    if (!upd[0]) throw new Error('NOT_FOUND');
    return toDispute(upd[0]);
  },
  async set(id: string, status: Dispute['status']) {
    const upd = await q<Record<string, unknown>>(`UPDATE payment.dispute SET status=$2 WHERE id=$1 RETURNING *`, [id, status]);
    if (!upd[0]) throw new Error('NOT_FOUND');
    return toDispute(upd[0]);
  },
  async get(id: string) {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM payment.dispute WHERE id=$1`, [id]);
    return rows[0] ? toDispute(rows[0]) : null;
  },
};

export interface Review {
  id: string; bookingId: string; providerId?: string;
  provider: number; quality: number; punctuality: number; professionalism: number; result: number;
  tags: string[]; comment?: string; autoFlagged: boolean; createdAt: string;
}
const LOW_TAGS = ['late', 'poor_communication', 'poor_workmanship', 'damage', 'incomplete', 'overcharged'];
export const reviewService = {
  async add(bookingId: string, ratings: { provider: number; quality: number; punctuality: number; professionalism: number; result: number }, tags: string[], comment?: string, providerId?: string): Promise<Review> {
    for (const v of Object.values(ratings)) if (v < 1 || v > 5) throw new Error('BAD_RATING');
    const avg = Object.values(ratings).reduce((a, b) => a + b, 0) / 5;
    const flagged = avg <= 2 || tags.some((t) => LOW_TAGS.includes(t));
    const rows = await q<Record<string, unknown>>(
      `INSERT INTO payment.review (booking_id, provider_id, provider, quality, punctuality, professionalism, result, tags, comment, auto_flagged)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [bookingId, providerId ?? null, ratings.provider, ratings.quality, ratings.punctuality, ratings.professionalism, ratings.result, JSON.stringify(tags), comment ?? null, flagged],
    );
    const r = rows[0];
    if (flagged) await q(`INSERT INTO outbox_event (topic, payload) VALUES ('review.flagged',$1)`, [JSON.stringify({ reviewId: String(r.id), bookingId })]);
    emit('review.submitted', { reviewId: String(r.id), bookingId, rating: avg, flagged });
    return {
      id: String(r.id), bookingId: String(r.booking_id), providerId: r.provider_id ? String(r.provider_id) : undefined,
      provider: Number(r.provider), quality: Number(r.quality), punctuality: Number(r.punctuality),
      professionalism: Number(r.professionalism), result: Number(r.result),
      tags, comment, autoFlagged: flagged, createdAt: String(r.created_at),
    };
  },
  async forService(_serviceId: string) {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM payment.review ORDER BY created_at DESC LIMIT 50`);
    return rows;
  },
};
