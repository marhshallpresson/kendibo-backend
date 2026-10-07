// Warranty claims (§32-33), support tickets, provider earnings — all Postgres-backed.
import { q } from '../../packages/database/db.js';
import { emit } from '../../packages/observability/emit.js';

export type WarrantyStatus = 'active' | 'claimed' | 'expired';
export type ClaimStatus = 'submitted' | 'under_review' | 'approved_rework' | 'approved_refund' | 'rejected' | 'resolved';
export interface Warranty { id: string; bookingId: string; until: string; status: WarrantyStatus; coverage: string[]; exclusions: string[] }
export interface WarrantyClaim { id: string; warrantyId: string; reason: string; description: string; evidence: string[]; status: ClaimStatus; resolution?: string; createdAt: string }

export const warrantyService = {
  async activate(bookingId: string, days: number, coverage: string[] = ['service-related issue'], exclusions: string[] = ['new damage', 'unrelated faults', 'user modifications']): Promise<Warranty> {
    const rows = await q<Record<string, unknown>>(
      `INSERT INTO payment.warranty (job_id, end_date) VALUES ($1, CURRENT_DATE + ($2 || ' days')::interval) RETURNING *`, [bookingId, String(days)],
    );
    const r = rows[0];
    void coverage; void exclusions;
    return { id: String(r.id), bookingId: String(r.job_id), until: String(r.end_date), status: r.status as WarrantyStatus, coverage, exclusions };
  },
  async claim(id: string, reason: string, description: string, evidence: string[] = []): Promise<WarrantyClaim> {
    const w = await q<Record<string, unknown>>(`SELECT * FROM payment.warranty WHERE id=$1`, [id]);
    if (!w[0] || String(w[0].status) !== 'active') throw new Error('WARRANTY_GONE');
    if (new Date(String(w[0].end_date)).getTime() < Date.now()) {
      await q(`UPDATE payment.warranty SET status='expired' WHERE id=$1`, [id]);
      throw new Error('WARRANTY_EXPIRED');
    }
    await q(`UPDATE payment.warranty SET status='claimed' WHERE id=$1`, [id]);
    const rows = await q<Record<string, unknown>>(
      `INSERT INTO payment.warranty_claim (warranty_id, reason, description, evidence) VALUES ($1,$2,$3,$4) RETURNING *`,
      [id, reason, description, JSON.stringify(evidence)],
    );
    const c = toClaim(rows[0]);
    emit('claim.updated', { claimId: c.id, warrantyId: c.warrantyId, status: c.status });
    return c;
  },
  async review(id: string) {
    const rows = await q<Record<string, unknown>>(`UPDATE payment.warranty_claim SET status='under_review' WHERE id=$1 AND status='submitted' RETURNING *`, [id]);
    if (!rows[0]) throw new Error('CLAIM_GONE');
    const c = toClaim(rows[0]);
    emit('claim.updated', { claimId: c.id, warrantyId: c.warrantyId, status: c.status });
    return c;
  },
  async resolve(id: string, outcome: Exclude<ClaimStatus, 'submitted' | 'under_review'>, resolution?: string) {
    const rows = await q<Record<string, unknown>>(`UPDATE payment.warranty_claim SET status=$2, resolution=$3 WHERE id=$1 AND status='under_review' RETURNING *`, [id, outcome, resolution ?? null]);
    if (!rows[0]) throw new Error('CLAIM_GONE');
    const c = toClaim(rows[0]);
    emit('claim.updated', { claimId: c.id, warrantyId: c.warrantyId, status: c.status });
    return c;
  },
  async getWarranty(id: string) {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM payment.warranty WHERE id=$1`, [id]);
    const r = rows[0];
    return r ? { id: String(r.id), bookingId: String(r.job_id), until: String(r.end_date), status: r.status as WarrantyStatus, coverage: [] as string[], exclusions: [] as string[] } : null;
  },
  async getClaim(id: string) {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM payment.warranty_claim WHERE id=$1`, [id]);
    return rows[0] ? toClaim(rows[0]) : null;
  },
};
function toClaim(r: Record<string, unknown>): WarrantyClaim {
  return {
    id: String(r.id), warrantyId: String(r.warranty_id), reason: String(r.reason), description: String(r.description ?? ''),
    evidence: (r.evidence as string[]) ?? [], status: r.status as ClaimStatus,
    resolution: (r.resolution as string) ?? undefined, createdAt: String(r.created_at),
  };
}

export interface Ticket { id: string; customerId: string; jobId?: string; reason: string; priority: 'low' | 'normal' | 'high' | 'urgent'; status: 'open' | 'pending' | 'resolved'; assignee?: string; messages: { from: string; body: string; at: string }[]; createdAt: string }
export const supportService = {
  async open(customerId: string, reason: string, jobId?: string, priority: Ticket['priority'] = 'normal'): Promise<Ticket> {
    const rows = await q<Record<string, unknown>>(
      `INSERT INTO support.ticket (customer_id, job_id, reason, priority) VALUES ($1,$2,$3,$4) RETURNING *`, [customerId, jobId ?? null, reason, priority],
    );
    const ticket = toTicket(rows[0], []);
    emit('support.opened', { ticketId: ticket.id, reason });
    return ticket;
  },
  async message(id: string, from: string, body: string) {
    await q(`INSERT INTO support.ticket_message (ticket_id, sender, body) VALUES ($1,$2,$3)`, [id, from, body.slice(0, 2000)]);
    return this.get(id);
  },
  async assign(id: string, agent: string) {
    await q(`UPDATE support.ticket SET assigned_agent=$2, status='pending' WHERE id=$1`, [id, agent]);
    return this.get(id);
  },
  async resolve(id: string) {
    await q(`UPDATE support.ticket SET status='resolved' WHERE id=$1`, [id]);
    return this.get(id);
  },
  async list(cursor?: string) {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM support.ticket ORDER BY created_at DESC LIMIT 20`, []);
    void cursor;
    return { items: rows.map((r) => toTicket(r, [])), nextCursor: null as string | null };
  },
  async get(id: string): Promise<Ticket | null> {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM support.ticket WHERE id=$1`, [id]);
    if (!rows[0]) return null;
    const msgs = await q<Record<string, unknown>>(`SELECT sender AS "from", body, created_at AS at FROM support.ticket_message WHERE ticket_id=$1 ORDER BY created_at`, [id]);
    return toTicket(rows[0], msgs as unknown as Ticket['messages']);
  },
};
function toTicket(r: Record<string, unknown>, messages: Ticket['messages']): Ticket {
  return {
    id: String(r.id), customerId: String(r.customer_id), jobId: r.job_id ? String(r.job_id) : undefined,
    reason: String(r.reason), priority: r.priority as Ticket['priority'], status: r.status as Ticket['status'],
    assignee: (r.assigned_agent as string) ?? undefined, messages,
    createdAt: String(r.created_at),
  };
}

export const earningsService = {
  async record(providerId: string, jobId: string, amountKobo: bigint, tipKobo = 0n) {
    await q(`INSERT INTO provider.earning (provider_id, job_id, amount_kobo, tip_kobo) VALUES ($1,$2,$3,$4)`,
      [providerId, jobId, String(amountKobo), String(tipKobo)]);
  },
  async forProvider(providerId: string) {
    return q(`SELECT * FROM provider.earning WHERE provider_id=$1 ORDER BY created_at DESC`, [providerId]);
  },
};
