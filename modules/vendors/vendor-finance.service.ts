// Vendor money: per-category commission, settlement split, fees the platform
// recovers from earnings (e.g. identity-verification cost), and the payable
// balance a payout may never exceed. All amounts are integer kobo (bigint).
import { q } from '../../packages/database/db.js';
import { emit } from '../../packages/observability/emit.js';
import { categoryRulesService } from './category-rules.service.js';

export interface SettlementSplit {
  bookingId: string; categoryId: string | null; collectedKobo: bigint;
  commissionBps: number; commissionKobo: bigint; vatKobo: bigint; providerKobo: bigint;
}

/** VAT on Kendibo's commission (Nigeria 7.5%); deducted from the provider's share. */
export const COMMISSION_VAT_BPS = () => Number(process.env.COMMISSION_VAT_BPS ?? 750);
export const vatOn = (commissionKobo: bigint) => (commissionKobo * BigInt(COMMISSION_VAT_BPS())) / 10000n;

const big = (v: unknown) => BigInt(String(v ?? 0).split('.')[0] || '0');

export const vendorFinanceService = {
  /** Split what was actually collected for a booking: platform commission by
   *  the category's rule, remainder to the vendor. Rounds commission down so
   *  the vendor never loses a fractional kobo. */
  async settlementSplit(bookingId: string): Promise<SettlementSplit> {
    const paid = await q<{ total: string }>(
      `SELECT COALESCE(SUM(amount_kobo),0) AS total FROM payment.payment WHERE booking_id=$1 AND status='successful'`, [bookingId],
    );
    const collected = big(paid[0]?.total);
    // The trade: a catalog service's category, else the request the booking came
    // from (agreed-price and listed-price bookings have no catalog service).
    const cat = await q<{ category_id: string }>(
      `SELECT s.category_id FROM booking.booking b JOIN catalog.service s ON s.id=b.service_id WHERE b.id=$1`, [bookingId],
    ).catch(() => []);
    let categoryId = cat[0]?.category_id ? String(cat[0].category_id) : null;
    if (!categoryId) {
      const fromReq = await q<{ category_id: string | null }>(`SELECT category_id FROM booking.service_request WHERE booking_id=$1 LIMIT 1`, [bookingId]).catch(() => []);
      categoryId = fromReq[0]?.category_id ? String(fromReq[0].category_id) : null;
    }
    const bps = categoryId ? (await categoryRulesService.ruleFor(categoryId)).commissionBps : 1500;
    const commission = (collected * BigInt(bps)) / 10000n;
    const vat = vatOn(commission);
    return { bookingId, categoryId, collectedKobo: collected, commissionBps: bps, commissionKobo: commission, vatKobo: vat, providerKobo: collected - commission - vat };
  },

  /** Idempotent per (provider, job): a retried settlement never double-credits. */
  async creditEarning(providerId: string, bookingId: string): Promise<SettlementSplit> {
    const split = await this.settlementSplit(bookingId);
    if (split.providerKobo <= 0n) throw new Error('NOTHING_COLLECTED');
    const existing = await q(`SELECT 1 FROM provider.earning WHERE provider_id=$1 AND job_id=$2`, [providerId, bookingId]);
    if (!existing[0]) {
      await q(
        `INSERT INTO provider.earning (provider_id, job_id, amount_kobo, gross_kobo, commission_kobo, commission_bps, vat_kobo)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [providerId, bookingId, String(split.providerKobo), String(split.collectedKobo), String(split.commissionKobo), split.commissionBps, String(split.vatKobo)],
      );
      emit('vendor.earning_credited', { providerId, bookingId, providerKobo: String(split.providerKobo) });
    }
    return split;
  },

  /** Charge a fee against future earnings. `reference` makes it idempotent. */
  async addFee(providerId: string, kind: 'kyc_verification' | 'commission' | 'adjustment', amountKobo: bigint, reference: string) {
    if (amountKobo <= 0n) return null;
    await q(
      `INSERT INTO provider.fee_ledger (provider_id, kind, amount_kobo, reference) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [providerId, kind, String(amountKobo), reference],
    );
    emit('vendor.fee_added', { providerId, kind, amountKobo: String(amountKobo) });
    return { reference };
  },

  async fees(providerId: string) {
    return q(`SELECT id, kind, amount_kobo, reference, status, recovered_in, created_at FROM provider.fee_ledger WHERE provider_id=$1 ORDER BY created_at DESC LIMIT 100`, [providerId]);
  },

  async waiveFee(id: string) {
    const rows = await q(`UPDATE provider.fee_ledger SET status='waived' WHERE id=$1 AND status='outstanding' RETURNING id`, [id]);
    if (!rows[0]) throw new Error('FEE_GONE');
    return { id, status: 'waived' };
  },

  /** earned − paid out (any non-failed payout) − outstanding fees. */
  async balance(providerId: string) {
    const earned = await q<{ t: string }>(`SELECT COALESCE(SUM(amount_kobo + tip_kobo),0) AS t FROM provider.earning WHERE provider_id=$1`, [providerId]);
    const paid = await q<{ t: string }>(
      `SELECT COALESCE(SUM(amount_kobo),0) AS t FROM payment.payout WHERE provider_id=$1 AND status NOT IN ('failed','rejected','cancelled')`, [providerId],
    );
    const fees = await q<{ t: string }>(`SELECT COALESCE(SUM(amount_kobo),0) AS t FROM provider.fee_ledger WHERE provider_id=$1 AND status='outstanding'`, [providerId]);
    const earnedK = big(earned[0]?.t);
    const paidK = big(paid[0]?.t);
    const feesK = big(fees[0]?.t);
    const available = earnedK - paidK - feesK;
    return {
      earnedKobo: earnedK.toString(), paidOutKobo: paidK.toString(), outstandingFeesKobo: feesK.toString(),
      availableKobo: (available > 0n ? available : 0n).toString(),
    };
  },

  /**
   * The provider's money at a glance: available to withdraw, held in escrow
   * (customers paid, job not yet confirmed), paid out, commission so far, this
   * month's net, and the latest jobs with gross / commission / net.
   */
  async summary(providerId: string) {
    const bal = await this.balance(providerId);
    const totals = await q<{ gross: string; commission: string; vat: string }>(
      `SELECT COALESCE(SUM(gross_kobo),0) AS gross, COALESCE(SUM(commission_kobo),0) AS commission, COALESCE(SUM(vat_kobo),0) AS vat FROM provider.earning WHERE provider_id=$1`, [providerId],
    );
    const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
    const month = await q<{ t: string }>(`SELECT COALESCE(SUM(amount_kobo + tip_kobo),0) AS t FROM provider.earning WHERE provider_id=$1 AND created_at >= $2`, [providerId, monthStart.toISOString()]);
    // Paid by the customer, assigned to this provider, not yet credited (awaiting confirmation).
    const jobs = await q<{ job_id: string }>(`SELECT job_id FROM dispatch.assignment WHERE provider_id=$1 AND status='accepted'`, [providerId]);
    const credited = new Set((await q<{ job_id: string }>(`SELECT job_id FROM provider.earning WHERE provider_id=$1`, [providerId])).map((r) => String(r.job_id)));
    let escrowGross = 0n;
    for (const j of jobs.slice(0, 200)) {
      if (credited.has(String(j.job_id))) continue;
      const paid = await q<{ t: string }>(`SELECT COALESCE(SUM(amount_kobo),0) AS t FROM payment.payment WHERE booking_id=$1 AND status='successful'`, [String(j.job_id)]).catch(() => []);
      escrowGross += big(paid[0]?.t);
    }
    const recent = await q<Record<string, unknown>>(
      `SELECT job_id, gross_kobo, commission_kobo, commission_bps, vat_kobo, amount_kobo, tip_kobo, created_at FROM provider.earning WHERE provider_id=$1 ORDER BY created_at DESC LIMIT 30`, [providerId],
    );
    return {
      ...bal,
      heldInEscrowKobo: escrowGross.toString(),
      grossKobo: big(totals[0]?.gross).toString(),
      commissionKobo: big(totals[0]?.commission).toString(),
      vatOnCommissionKobo: big(totals[0]?.vat).toString(),
      thisMonthKobo: big(month[0]?.t).toString(),
      jobs: recent.map((r) => ({
        jobId: String(r.job_id), grossKobo: String(r.gross_kobo ?? r.amount_kobo), commissionKobo: String(r.commission_kobo ?? 0),
        commissionBps: r.commission_bps != null ? Number(r.commission_bps) : null, vatKobo: String(r.vat_kobo ?? 0), netKobo: String(r.amount_kobo), tipKobo: String(r.tip_kobo ?? 0),
        at: String(r.created_at),
      })),
    };
  },

  /** Called when a payout is created: outstanding fees are settled out of the
   *  same balance the payout was checked against. */
  async recoverFees(providerId: string, payoutReference: string) {
    await q(
      `UPDATE provider.fee_ledger SET status='recovered', recovered_in=$2 WHERE provider_id=$1 AND status='outstanding'`,
      [providerId, payoutReference],
    );
  },
};
