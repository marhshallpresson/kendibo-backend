// Quotes — Postgres-backed immutable revisions + change orders + lock.
import { q } from '../../packages/database/db.js';

export interface Quote {
  id: string; bookingId: string; providerId: string; version: number;
  issueSummary: string; diagnosis: string;
  labourKobo: string; partsKobo: string; feesKobo: string; taxKobo: string;
  discountKobo: string; totalKobo: string;
  validUntil: string; warrantyDays: number; estimatedCompletion?: string;
  assumptions: string[]; exclusions: string[]; attachments: string[]; providerNotes?: string;
  status: 'proposed' | 'accepted' | 'rejected' | 'expired'; locked: boolean; createdAt: string;
}
export interface ChangeOrder {
  id: string; bookingId: string; quoteId: string; reason: string; amountKobo: string;
  evidence: string[]; status: 'requested' | 'approved' | 'rejected'; approvedBy?: string; createdAt: string;
}
const toQuote = (r: Record<string, unknown>): Quote => ({
  id: String(r.id), bookingId: String(r.job_id), providerId: r.provider_id ? String(r.provider_id) : 'unassigned',
  version: Number(r.version), issueSummary: String(r.issue_summary ?? ''), diagnosis: String(r.diagnosis ?? ''),
  labourKobo: String(r.labour_kobo), partsKobo: String(r.parts_kobo), feesKobo: String(r.fees_kobo),
  taxKobo: String(r.tax_kobo), discountKobo: String(r.discount_kobo), totalKobo: String(r.total_kobo),
  validUntil: String(r.valid_until), warrantyDays: Number(r.warranty_days),
  estimatedCompletion: undefined,
  assumptions: r.assumptions as string[] ?? [], exclusions: r.exclusions as string[] ?? [],
  attachments: r.attachments as string[] ?? [], providerNotes: (r.provider_notes as string) ?? undefined,
  status: r.status as Quote['status'], locked: Boolean(r.locked), createdAt: String(r.created_at),
});

export const quoteService = {
  async propose(bookingId: string, input: {
    providerId?: string; amountKobo?: bigint; issueSummary?: string; diagnosis?: string;
    labourKobo?: bigint; partsKobo?: bigint; feesKobo?: bigint; taxKobo?: bigint; discountKobo?: bigint;
    validDays?: number; warrantyDays?: number; assumptions?: string[]; exclusions?: string[];
    attachments?: string[]; providerNotes?: string; estimatedCompletion?: string;
  }): Promise<Quote> {
    const prior = await q<{ version: number }>(`SELECT version FROM booking.quote WHERE job_id=$1 ORDER BY version DESC LIMIT 1`, [bookingId]);
    const version = (prior[0]?.version ?? 0) + 1;
    const labour = input.labourKobo ?? 0n, parts = input.partsKobo ?? 0n;
    const fees = input.feesKobo ?? 0n, tax = input.taxKobo ?? 0n, disc = input.discountKobo ?? 0n;
    const total = input.amountKobo ?? (labour + parts + fees + tax - disc);
    const rows = await q<Record<string, unknown>>(
      `INSERT INTO booking.quote (job_id, provider_id, version, issue_summary, diagnosis, labour_kobo, parts_kobo, fees_kobo, tax_kobo, discount_kobo, total_kobo, valid_until, warranty_days, assumptions, exclusions, attachments, provider_notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now() + ($12 || ' days')::interval,$13,$14,$15,$16,$17) RETURNING *`,
      [bookingId, input.providerId ?? null, version, input.issueSummary ?? '', input.diagnosis ?? '',
       String(labour), String(parts), String(fees), String(tax), String(disc), String(total),
       String(input.validDays ?? 3), input.warrantyDays ?? 7,
       JSON.stringify(input.assumptions ?? []), JSON.stringify(input.exclusions ?? []),
       JSON.stringify(input.attachments ?? []), input.providerNotes ?? null],
    );
    return toQuote(rows[0]);
  },
  async revisions(bookingId: string): Promise<Quote[]> {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM booking.quote WHERE job_id=$1 ORDER BY version`, [bookingId]);
    return rows.map(toQuote);
  },
  async accept(bookingId: string, version: number): Promise<Quote> {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM booking.quote WHERE job_id=$1 AND version=$2`, [bookingId, version]);
    const value = rows[0];
    if (!value || String(value.status) !== 'proposed') throw new Error('QUOTE_GONE');
    if (new Date(String(value.valid_until)).getTime() < Date.now()) {
      await q(`UPDATE booking.quote SET status='expired' WHERE id=$1`, [String(value.id)]);
      throw new Error('QUOTE_EXPIRED');
    }
    await q(`UPDATE booking.quote SET status='accepted', locked=TRUE WHERE id=$1`, [String(value.id)]);
    await q(`UPDATE booking.quote SET status='rejected' WHERE job_id=$1 AND version!=$2 AND status='proposed'`, [bookingId, version]);
    const upd = await q<Record<string, unknown>>(`SELECT * FROM booking.quote WHERE id=$1`, [String(value.id)]);
    return toQuote(upd[0]);
  },
  async requestChange(bookingId: string, quoteId: string, reason: string, amountKobo: bigint, evidence: string[] = []): Promise<ChangeOrder> {
    const rows = await q<Record<string, unknown>>(
      `INSERT INTO booking.change_order (job_id, quote_id, reason, amount_kobo, evidence) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [bookingId, quoteId, reason, String(amountKobo), JSON.stringify(evidence)],
    );
    return toChange(rows[0]);
  },
  async decideChange(id: string, approve: boolean, approver: string): Promise<ChangeOrder> {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM booking.change_order WHERE id=$1`, [id]);
    if (!rows[0] || String(rows[0].status) !== 'requested') throw new Error('CHANGE_GONE');
    const upd = await q<Record<string, unknown>>(
      `UPDATE booking.change_order SET status=$2, approved_by=$3, approved_at=now() WHERE id=$1 RETURNING *`,
      [id, approve ? 'approved' : 'rejected', approver],
    );
    return toChange(upd[0]);
  },
  async changesFor(bookingId: string): Promise<ChangeOrder[]> {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM booking.change_order WHERE job_id=$1 ORDER BY created_at`, [bookingId]);
    return rows.map(toChange);
  },
};
function toChange(r: Record<string, unknown>): ChangeOrder {
  return {
    id: String(r.id), bookingId: String(r.job_id), quoteId: String(r.quote_id), reason: String(r.reason),
    amountKobo: String(r.amount_kobo), evidence: r.evidence as string[] ?? [],
    status: r.status as ChangeOrder['status'], approvedBy: (r.approved_by as string) ?? undefined, createdAt: String(r.created_at),
  };
}
