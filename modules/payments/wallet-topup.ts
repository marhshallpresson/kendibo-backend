// Wallet top-up settlement. A card top-up is a payment.payment row with
// reference wt_<userId>_<key>, the zero booking id and the paying user stored on
// the row at checkout time. Crediting is idempotent by construction:
//   * it only runs for a row already marked 'successful' (PSP-verified and
//     amount-matched by PaymentService before the status ever flips), and
//   * payment.wallet_txn.ref is UNIQUE and the credit uses the payment reference,
//     so any number of webhook retries / return-page polls / verify calls
//     converge on exactly one wallet credit, and a crash between "mark paid" and
//     "credit" is repaired by the next call.
import { q } from '../../packages/database/db.js';
import { walletService } from '../wallet/wallet.service.js';

export const WALLET_TOPUP_PREFIX = 'wt_';
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

export type TopupSettlement =
  | { credited: true; userId: string; amountKobo: number }
  | { credited: false; reason: 'not_topup' | 'not_found' | 'not_successful' | 'amount_mismatch' | 'no_owner' };

export const isWalletTopupRef = (reference: string): boolean => reference.startsWith(WALLET_TOPUP_PREFIX);

/** Credit the wallet for a successful top-up payment. Safe to call repeatedly. */
export async function settleWalletTopup(reference: string, verifiedAmountKobo?: bigint): Promise<TopupSettlement> {
  if (!isWalletTopupRef(reference)) return { credited: false, reason: 'not_topup' };
  const rows = await q<{ booking_id: string; user_id: string | null; amount_kobo: string | number; status: string }>(
    `SELECT booking_id, user_id, amount_kobo, status FROM payment.payment WHERE reference=$1`, [reference],
  );
  const row = rows[0];
  if (!row) return { credited: false, reason: 'not_found' };
  if (String(row.booking_id) !== ZERO_UUID) return { credited: false, reason: 'not_topup' };
  if (row.status !== 'successful') return { credited: false, reason: 'not_successful' };
  const recorded = BigInt(String(row.amount_kobo));
  if (verifiedAmountKobo !== undefined && verifiedAmountKobo !== recorded) return { credited: false, reason: 'amount_mismatch' };
  if (!row.user_id) return { credited: false, reason: 'no_owner' };
  const amount = Number(recorded);
  if (!Number.isSafeInteger(amount) || amount <= 0) return { credited: false, reason: 'amount_mismatch' };
  await walletService.credit(String(row.user_id), amount, reference, 'topup');
  return { credited: true, userId: String(row.user_id), amountKobo: amount };
}
