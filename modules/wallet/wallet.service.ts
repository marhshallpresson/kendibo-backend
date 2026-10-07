// Wallet — per-user ledger persisted in payment.wallet_txn (append-only).
// Balances derived from credited/debited kobo. Amounts are integer kobo.
// Idempotent by UNIQUE txn ref: replays of the same ref return the original.
import { q } from '../../packages/database/db.js';

export type WalletTxnKind = 'topup' | 'payment' | 'refund' | 'payout';
export interface WalletTxn {
  id: string; kind: WalletTxnKind; amountKobo: number;
  ref: string; bookingId?: string; createdAt: string;
}

function mustPositiveIntKobo(amountKobo: number): void {
  if (!Number.isInteger(amountKobo) || amountKobo <= 0) throw new Error('BAD_AMOUNT');
}
const toTxn = (r: Record<string, unknown>): WalletTxn => ({
  id: String(r.id), kind: r.kind as WalletTxnKind, amountKobo: Number(r.amount_kobo),
  ref: String(r.ref), bookingId: r.booking_id ? String(r.booking_id) : undefined,
  createdAt: String(r.created_at),
});

export async function getBalance(userId: string): Promise<number> {
  const rows = await q<{ balance: string }>(
    `SELECT COALESCE(SUM(CASE WHEN kind IN ('topup','refund') THEN amount_kobo ELSE -amount_kobo END),0) AS balance
     FROM payment.wallet_txn WHERE user_id=$1`, [userId],
  );
  return Number(rows[0]?.balance ?? 0);
}

export async function txns(userId: string): Promise<WalletTxn[]> {
  const rows = await q<Record<string, unknown>>(
    `SELECT * FROM payment.wallet_txn WHERE user_id=$1 ORDER BY created_at`, [userId],
  );
  return rows.map(toTxn);
}

export async function credit(userId: string, amountKobo: number, ref: string, kind: WalletTxnKind = 'topup', bookingId?: string): Promise<WalletTxn> {
  mustPositiveIntKobo(amountKobo);
  if (!ref) throw new Error('REF_REQUIRED');
  const existing = await q<Record<string, unknown>>(`SELECT * FROM payment.wallet_txn WHERE ref=$1`, [ref]);
  if (existing[0]) return toTxn(existing[0]); // replay-safe
  const rows = await q<Record<string, unknown>>(
    `INSERT INTO payment.wallet_txn (user_id, kind, amount_kobo, ref, booking_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [userId, kind, amountKobo, ref, bookingId ?? null],
  );
  return toTxn(rows[0]);
}

export async function debit(userId: string, amountKobo: number, ref: string, kind: WalletTxnKind = 'payment', bookingId?: string): Promise<WalletTxn> {
  mustPositiveIntKobo(amountKobo);
  if (!ref) throw new Error('REF_REQUIRED');
  const existing = await q<Record<string, unknown>>(`SELECT * FROM payment.wallet_txn WHERE ref=$1`, [ref]);
  if (existing[0]) return toTxn(existing[0]); // replay-safe
  const balance = await getBalance(userId);
  if (balance < amountKobo) throw new Error('INSUFFICIENT_FUNDS');
  const rows = await q<Record<string, unknown>>(
    `INSERT INTO payment.wallet_txn (user_id, kind, amount_kobo, ref, booking_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [userId, kind, amountKobo, ref, bookingId ?? null],
  );
  return toTxn(rows[0]);
}

/** Test isolation hook (scoped delete, not truncate-all). */
export async function clearUser(userId: string): Promise<void> {
  await q(`DELETE FROM payment.wallet_txn WHERE user_id=$1`, [userId]);
}
export async function clearAll(): Promise<void> {
  await q(`DELETE FROM payment.wallet_txn`, []);
}

export const walletService = { getBalance, txns, credit, debit, clearAll, clearUser };
