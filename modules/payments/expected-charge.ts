// What a booking checkout must charge, and the guards that keep every checkout at that price.
// One rule for every pay path (app checkout, wallet payment, WhatsApp pay link):
//   expected charge = the accepted quote's total when one exists, else booking.price_kobo.
// The client's amount is never trusted. Database errors are thrown, never swallowed: charging
// the wrong price because a lookup failed is worse than failing the checkout.
import { q } from '../../packages/database/db.js';

const toKobo = (v: unknown): bigint => BigInt(String(v ?? 0).split('.')[0] || '0');

/** The amount to charge for a booking. `priceKobo` is the booking's own snapshot; read from the DB when not given. */
export async function expectedChargeKobo(bookingId: string, priceKobo?: string | number | bigint | null): Promise<bigint> {
  const quoted = await q<{ total_kobo: string | number }>(
    `SELECT total_kobo FROM booking.quote WHERE job_id=$1 AND status='accepted' ORDER BY version DESC LIMIT 1`,
    [bookingId],
  );
  if (quoted[0]) return toKobo(quoted[0].total_kobo);
  if (priceKobo !== undefined && priceKobo !== null) return toKobo(priceKobo);
  const rows = await q<{ price_kobo: string | number | null }>(`SELECT price_kobo FROM booking.booking WHERE id=$1`, [bookingId]);
  if (!rows[0]) throw new Error('BOOKING_NOT_FOUND');
  return toKobo(rows[0].price_kobo);
}

/** True once any successful payment (Paga or wallet) exists for the booking. */
export async function bookingHasSuccessfulPayment(bookingId: string): Promise<boolean> {
  const rows = await q(`SELECT 1 FROM payment.payment WHERE booking_id=$1 AND status='successful' LIMIT 1`, [bookingId]);
  return rows.length > 0;
}

/**
 * Retire open Paga requests for this booking that were raised for a different amount, so a
 * stale amount can never settle the booking. Returns the references that were superseded.
 * A superseded row that still receives money is credited to the payer's wallet (settlement.ts).
 */
export async function supersedeStalePending(bookingId: string, expectedKobo: bigint): Promise<string[]> {
  const rows = await q<{ reference: string }>(
    `UPDATE payment.payment SET status='superseded', next_check_at=NULL
      WHERE booking_id=$1 AND psp='paga' AND purpose='booking' AND status='pending' AND amount_kobo <> $2
      RETURNING reference`,
    [bookingId, Number(expectedKobo)],
  );
  return rows.map((r) => r.reference);
}
