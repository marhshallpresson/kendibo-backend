// PaymentSettlement — the ONE rule for turning what Paga received into state.
// The Paga webhook, the return/verify endpoints and the background reconciler all
// call settle(reference); nothing else moves a Paga payment out of 'pending'.
//
// Truth comes from Paga, never from the webhook body or the client: settle() re-queries
// Paga's status for the reference and uses the cumulative amount Paga confirms received.
// The payer and the price come from OUR stored row (payment.payment.user_id / amount_kobo).
//
// The amount received is the hash-verified callback's cumulativePaymentAmount (stored on the row);
// /status only confirms that money arrived. Paid per /status but no amount known: the row
// stays pending, is flagged for review and is never auto-expired.
//
//   received == expected   booking/order/tier/subscription: status 'successful' and confirmed.
//   received  > expected   same, and the excess is credited to the payer's wallet (<ref>:excess).
//   received  < expected   NOT confirmed. Status 'partial'; what arrived is credited to the
//                          payer's wallet (<ref>:partial), the payer is told to pay the rest
//                          from the wallet (the existing pay-with-wallet path finishes it).
//   wallet top-up          exactly the received amount is credited (<ref>:topup); a short
//                          payment keeps the row 'partial' (still watched) until Paga closes it.
//   superseded             the agreed price changed after this request was raised (see
//                          expected-charge.ts). It never confirms the booking; whatever Paga
//                          received is credited to the payer's wallet (<ref>:superseded) and
//                          the row stays 'superseded'. The reconciler does not watch these rows;
//                          a callback for one still settles through settle().
//
// Safety: every status change is a guarded UPDATE (WHERE status = <what we read>) so a
// concurrent path cannot settle twice; every wallet credit is keyed by a deterministic
// ref (payment.wallet_txn.ref is UNIQUE) and sized as target - already credited, so a
// crash between "flip status" and "credit" is repaired by the next call; one settle per
// reference runs at a time (Postgres advisory lock).
import { q, withAdvisoryLock } from '../../packages/database/db.js';
import { walletService } from '../wallet/wallet.service.js';
import { formatNaira } from './money.js';
import type { PaymentService, PaymentRow, PagaCallback } from './payment.service.js';
import type { VerifiedPayment } from './payment.port.js';

export interface SettlementHooks {
  /** A booking / product order / tier fee / Pro subscription is fully paid. Must be idempotent. */
  confirm(row: PaymentRow): Promise<void>;
  /** Tell the payer something about their money (in-app + push, best effort). */
  notify(userId: string, title: string, body: string): Promise<void>;
  /** Observability counters (settled / partial / overpaid / expired / reconcile runs). */
  track(event: string, props?: Record<string, unknown>): void;
}

export interface SettleResult {
  status: string;
  transitioned: boolean;
  kind?: 'exact' | 'overpaid' | 'underpaid' | 'topup';
  receivedKobo?: bigint;
  /** Paga could not be asked (timeout, 5xx, auth) or does not know the reference. */
  pspError?: 'unreachable' | 'not_found';
  /** Paga says this payment request is closed (paid, expired or cancelled). */
  pspFinal?: boolean;
}

export interface ReconcileStats { checked: number; settled: number; partial: number; expired: number; errors: number }

export const PENDING_MIN_AGE_MS = 60_000;
export const PENDING_MAX_AGE_MS = 48 * 3600_000;
const BACKOFF_BASE_MS = 60_000; // 1m, 2m, 4m ... capped at 30m until the payment expires
const BACKOFF_CAP_MS = 30 * 60_000;

const stringAmount = (v: string | number | null | undefined) => BigInt(String(v ?? 0));

export class PaymentSettlement {
  constructor(private payments: PaymentService, private hooks: SettlementHooks) {}

  private async load(reference: string): Promise<PaymentRow | undefined> {
    const rows = await q<PaymentRow>(
      `SELECT reference, psp, status, purpose, booking_id, amount_kobo, received_kobo, user_id, subject_ref, charge_id, settled_at, confirmed_at, created_at, psp_details, callback_state, callback_cumulative_kobo, review_flag
         FROM payment.payment WHERE reference=$1`, [reference],
    );
    return rows[0];
  }

  /** Settle one payment from what Paga confirms. Safe to call any number of times, from any path. */
  async settle(reference: string): Promise<SettleResult> {
    const lock = await withAdvisoryLock(`payment:${reference}`, () => this.settleLocked(reference));
    if (!lock.acquired) return { status: 'busy', transitioned: false };
    return lock.value as SettleResult;
  }

  /**
   * Persist a hash-verified Paga callback on our payment row (the documented source of the
   * amount received). Monotonic: a late or replayed older notification never lowers the
   * cumulative amount. Marks the row due for an immediate settle/reconcile pass.
   */
  async recordCallback(reference: string, cb: PagaCallback): Promise<boolean> {
    const n = (v: bigint | null) => (v === null ? null : Number(v));
    const params: unknown[] = [reference, cb.state, cb.statusCode, n(cb.paymentKobo), n(cb.cumulativeKobo), n(cb.outstandingKobo), cb.notificationId];
    // Guards are built in JS (not COALESCE / IS DISTINCT FROM) so every parameter keeps one clear type.
    let guard = '';
    if (cb.cumulativeKobo !== null) { params.push(Number(cb.cumulativeKobo)); guard += ` AND (callback_cumulative_kobo IS NULL OR callback_cumulative_kobo <= $${params.length})`; }
    if (cb.notificationId !== null) { params.push(cb.notificationId); guard += ` AND (last_notification_id IS NULL OR last_notification_id <> $${params.length})`; }
    const rows = await q(
      `UPDATE payment.payment
          SET callback_state=$2, callback_status_code=$3, callback_payment_kobo=$4, callback_cumulative_kobo=$5,
              callback_outstanding_kobo=$6, callback_at=now(), last_notification_id=$7, next_check_at=now()
        WHERE reference=$1 AND psp='paga'${guard}
        RETURNING reference`,
      params,
    );
    return rows.length > 0;
  }

  /**
   * Settle one payment. Paga's /status confirms that money arrived; HOW MUCH arrived comes
   * from the hash-verified callback fields stored on the row (cumulativePaymentAmount).
   */
  private async settleLocked(reference: string): Promise<SettleResult> {
    const row = await this.load(reference);
    if (!row) return { status: 'not_found', transitioned: false };
    if (row.psp !== 'paga') return { status: row.status, transitioned: false }; // historical rows are read-only
    if (row.status === 'successful') { // nothing to ask Paga; repair a half-finished settlement
      await this.finish(row, false);
      return { status: 'successful', transitioned: false, receivedKobo: stringAmount(row.received_kobo) };
    }

    let v: VerifiedPayment;
    try {
      v = await this.payments.verifyReference(reference);
    } catch (e) {
      return { status: row.status, transitioned: false, pspError: /404|not found/i.test(String((e as Error).message)) ? 'not_found' : 'unreachable' };
    }
    if (v.reference !== reference) return { status: row.status, transitioned: false, pspError: 'unreachable' };

    const expected = stringAmount(row.amount_kobo);
    const prev = stringAmount(row.received_kobo);
    const cb = row.callback_cumulative_kobo === null || row.callback_cumulative_kobo === undefined ? null : stringAmount(row.callback_cumulative_kobo);
    const state = String(row.callback_state ?? '').toUpperCase();
    const closed = v.status === 'failed' || ['EXPIRED', 'FAILED', 'CANCELLED'].includes(state);
    const pspFinal = v.status === 'successful' || closed;

    if (!cb || cb <= 0n) {
      if (v.status === 'successful' || v.status === 'partial') {
        // Paga says money arrived but no verified callback told us how much. Never assume: keep
        // the payment pending (the callback may still come), flag it for review, never auto-expire it.
        if (!row.review_flag) {
          await q(`UPDATE payment.payment SET review_flag='paid_amount_unknown' WHERE reference=$1 AND review_flag IS NULL`, [reference]);
          this.hooks.track('payment.review_needed', { reference, reason: 'paid_amount_unknown', code: v.code });
        }
        return { status: row.status, transitioned: false, pspFinal: false };
      }
      if (closed && row.status === 'pending' && prev === 0n) {
        const flipped = await q(`UPDATE payment.payment SET status='failed', next_check_at=NULL WHERE reference=$1 AND status='pending' RETURNING reference`, [reference]);
        return { status: flipped.length ? 'failed' : (await this.load(reference))?.status ?? row.status, transitioned: flipped.length > 0, pspFinal: true };
      }
      return { status: row.status, transitioned: false, pspFinal: false };
    }

    // Money arrived per the verified callback; Paga must agree the request is paid, partly paid or closed.
    if (v.status === 'pending') return { status: row.status, transitioned: false, pspFinal: false };

    const received = cb > prev ? cb : prev; // never move backwards
    const full = received >= expected;
    // A superseded request (the agreed price changed after it was raised) never confirms anything:
    // whatever Paga received for it goes to the payer's wallet and the status stays 'superseded'.
    const next = row.status === 'superseded' ? 'superseded'
      : row.status === 'partial' && !(row.purpose === 'topup' && full) ? 'partial' : full ? 'successful' : 'partial';
    if (next === row.status && received === prev) {
      await this.finish(row, false); // nothing new; complete anything left over
      return { status: row.status, transitioned: false, receivedKobo: received, pspFinal };
    }

    // Guarded flip: only the caller that still sees the status we read (and the received amount we read) wins.
    const flipped = await q(
      `UPDATE payment.payment SET status=$1, received_kobo=$2, charge_id=COALESCE($3, charge_id), settled_at=NULL, review_flag=NULL
        WHERE reference=$4 AND status=$5 AND received_kobo=$6 RETURNING reference`,
      [next, Number(received), v.chargeId || null, reference, row.status, Number(prev)],
    );
    if (!flipped.length) return { status: (await this.load(reference))?.status ?? row.status, transitioned: false, pspFinal };

    const fresh = (await this.load(reference)) as PaymentRow;
    await this.finish(fresh, true);
    if (next === 'superseded') return { status: next, transitioned: false, receivedKobo: received, pspFinal };
    const kind = row.purpose === 'topup' ? 'topup' : next === 'partial' ? 'underpaid' : received > expected ? 'overpaid' : 'exact';
    if (next === 'partial' && pspFinal) await q(`UPDATE payment.payment SET next_check_at=NULL WHERE reference=$1`, [reference]).catch(() => {});
    return { status: next, transitioned: next !== row.status, kind, receivedKobo: received, pspFinal };
  }

  /** Wallet money already credited for this payment (all refs <reference>:*). */
  private async credited(reference: string): Promise<bigint> {
    // Refs <reference>:* form one text range (':' is immediately followed by ';').
    const rows = await q<{ t: string | number | null }>(
      `SELECT COALESCE(SUM(amount_kobo),0) AS t FROM payment.wallet_txn WHERE ref >= $1 AND ref < $2`, [`${reference}:`, `${reference};`],
    );
    return stringAmount(rows[0]?.t);
  }

  /** Credits, confirmation and notices for a row already in its final status for the money seen. Idempotent. */
  private async finish(row: PaymentRow, transitioned: boolean): Promise<void> {
    if (row.settled_at && !transitioned) return;
    const received = stringAmount(row.received_kobo);
    const expected = stringAmount(row.amount_kobo);
    const topup = row.purpose === 'topup';
    const paid = row.status === 'successful';

    const target = topup ? received : paid ? (received > expected ? received - expected : 0n) : received;
    const superseded = row.status === 'superseded';
    const label = topup ? 'topup' : paid ? 'excess' : superseded ? 'superseded' : 'partial';
    const have = await this.credited(row.reference);
    const missing = target - have;
    if (missing > 0n) {
      if (!row.user_id) { this.hooks.track('payment.no_owner', { reference: row.reference }); return; } // never guess an owner
      const suffix = have === 0n ? label : `${label}:${target}`;
      await walletService.credit(String(row.user_id), Number(missing), `${row.reference}:${suffix}`, 'topup');
    }

    if (paid && !topup && !row.confirmed_at) {
      if (row.purpose === 'booking') {
        // Idempotent downstream (ledger journal per reference): run, then mark; a crash re-runs it.
        await this.hooks.confirm(row);
        await q(`UPDATE payment.payment SET confirmed_at=now() WHERE reference=$1 AND confirmed_at IS NULL`, [row.reference]);
      } else {
        // Tier fee / subscription: confirming twice would be taken for a duplicate payment and refunded, so claim first.
        const claimed = await q(`UPDATE payment.payment SET confirmed_at=now() WHERE reference=$1 AND confirmed_at IS NULL RETURNING reference`, [row.reference]);
        if (claimed.length) await this.hooks.confirm(row);
      }
    }

    if (missing > 0n && row.user_id) {
      if (superseded) {
        await this.hooks.notify(String(row.user_id), 'Payment received for an old price',
          `We received ${formatNaira(received)} for a payment request that no longer matches your booking price. It is in your wallet; pay from your wallet to confirm the booking.`).catch(() => {});
      } else if (!paid && !topup) {
        await this.hooks.notify(String(row.user_id), 'Payment received, not complete',
          `You paid ${formatNaira(received)} of ${formatNaira(expected)}; ${formatNaira(received)} is in your wallet. Pay the rest from your wallet to confirm.`).catch(() => {});
      } else if (paid && !topup) {
        await this.hooks.notify(String(row.user_id), 'Payment confirmed',
          `We received ${formatNaira(received)} for ${formatNaira(expected)}; the extra ${formatNaira(received - expected)} is in your wallet.`).catch(() => {});
      }
    }

    if (transitioned) {
      const common = { purpose: row.purpose, reference: row.reference };
      if (topup) this.hooks.track('wallet.topup_succeeded', { psp: 'paga', ...common });
      else if (superseded) this.hooks.track('payment.superseded_received', { ...common, receivedKobo: String(received), expectedKobo: String(expected) });
      else if (!paid) this.hooks.track('payment.partial', { ...common, receivedKobo: String(received), expectedKobo: String(expected) });
      else {
        this.hooks.track(row.purpose === 'booking' ? 'booking.payment_succeeded' : 'payment.settled', { psp: 'paga', ...common });
        if (received > expected) this.hooks.track('payment.overpaid', { ...common, excessKobo: String(received - expected) });
        else this.hooks.track('payment.exact', common);
      }
    }
    await q(`UPDATE payment.payment SET settled_at=now() WHERE reference=$1 AND received_kobo=$2 AND settled_at IS NULL`, [row.reference, Number(received)]);
  }

  /** Backoff after a check: 1m, 2m, 4m ... capped at 30 min, +-20% jitter so a batch does not re-align. */
  private nextCheck(attempts: number, now: number): string {
    const base = Math.min(BACKOFF_BASE_MS * 2 ** attempts, BACKOFF_CAP_MS);
    return new Date(now + base * (0.8 + Math.random() * 0.4)).toISOString();
  }

  /**
   * One reconciliation pass: settle stuck payments in a small batch with limited
   * concurrency, then expire what stayed pending for 48h. Returns null when another
   * process holds the reconcile lock.
   */
  async reconcileTick(opts: { batch?: number; concurrency?: number; now?: Date } = {}): Promise<ReconcileStats | null> {
    const batch = opts.batch ?? 25;
    const concurrency = opts.concurrency ?? 3;
    const now = (opts.now ?? new Date()).getTime();
    const lock = await withAdvisoryLock('payments:reconcile', async () => {
      const stats: ReconcileStats = { checked: 0, settled: 0, partial: 0, expired: 0, errors: 0 };
      const iso = (t: number) => new Date(t).toISOString();
      const due = await q<{ reference: string; check_attempts: number }>(
        `SELECT reference, check_attempts FROM payment.payment
          WHERE psp='paga' AND (next_check_at IS NULL OR next_check_at <= $1)
            AND ((status='pending' AND created_at <= $2 AND created_at > $3)
              OR (status='partial' AND created_at > $3 AND next_check_at IS NOT NULL)
              OR (status='successful' AND settled_at IS NULL))
          ORDER BY next_check_at LIMIT $4`,
        [iso(now), iso(now - PENDING_MIN_AGE_MS), iso(now - PENDING_MAX_AGE_MS), batch],
      );
      let i = 0;
      const worker = async () => {
        while (i < due.length) {
          const { reference, check_attempts } = due[i++];
          stats.checked++;
          try {
            const r = await this.settle(reference);
            if (r.transitioned && r.status === 'successful') stats.settled++;
            if (r.transitioned && r.status === 'partial') stats.partial++;
            if (r.pspError === 'unreachable') stats.errors++;
            const stop = r.status === 'partial' && r.pspFinal;
            await q(
              `UPDATE payment.payment SET check_attempts = check_attempts + 1, next_check_at = $1 WHERE reference=$2 AND (status IN ('pending','partial') OR settled_at IS NULL)`,
              [stop ? null : this.nextCheck(Number(check_attempts), now), reference],
            );
          } catch { stats.errors++; }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, due.length) }, worker));

      // Pending for 48h: one last look at Paga (money may have landed), then expire.
      const stale = await q<{ reference: string }>(
        `SELECT reference FROM payment.payment WHERE psp='paga' AND status='pending' AND review_flag IS NULL AND created_at <= $1 ORDER BY created_at LIMIT $2`,
        [iso(now - PENDING_MAX_AGE_MS), batch],
      );
      for (const { reference } of stale) {
        const r = await this.settle(reference).catch(() => null);
        if (!r || r.status === 'busy' || r.pspError === 'unreachable') { stats.errors++; continue; }
        if (r.status !== 'pending') continue;
        const gone = await q(`UPDATE payment.payment SET status='expired', next_check_at=NULL WHERE reference=$1 AND status='pending' RETURNING reference`, [reference]);
        if (gone.length) { stats.expired++; this.hooks.track('payment.expired', { reference }); }
      }
      // Partially paid rows stop being watched after 48h; their money is already in the wallet.
      await q(`UPDATE payment.payment SET next_check_at=NULL WHERE psp='paga' AND status='partial' AND created_at <= $1 AND next_check_at IS NOT NULL`, [iso(now - PENDING_MAX_AGE_MS)]);

      if (stats.checked || stats.expired) this.hooks.track('payment.reconcile_run', { ...stats });
      return stats;
    });
    return lock.acquired ? (lock.value as ReconcileStats) : null;
  }
}
