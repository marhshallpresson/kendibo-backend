// Refunds — Postgres-backed policy decisions (PSP + ledger reversal at route/worker).
import { q } from '../../packages/database/db.js';
import { emit } from '../../packages/observability/emit.js';

export type RefundStatus = 'requested' | 'approved' | 'manual_review' | 'psp_done' | 'reversed' | 'refunded' | 'rejected';
export interface Refund { id: string; bookingId: string; amountKobo: string; reason: string; status: RefundStatus; createdAt: string }
function evaluatePolicy(bookingStatus: string, providerFault?: boolean): RefundStatus {
  if (providerFault) return 'approved';
  if (['REQUESTED', 'PAYMENT_PENDING', 'CONFIRMED', 'MATCHING'].includes(bookingStatus)) return 'approved';
  return 'manual_review';
}
const toRefund = (r: Record<string, unknown>): Refund => ({
  id: String(r.id), bookingId: String(r.booking_id), amountKobo: String(r.amount_kobo),
  reason: String(r.reason), status: r.status as RefundStatus, createdAt: String(r.created_at),
});

export const refundService = {
  async request(bookingId: string, amountKobo: bigint, reason: string, bookingStatus = 'CONFIRMED'): Promise<Refund> {
    const rows = await q<Record<string, unknown>>(
      `INSERT INTO payment.refund (booking_id, amount_kobo, reason, status) VALUES ($1,$2,$3,$4) RETURNING *`,
      [bookingId, String(amountKobo), reason, evaluatePolicy(bookingStatus)],
    );
    const ref = toRefund(rows[0]);
    emit('refund.created', { refundId: ref.id, bookingId });
    return ref;
  },
  async mark(id: string, status: RefundStatus) {
    const rows = await q<Record<string, unknown>>(`UPDATE payment.refund SET status=$2 WHERE id=$1 RETURNING *`, [id, status]);
    if (!rows[0]) throw new Error('NOT_FOUND');
    const ref = toRefund(rows[0]);
    emit('refund.created', { refundId: ref.id, bookingId: ref.bookingId });
    return ref;
  },
  async get(id: string) {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM payment.refund WHERE id=$1`, [id]);
    return rows[0] ? toRefund(rows[0]) : null;
  },
};
