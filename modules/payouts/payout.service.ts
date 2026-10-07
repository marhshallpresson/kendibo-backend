// Payouts — Postgres-backed. Cooling via provider.bank_changed_at; maker-checker at route.
import { q } from '../../packages/database/db.js';
import { emit } from '../../packages/observability/emit.js';
import { observability } from '../../packages/observability/watchup.adapter.js';

export type PayoutStatus = 'pending' | 'eligible' | 'held' | 'in_run' | 'awaiting_approval' | 'sent' | 'success' | 'failed' | 'reversed';
export interface Payout { id: string; providerId: string; amountKobo: string; status: PayoutStatus; reference: string; createdAt: string; approvedBy?: string }
const COOLING_MS = 24 * 3600_000;
const toPayout = (r: Record<string, unknown>): Payout => ({
  id: String(r.id), providerId: String(r.provider_id), amountKobo: String(r.amount_kobo),
  status: r.status as PayoutStatus, reference: `payout-${String(r.id).slice(0, 8)}`,
  createdAt: String(r.created_at), approvedBy: (r.approved_by as string) ?? undefined,
});

export const payoutService = {
  coolingMs: COOLING_MS,
  async requestBankChange(providerId: string) {
    await q(`UPDATE provider.provider SET bank_changed_at=now() WHERE id=$1`, [providerId]);
  },
  async bankEligible(providerId: string): Promise<boolean> {
    const rows = await q<{ bank_changed_at: string }>(`SELECT bank_changed_at FROM provider.provider WHERE id=$1`, [providerId]);
    const t = rows[0]?.bank_changed_at;
    return !t || Date.now() - new Date(t).getTime() >= COOLING_MS;
  },
  async create(providerId: string, amountKobo: bigint, reference: string): Promise<Payout> {
    if (!(await this.bankEligible(providerId))) throw new Error('PAYOUT_COOLING');
    const rows = await q<Record<string, unknown>>(
      `INSERT INTO payment.payout (provider_id, amount_kobo) VALUES ($1,$2) RETURNING *`, [providerId, String(amountKobo)],
    );
    const p = toPayout(rows[0]);
    emit('payout.created', { payoutId: p.id, providerId, amountKobo: Number(amountKobo) });
    return { ...p, reference };
  },
  async approve(id: string, approver: string) {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM payment.payout WHERE id=$1`, [id]);
    if (!rows[0] || String(rows[0].status) !== 'pending') throw new Error('PAYOUT_GONE');
    const upd = await q<Record<string, unknown>>(
      `UPDATE payment.payout SET status='awaiting_approval', approved_by=$2 WHERE id=$1 RETURNING *`, [id, approver],
    );
    return toPayout(upd[0]);
  },
  async mark(id: string, status: PayoutStatus) {
    const upd = await q<Record<string, unknown>>(`UPDATE payment.payout SET status=$2 WHERE id=$1 RETURNING *`, [id, status]);
    if (!upd[0]) throw new Error('NOT_FOUND');
    return toPayout(upd[0]);
  },
  async get(id: string) {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM payment.payout WHERE id=$1`, [id]);
    return rows[0] ? toPayout(rows[0]) : null;
  },
};
