// Ledger — Commerce General Ledger pattern on Postgres (ledger.* tables).
// Double-entry enforced in SQL readers + pre-write validation; idempotent by
// UNIQUE journal reference; periods in ledger.period; reversals, never mutation.
import type { Kobo } from '../payments/money.js';
import { q } from '../../packages/database/db.js';
import { observability } from '../../packages/observability/watchup.adapter.js';

export type AccountType = 'asset' | 'liability' | 'revenue' | 'expense' | 'held';
export interface LedgerAccount { id: string; code: string; name: string; type: AccountType }
export interface JournalLine { accountCode: string; debitKobo: Kobo; creditKobo: Kobo }
export interface Journal { id: string; reference: string; lines: JournalLine[]; createdAt: string; period: string; reverses?: string }

export const CHART: LedgerAccount[] = [
  { id: 'a1', code: '1000', name: 'PSP Receivable', type: 'asset' },
  { id: 'a2', code: '1100', name: 'Customer Funds Held', type: 'held' },
  { id: 'a3', code: '2000', name: 'Provider Payable', type: 'liability' },
  { id: 'a4', code: '3000', name: 'Platform Revenue', type: 'revenue' },
  { id: 'a5', code: '2100', name: 'Payout In Flight', type: 'asset' },
  { id: 'a6', code: '3100', name: 'Tax Payable (VAT)', type: 'liability' },
  { id: 'a7', code: '3200', name: 'Promotions / Discounts', type: 'expense' },
  { id: 'a8', code: '2010', name: 'Tips Payable (provider)', type: 'liability' },
  { id: 'a9', code: '4000', name: 'Adjustments', type: 'expense' },
  { id: 'a10', code: '4100', name: 'Chargebacks', type: 'expense' },
  { id: 'a11', code: '3010', name: 'Commission Income', type: 'revenue' },
  { id: 'a12', code: '2200', name: 'Refunds Payable', type: 'liability' },
];

// Accounting period for a posting: calendar month in Lagos time (WAT, UTC+1,
// no DST), e.g. '2026-11'. Postings must never be pinned to a literal month.
export function currentPeriod(at: Date = new Date()): string {
  const wat = new Date(at.getTime() + 60 * 60 * 1000);
  return `${wat.getUTCFullYear()}-${String(wat.getUTCMonth() + 1).padStart(2, '0')}`;
}
export async function openPeriod(period: string) {
  await q(`INSERT INTO ledger.period (period, locked) VALUES ($1,FALSE)`, [period]).catch(() => undefined);
}
export async function lockPeriod(period: string) {
  await q(`INSERT INTO ledger.period (period, locked) VALUES ($1,TRUE)`, [period]).catch(() => undefined);
  await q(`UPDATE ledger.period SET locked=TRUE WHERE period=$1`, [period]);
}
async function periodLocked(period: string): Promise<boolean> {
  const rows = await q<{ locked: boolean }>(`SELECT locked FROM ledger.period WHERE period=$1`, [period]);
  return rows[0]?.locked === true;
}

export async function postJournal(j: Journal): Promise<Journal> {
  const existing = await q<Record<string, unknown>>(`SELECT id, reference, period, created_at FROM ledger.journal WHERE reference=$1`, [j.reference]);
  if (existing[0]) return { ...j, id: String(existing[0].id), createdAt: String(existing[0].created_at) }; // idempotent
  if (await periodLocked(j.period)) throw new Error('PERIOD_LOCKED');
  if (j.lines.length < 2) throw new Error('JOURNAL_NEEDS_2_LINES');
  const dr = j.lines.reduce((s, l) => s + l.debitKobo, 0n);
  const cr = j.lines.reduce((s, l) => s + l.creditKobo, 0n);
  if (dr !== cr) throw new Error('DEBIT_NE_CREDIT');
  if (dr <= 0n) throw new Error('AMOUNT_MUST_BE_POSITIVE');
  const known = new Set(CHART.map((a) => a.code));
  for (const l of j.lines) {
    if (!known.has(l.accountCode)) throw new Error(`UNKNOWN_ACCOUNT:${l.accountCode}`);
    if (l.debitKobo < 0n || l.creditKobo < 0n || (l.debitKobo > 0n && l.creditKobo > 0n)) throw new Error('LINE_MUST_BE_DR_OR_CR');
  }
  const jr = await q<Record<string, unknown>>(`INSERT INTO ledger.journal (reference, period) VALUES ($1,$2) RETURNING id, created_at`, [j.reference, j.period]);
  const journalId = String(jr[0].id);
  for (const l of j.lines) {
    await q(`INSERT INTO ledger.entry (journal_id, account_code, debit_kobo, credit_kobo) VALUES ($1,$2,$3,$4)`,
      [journalId, l.accountCode, String(l.debitKobo), String(l.creditKobo)]);
  }
  await q(`INSERT INTO outbox_event (topic, payload) VALUES ('ledger.posted',$1)`, [JSON.stringify({ reference: j.reference })]);
  try { observability.track('ledger.posted', { reference: j.reference, period: j.period }); } catch { /* fail open */ }
  return { ...j, id: journalId, createdAt: String(jr[0].created_at) };
}

export function postCollection(reference: string, amountKobo: Kobo, period: string): Promise<Journal> {
  return postJournal({
    id: '', reference, period, createdAt: new Date().toISOString(),
    lines: [
      { accountCode: '1000', debitKobo: amountKobo, creditKobo: 0n },
      { accountCode: '1100', debitKobo: 0n, creditKobo: amountKobo },
    ],
  });
}

/** Escrow released: provider payable, Kendibo's commission (revenue) and the VAT on it (owed, 3100). */
export function postSettlement(reference: string, totalKobo: Kobo, providerKobo: Kobo, period: string, vatKobo: Kobo = 0n): Promise<Journal> {
  const fee = totalKobo - providerKobo - vatKobo;
  const lines = [
    { accountCode: '1100', debitKobo: totalKobo, creditKobo: 0n },
    { accountCode: '2000', debitKobo: 0n, creditKobo: providerKobo },
    { accountCode: '3000', debitKobo: 0n, creditKobo: fee },
    { accountCode: '3100', debitKobo: 0n, creditKobo: vatKobo },
  ].filter((l) => l.debitKobo > 0n || l.creditKobo > 0n); // entries may not be zero
  return postJournal({ id: '', reference, period, createdAt: new Date().toISOString(), lines });
}

export async function reverseJournal(original: Journal, period: string): Promise<Journal> {
  return postJournal({
    id: '', reference: `rev_${original.reference}`,
    period, createdAt: new Date().toISOString(), reverses: original.reference,
    lines: original.lines.map((l) => ({ accountCode: l.accountCode, debitKobo: l.creditKobo, creditKobo: l.debitKobo })),
  });
}

export async function trialBalance(): Promise<{ balanced: boolean; totalDr: Kobo; totalCr: Kobo }> {
  const rows = await q<{ dr: string; cr: string }>(`SELECT COALESCE(SUM(debit_kobo),0) dr, COALESCE(SUM(credit_kobo),0) cr FROM ledger.entry`);
  const totalDr = BigInt(rows[0]?.dr ?? 0);
  const totalCr = BigInt(rows[0]?.cr ?? 0);
  return { balanced: totalDr === totalCr, totalDr, totalCr };
}
