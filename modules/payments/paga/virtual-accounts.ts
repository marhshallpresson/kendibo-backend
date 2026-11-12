// Customer account numbers on Paga Subsidiary Accounts (ledger-backed: no
// autoSweep, so each customer's money sits in their own Paga sub-account).
//
//   KYC verified ──► ensureVirtualAccount ──► POST /subsidiary-accounts ──► account number
//   bank transfer in ──► Paga funding notification ──► confirm with Paga ──► wallet credit
//   pay from wallet ──► charge the sub-account (into Kendibo's Paga balance) ──► wallet debit
//   rotate ──► new sub-account, move the balance, disable the old one
//
// Rules:
// - Only while PAGA_MODE=test-accounts and the keys are set, and only for users
//   flagged identity.users.is_test (sandbox money never reaches real customers).
// - A notification alone never moves money in our ledger: it must carry a valid
//   x-paga-hash-v3, or the credit must show in the account's Paga history.
// - Every Paga call that moves money reuses a stable referenceNumber, so a
//   retry after a timeout can never move money twice (Paga dedupes on it).
// - Account numbers are not secrets, but payer bank account numbers are stored masked.
import crypto from 'node:crypto';
import { q } from '../../../packages/database/db.js';
import { emit } from '../../../packages/observability/emit.js';
import { observability } from '../../../packages/observability/watchup.adapter.js';
import { walletService } from '../../wallet/wallet.service.js';
import { PagaClient, PagaError, pagaConfig, pagaConfigured, sameHash, pagaHash, nairaToKobo, koboToNaira } from './client.js';

export type VaStatus = 'pending' | 'active' | 'rotating' | 'retired' | 'failed';
export interface VaRow {
  id: string; user_id: string; env: 'sandbox' | 'live'; account_reference: string;
  account_number: string | null; account_name: string; bank_name: string; status: VaStatus;
  create_reference: string; last_error: string | null; created_at: string; activated_at: string | null;
  retired_at: string | null; retired_reason: string | null;
}

export const ROTATE_COOLDOWN_MS = 24 * 3600 * 1000;
const CALLBACK_PATH = '/webhooks/paga/subsidiary';

let clientFactory: () => PagaClient = () => new PagaClient();
/** Tests inject a client with stubbed HTTP. */
export function setVirtualAccountClient(factory: (() => PagaClient) | null): void {
  clientFactory = factory ?? (() => new PagaClient());
}
const client = () => clientFactory();

export function virtualAccountsEnabled(): boolean {
  return process.env.PAGA_MODE === 'test-accounts' && pagaConfigured(pagaConfig());
}

const callbackUrl = () => `${(process.env.PAGA_CALLBACK_BASE_URL || 'https://api.kendibo.ng').replace(/\/+$/, '')}${CALLBACK_PATH}`;
/** Paga referenceNumber: short, unique, no secrets. */
const newRef = (prefix: string) => `${prefix}${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}`.slice(0, 30);
/** Stable reference derived from our own id, so retries reuse it. */
const stableRef = (prefix: string, seed: string) => `${prefix}${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 26)}`;
const maskAcct = (n?: string | null) => (n ? `${'*'.repeat(Math.max(0, String(n).length - 4))}${String(n).slice(-4)}` : null);
const okCode = (c: unknown) => String(c) === '0';
/** 2348012345678 / +234 801 234 5678 → 08012345678 (Paga's examples use the local form). */
export const localPhone = (p: string) => { const d = String(p).replace(/\D/g, ''); return d.startsWith('234') && d.length === 13 ? `0${d.slice(3)}` : d; };

// ---------- eligibility ----------

export interface Eligibility {
  ok: boolean;
  reason?: 'disabled' | 'not_test_account' | 'kyc_not_verified' | 'no_contact' | 'no_name' | 'not_found';
  profile?: { firstName: string; lastName: string; accountName: string; phone: string | null; email: string | null };
}

export async function eligibility(userId: string): Promise<Eligibility> {
  if (!virtualAccountsEnabled()) return { ok: false, reason: 'disabled' };
  const rows = await q<{ name: string | null; phone: string | null; email: string | null; is_test: boolean; c_status: string | null; c_name: string | null; p_status: string | null; p_name: string | null }>(
    `SELECT u.name, u.phone, u.email, u.is_test,
            c.status AS c_status, c.verified_legal_name AS c_name,
            p.kyc_status AS p_status, p.verified_legal_name AS p_name
       FROM identity.users u
       LEFT JOIN kyc.customer c ON c.user_id = u.id
       LEFT JOIN provider.provider p ON p.user_id = u.id
      WHERE u.id = $1
      LIMIT 1`, [userId],
  );
  const u = rows[0];
  if (!u) return { ok: false, reason: 'not_found' };
  if (!u.is_test) return { ok: false, reason: 'not_test_account' };
  const verified = u.c_status === 'VERIFIED' || u.p_status === 'VERIFIED';
  if (!verified) return { ok: false, reason: 'kyc_not_verified' };
  if (!u.phone && !u.email) return { ok: false, reason: 'no_contact' };
  const full = String((u.c_status === 'VERIFIED' ? u.c_name : null) ?? (u.p_status === 'VERIFIED' ? u.p_name : null) ?? u.name ?? '').replace(/\s+/g, ' ').trim();
  if (!full) return { ok: false, reason: 'no_name' };
  const parts = full.split(' ');
  const firstName = parts[0];
  const lastName = parts.length > 1 ? parts.slice(1).join(' ') : parts[0];
  return { ok: true, profile: { firstName, lastName, accountName: `Kendibo ${full}`.slice(0, 60), phone: u.phone, email: u.email } };
}

// ---------- reads ----------

export async function liveAccount(userId: string): Promise<VaRow | null> {
  const rows = await q<VaRow>(`SELECT * FROM payment.virtual_account WHERE live_user_id = $1`, [userId]);
  return rows[0] ?? null;
}

async function byNumber(accountNumber: string): Promise<VaRow | null> {
  const rows = await q<VaRow>(`SELECT * FROM payment.virtual_account WHERE account_number = $1 ORDER BY created_at DESC LIMIT 1`, [accountNumber]);
  return rows[0] ?? null;
}

/** Paga balance of a sub-account, in kobo. */
export async function pagaBalanceKobo(accountReference: string): Promise<bigint> {
  const ref = newRef('kb');
  const r = await client().collectRest('GET', `/subsidiary-accounts/${encodeURIComponent(accountReference)}/balance?referenceNumber=${encodeURIComponent(ref)}`, undefined, [ref, accountReference]);
  if (!okCode(r?.statusCode)) throw new PagaError(`STATUS_${r?.statusCode}`, String(r?.statusMessage ?? 'balance lookup failed'), undefined, r);
  return nairaToKobo(String(r.balance ?? 0).replace(/,/g, ''));
}

// ---------- create ----------

const inflight = new Map<string, Promise<VaRow | null>>();

/** Give an eligible user their account number (idempotent; safe to call often). */
export async function ensureVirtualAccount(userId: string): Promise<VaRow | null> {
  const running = inflight.get(userId);
  if (running) return running;
  const p = (async () => {
    const live = await liveAccount(userId);
    if (live?.status === 'active') return live;
    const elig = await eligibility(userId);
    if (!elig.ok || !elig.profile) return live;
    if (live?.status === 'pending') return finishCreate(live, elig.profile);
    if (live) return live; // rotating: the rotation owns it
    return createAccount(userId, elig.profile);
  })().finally(() => inflight.delete(userId));
  inflight.set(userId, p);
  return p;
}

async function createAccount(userId: string, profile: NonNullable<Eligibility['profile']>): Promise<VaRow | null> {
  const env = pagaConfig().env;
  const accountReference = newRef('kdva'); // 11-30 chars, permanent id at Paga
  let row: VaRow;
  try {
    const rows = await q<VaRow>(
      `INSERT INTO payment.virtual_account (user_id, live_user_id, env, account_reference, account_name, status, create_reference)
       VALUES ($1, $1, $2, $3, $4, 'pending', $5) RETURNING *`,
      [userId, env, accountReference, profile.accountName, newRef('kc')],
    );
    row = rows[0];
  } catch (e: any) {
    if (e?.code === '23505') return liveAccount(userId); // another request is creating it
    throw e;
  }
  return finishCreate(row, profile);
}

/** Create at Paga, or adopt the account if an earlier attempt timed out after Paga made it. */
async function finishCreate(row: VaRow, profile: NonNullable<Eligibility['profile']>): Promise<VaRow | null> {
  const cb = callbackUrl();
  const body = {
    referenceNumber: row.create_reference,
    accountReference: row.account_reference,
    accountName: profile.accountName,
    firstName: profile.firstName,
    lastName: profile.lastName,
    ...(profile.phone ? { phoneNumber: localPhone(profile.phone) } : {}),
    ...(profile.email ? { email: profile.email } : {}),
    // The sandbox refuses creation without both limits (code 109), although the docs mark them optional.
    fundingTransactionLimit: Number(process.env.PAGA_VA_TXN_LIMIT_NAIRA || 500_000),
    fundingDailyLimit: Number(process.env.PAGA_VA_DAILY_LIMIT_NAIRA || 2_000_000),
    status: 'ACTIVE',
    callbackUrl: cb,
  };
  // Hash: referenceNumber + accountReference + iifiNumber + autoSweep.bankPublicId + autoSweep.destination + autoSweep.accountNumber + callbackUrl
  const hashValues = [row.create_reference, row.account_reference, '', '', '', '', cb];
  let accountNumber: string | null = null;
  try {
    const r = await client().collectRest('POST', '/subsidiary-accounts', body, hashValues);
    if (okCode(r?.statusCode)) accountNumber = String(r.accountNumber ?? '') || null;
    else if (String(r?.statusCode) === '102') accountNumber = await retrieveNumber(row.account_reference);
    else throw new PagaError(`STATUS_${r?.statusCode}`, String(r?.statusMessage ?? 'create failed'), undefined, r);
  } catch (e) {
    if (e instanceof PagaError && e.code === 'TIMEOUT') {
      // Unknown outcome: look it up by our reference before trying again.
      accountNumber = await retrieveNumber(row.account_reference).catch(() => null);
      if (!accountNumber) {
        await q(`UPDATE payment.virtual_account SET last_error = $2 WHERE id = $1`, [row.id, 'timeout; will retry']);
        return { ...row, last_error: 'timeout; will retry' };
      }
    } else {
      const msg = (e as Error).message.slice(0, 300);
      await q(`UPDATE payment.virtual_account SET status = 'failed', live_user_id = NULL, last_error = $2 WHERE id = $1`, [row.id, msg]);
      observability.captureException(e);
      emit('payment.virtual_account_failed', { userId: row.user_id, error: msg });
      return null;
    }
  }
  if (!accountNumber) {
    await q(`UPDATE payment.virtual_account SET status = 'failed', live_user_id = NULL, last_error = 'no account number returned' WHERE id = $1`, [row.id]);
    return null;
  }
  const rows = await q<VaRow>(
    `UPDATE payment.virtual_account SET status = 'active', account_number = $2, activated_at = now(), last_error = NULL WHERE id = $1 RETURNING *`,
    [row.id, accountNumber],
  );
  emit('payment.virtual_account_created', { userId: row.user_id, env: row.env });
  return rows[0];
}

async function retrieveNumber(accountReference: string): Promise<string | null> {
  const ref = newRef('kr');
  const r = await client().collectRest('GET', `/subsidiary-accounts/${encodeURIComponent(accountReference)}?referenceNumber=${encodeURIComponent(ref)}`, undefined, [ref, accountReference]);
  return okCode(r?.statusCode) && r.accountNumber ? String(r.accountNumber) : null;
}

// ---------- rotate ----------

export class VaError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

/** New account number for the user; the balance moves across and the old number is disabled. */
export async function rotate(userId: string): Promise<VaRow> {
  const old = await liveAccount(userId);
  if (!old || old.status !== 'active' || !old.account_number) throw new VaError('NO_ACCOUNT', 'You do not have an account number yet', 404);
  const recent = await q<{ retired_at: string }>(
    `SELECT retired_at FROM payment.virtual_account WHERE user_id = $1 AND retired_reason = 'rotated' ORDER BY retired_at DESC LIMIT 1`, [userId],
  );
  if (recent[0] && Date.now() - new Date(recent[0].retired_at).getTime() < ROTATE_COOLDOWN_MS) {
    throw new VaError('ROTATE_TOO_SOON', 'You can change your account number once every 24 hours', 429);
  }
  const elig = await eligibility(userId);
  if (!elig.ok || !elig.profile) throw new VaError('NOT_ELIGIBLE', 'Account numbers are not available for this account', 403);

  // Free the live slot, create the new number, then move money and disable the old one.
  await q(`UPDATE payment.virtual_account SET status = 'rotating', live_user_id = NULL WHERE id = $1 AND status = 'active'`, [old.id]);
  let fresh: VaRow | null = null;
  try {
    fresh = await createAccount(userId, elig.profile);
  } finally {
    if (!fresh || fresh.status !== 'active') {
      if (fresh) await q(`UPDATE payment.virtual_account SET status = 'failed', live_user_id = NULL WHERE id = $1`, [fresh.id]).catch(() => undefined);
      await q(`UPDATE payment.virtual_account SET status = 'active', live_user_id = user_id WHERE id = $1`, [old.id]);
    }
  }
  if (!fresh || fresh.status !== 'active') throw new VaError('PAGA_UNAVAILABLE', 'Could not create a new account number right now. Your current number still works.', 502);

  await moveBalance(old, fresh, stableRef('kmv', `rotate:${old.id}`)).catch((e) => {
    observability.captureException(e);
    emit('payment.virtual_account_move_failed', { userId, from: old.id, to: fresh!.id });
  });
  await disableAtPaga(old).catch((e) => observability.captureException(e));
  await q(`UPDATE payment.virtual_account SET status = 'retired', retired_at = now(), retired_reason = 'rotated' WHERE id = $1`, [old.id]);
  emit('payment.virtual_account_rotated', { userId });
  return fresh;
}

/** Move the whole Paga balance of `from` into `to`. Stable reference: a retry never moves twice. */
async function moveBalance(from: VaRow, to: VaRow, reference: string, amountKobo?: bigint): Promise<void> {
  const kobo = amountKobo ?? await pagaBalanceKobo(from.account_reference);
  if (kobo <= 0n) return;
  const amount = koboToNaira(kobo);
  const narration = 'Kendibo account number change';
  const r = await client().collectRest('POST', '/subsidiary-accounts/transfer', {
    referenceNumber: reference,
    sourceAccountIdentifier: from.account_reference,
    destinationAccountIdentifier: to.account_reference,
    amount, currency: 'NGN', narration,
  }, [reference, from.account_reference, to.account_reference, amount, 'NGN', narration]);
  if (!okCode(r?.statusCode)) throw new PagaError(`STATUS_${r?.statusCode}`, String(r?.statusMessage ?? 'transfer failed'), undefined, r);
}

async function disableAtPaga(va: VaRow): Promise<void> {
  const ref = newRef('kd');
  // Hash: referenceNumber + accountIdentifier + iifiNumber + autoSweep.destination + autoSweep.bankPublicId + autoSweep.accountNumber + callbackUrl
  await client().collectRest('PUT', `/subsidiary-accounts/${encodeURIComponent(va.account_reference)}`,
    { referenceNumber: ref, status: 'DISABLED' }, [ref, va.account_reference, '', '', '', '', '']);
}

// ---------- pay from wallet ----------

export interface VaCharge { id: string; reference: string; virtualAccountId: string; amountKobo: bigint; accountReference: string }

/**
 * Before a wallet debit: charge the user's Paga sub-account for the part of the
 * amount it holds, so the money really moves to Kendibo's Paga balance.
 * Returns null when the user has no account number (nothing to charge).
 * Throws VaError PAGA_UNAVAILABLE when Paga does not confirm the charge.
 */
export async function chargeForWalletPayment(userId: string, walletRef: string, amountKobo: number): Promise<VaCharge | null> {
  const va = await liveAccount(userId);
  if (!va || va.status !== 'active') return null;
  const reference = stableRef('kch', walletRef);
  const prior = await q<{ id: string; status: string; amount_kobo: string }>(`SELECT id, status, amount_kobo FROM payment.va_charge WHERE reference = $1`, [reference]);
  if (prior[0]?.status === 'successful') {
    return { id: prior[0].id, reference, virtualAccountId: va.id, amountKobo: BigInt(prior[0].amount_kobo), accountReference: va.account_reference };
  }
  let chargeKobo: bigint;
  if (prior[0]) chargeKobo = BigInt(prior[0].amount_kobo); // same amount on retry, never re-sized
  else {
    let balance: bigint;
    try { balance = await pagaBalanceKobo(va.account_reference); }
    catch (e) { observability.captureException(e); throw new VaError('PAGA_UNAVAILABLE', 'Could not reach the payment provider. Please try again.', 502); }
    chargeKobo = balance < BigInt(amountKobo) ? balance : BigInt(amountKobo);
    if (chargeKobo <= 0n) return null;
  }
  const id = prior[0]?.id ?? (await q<{ id: string }>(
    `INSERT INTO payment.va_charge (virtual_account_id, user_id, reference, wallet_ref, amount_kobo) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (reference) DO UPDATE SET reference = EXCLUDED.reference RETURNING id`,
    [va.id, userId, reference, walletRef, String(chargeKobo)],
  ))[0].id;
  const amount = koboToNaira(chargeKobo);
  const narration = 'Kendibo booking payment';
  const attempt = () => client().collectRest('POST', `/subsidiary-accounts/${encodeURIComponent(va.account_reference)}/charge`,
    { referenceNumber: reference, amount, currency: 'NGN', narration }, [reference, amount, 'NGN', narration]);
  let r: any;
  try {
    try { r = await attempt(); }
    catch (e) { if (e instanceof PagaError && e.code === 'TIMEOUT') r = await attempt(); else throw e; } // same reference: Paga never charges twice
  } catch (e) {
    await q(`UPDATE payment.va_charge SET last_error = $2 WHERE id = $1`, [id, (e as Error).message.slice(0, 300)]);
    observability.captureException(e);
    throw new VaError('PAGA_UNAVAILABLE', 'Could not reach the payment provider. Please try again.', 502);
  }
  if (!okCode(r?.statusCode)) {
    await q(`UPDATE payment.va_charge SET status = 'failed', last_error = $2 WHERE id = $1`, [id, String(r?.statusMessage ?? r?.statusCode).slice(0, 300)]);
    throw new VaError('PAGA_DECLINED', 'The payment provider declined this payment.', 402);
  }
  await q(`UPDATE payment.va_charge SET status = 'successful', paga_transaction_id = $2, last_error = NULL WHERE id = $1`, [id, r.transactionId ? String(r.transactionId) : null]);
  return { id, reference, virtualAccountId: va.id, amountKobo: chargeKobo, accountReference: va.account_reference };
}

/** The wallet debit failed after a successful charge: put the money back in the sub-account. */
export async function reverseWalletCharge(c: VaCharge): Promise<void> {
  const reference = stableRef('krv', c.reference);
  const amount = koboToNaira(c.amountKobo);
  const narration = 'Kendibo payment reversal';
  const r = await client().collectRest('POST', `/subsidiary-accounts/${encodeURIComponent(c.accountReference)}/topup`,
    { referenceNumber: reference, amount, currency: 'NGN', narration }, [reference, amount, 'NGN', narration]);
  if (!okCode(r?.statusCode)) throw new PagaError(`STATUS_${r?.statusCode}`, 'reversal top-up failed', undefined, r);
  await q(`UPDATE payment.va_charge SET status = 'reversed' WHERE id = $1`, [c.id]);
}

// ---------- notifications ----------

/** Raw JSON token for a top-level field, exactly as Paga wrote it (keeps "1,000.00" and 1000.0 intact). */
export function rawField(raw: string, name: string): string {
  const m = raw.match(new RegExp(`"${name}"\\s*:\\s*("((?:[^"\\\\]|\\\\.)*)"|-?[0-9][0-9.eE+-]*|null|true|false)`));
  if (!m) return '';
  if (m[2] !== undefined) return m[2];
  return m[1] === 'null' ? '' : m[1];
}

const FUNDING_HASH_FIELDS = ['transactionReference', 'transactionDate', 'amount', 'accountNumber', 'timestamp'];
const ALLOWED_HASH_FIELDS = new Set([...FUNDING_HASH_FIELDS, 'fundingTransactionReference', 'fundingPaymentReference', 'statusCode', 'accountName']);

/** x-paga-hash-v3 over the fields Paga lists in x-paga-hash-v3-parameters (documented order when absent). */
export function verifyFundingHash(raw: string, headers: Record<string, string | string[] | undefined>, hashKey = pagaConfig().hashKey): boolean {
  const got = headers['x-paga-hash-v3'];
  if (!hashKey || typeof got !== 'string' || !got) return false;
  const listed = headers['x-paga-hash-v3-parameters'];
  let fields = FUNDING_HASH_FIELDS;
  if (typeof listed === 'string' && listed.trim()) {
    const names = listed.split(/[\s,+|;]+/).map((s) => s.trim()).filter(Boolean);
    // Never let the sender choose a hash over fields that don't bind the money.
    if (!names.every((n) => ALLOWED_HASH_FIELDS.has(n)) || !names.includes('amount') || !names.includes('accountNumber')) return false;
    fields = names;
  }
  return sameHash(pagaHash(fields.map((f) => rawField(raw, f)), hashKey), got);
}

/** Charge / top-up / transfer completion callbacks: hash in the body. */
export function verifyOperationHash(raw: string, hashKey = pagaConfig().hashKey): boolean {
  const got = rawField(raw, 'hash');
  if (!hashKey || !got) return false;
  return sameHash(pagaHash(['externalReferenceNumber', 'transactionDate', 'amount', 'accountNumber'].map((f) => rawField(raw, f)), hashKey), got);
}

const amountKoboOf = (v: unknown): bigint => nairaToKobo(String(v ?? '0').replace(/,/g, ''));

/** Is this credit in the sub-account's own Paga history? Counts, so two equal transfers need two credits. */
async function confirmedInHistory(va: VaRow, amountKobo: bigint, paidAt: Date): Promise<boolean> {
  const fmt = (d: Date) => d.toISOString().slice(0, 19);
  const start = fmt(new Date(paidAt.getTime() - 2 * 86400_000));
  const end = fmt(new Date(Date.now() + 3600_000));
  const ref = newRef('kh');
  const r = await client().collectRest('GET',
    `/subsidiary-accounts/${encodeURIComponent(va.account_reference)}/history?referenceNumber=${encodeURIComponent(ref)}&startDateTimeUTC=${encodeURIComponent(start)}&endDateTimeUTC=${encodeURIComponent(end)}&pageSize=100&pageNumber=0`,
    undefined, [va.account_reference, start, end]);
  if (!okCode(r?.statusCode)) return false;
  const items: any[] = Array.isArray(r.transactions) ? r.transactions : Array.isArray(r.items) ? r.items : [];
  const credits = items.filter((t) => String(t.transactionType ?? t.type ?? '').toUpperCase() === 'CREDIT'
    && amountKoboOf(t.amount) === amountKobo
    && !/FAIL|REVERS/i.test(String(t.status ?? '')));
  const already = await q<{ n: string }>(
    `SELECT COUNT(*) AS n FROM payment.va_funding WHERE virtual_account_id = $1 AND amount_kobo = $2 AND status = 'credited'`, [va.id, String(amountKobo)],
  );
  return credits.length > Number(already[0]?.n ?? 0);
}

export interface FundingResult { handled: 'credited' | 'duplicate' | 'unconfirmed' | 'ignored' | 'operation'; userId?: string }

/** Everything Paga POSTs to /webhooks/paga/subsidiary. Always safe to acknowledge after this returns. */
export async function handleSubsidiaryNotification(raw: string, headers: Record<string, string | string[] | undefined>): Promise<FundingResult> {
  let body: any;
  try { body = JSON.parse(raw); } catch { return { handled: 'ignored' }; }

  // Charge / top-up / transfer completion: we already know the outcome from the API reply; just record it.
  if (body?.event) {
    if (!verifyOperationHash(raw)) return { handled: 'ignored' };
    const eventId = `paga-sub:${String(body.notificationId ?? `${body.event}:${body.externalReferenceNumber}`)}`;
    await q(`INSERT INTO payment.webhook_event (psp, event_id, raw) VALUES ('paga', $1, $2) ON CONFLICT (event_id) DO NOTHING`, [eventId, raw]);
    return { handled: 'operation' };
  }

  const accountNumber = String(body?.accountNumber ?? '');
  const fundingRef = String(body?.fundingTransactionReference ?? body?.transactionReference ?? body?.fundingPaymentReference ?? '');
  if (!accountNumber || !fundingRef || !okCode(body?.statusCode ?? '0')) return { handled: 'ignored' };
  const va = await byNumber(accountNumber);
  if (!va) return { handled: 'ignored' };
  const amountKobo = amountKoboOf(rawField(raw, 'amount') || body.amount);
  if (amountKobo <= 0n) return { handled: 'ignored' };
  const paidAt = body.transactionDate && !Number.isNaN(Date.parse(`${String(body.transactionDate).replace(/Z?$/, 'Z')}`))
    ? new Date(`${String(body.transactionDate).replace(/Z?$/, 'Z')}`) : new Date();
  const payer = body.payerDetails ?? {};

  const existing = await q<{ id: string; status: string }>(`SELECT id, status FROM payment.va_funding WHERE funding_ref = $1`, [fundingRef]);
  if (existing[0]?.status === 'credited') return { handled: 'duplicate', userId: va.user_id };

  const signed = verifyFundingHash(raw, headers);
  let confirmedBy: string | null = signed ? 'hash' : null;
  if (!confirmedBy) {
    try { if (await confirmedInHistory(va, amountKobo, paidAt)) confirmedBy = 'history'; }
    catch (e) { observability.captureException(e); }
  }

  const fundingId = existing[0]?.id ?? (await q<{ id: string }>(
    `INSERT INTO payment.va_funding (virtual_account_id, user_id, funding_ref, amount_kobo, payer_name, payer_bank, payer_account_masked, narration, paid_at, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'received')
     ON CONFLICT (funding_ref) DO UPDATE SET funding_ref = EXCLUDED.funding_ref RETURNING id`,
    [va.id, va.user_id, fundingRef, String(amountKobo), payer.payerName ?? null, payer.payerBankName ?? null,
      maskAcct(payer.payerBankAccountNumber), body.narration ? String(body.narration).slice(0, 200) : null, paidAt.toISOString()],
  ))[0].id;

  if (!confirmedBy) {
    await q(`UPDATE payment.va_funding SET status = 'unconfirmed' WHERE id = $1 AND status <> 'credited'`, [fundingId]);
    emit('payment.va_funding_unconfirmed', { userId: va.user_id, amountKobo: String(amountKobo) });
    return { handled: 'unconfirmed', userId: va.user_id };
  }

  const walletRef = `pva_${fundingRef}`.slice(0, 120);
  await walletService.credit(va.user_id, Number(amountKobo), walletRef, 'topup');
  await q(`UPDATE payment.va_funding SET status = 'credited', confirmed_by = $2, wallet_ref = $3, credited_at = now() WHERE id = $1`, [fundingId, confirmedBy, walletRef]);
  emit('wallet.topup_succeeded', { psp: 'paga', via: 'virtual_account', userId: va.user_id, amountKobo: String(amountKobo) });

  // Money sent to an old (rotated) number: move it to the customer's current account.
  if (va.status === 'retired' || va.status === 'rotating') {
    const current = await liveAccount(va.user_id);
    if (current?.status === 'active' && current.id !== va.id) {
      await moveBalance(va, current, stableRef('kmv', `funding:${fundingId}`), amountKobo).catch((e) => observability.captureException(e));
    }
  }
  return { handled: 'credited', userId: va.user_id };
}

/** Re-check transfers that arrived without proof (called when the customer opens their wallet). */
export async function reconfirmPending(userId: string): Promise<number> {
  const rows = await q<{ id: string; funding_ref: string; amount_kobo: string; paid_at: string | null; virtual_account_id: string }>(
    `SELECT id, funding_ref, amount_kobo, paid_at, virtual_account_id FROM payment.va_funding WHERE user_id = $1 AND status = 'unconfirmed' ORDER BY created_at LIMIT 10`, [userId],
  );
  let credited = 0;
  for (const f of rows) {
    const va = (await q<VaRow>(`SELECT * FROM payment.virtual_account WHERE id = $1`, [f.virtual_account_id]))[0];
    if (!va) continue;
    const ok = await confirmedInHistory(va, BigInt(f.amount_kobo), f.paid_at ? new Date(f.paid_at) : new Date()).catch(() => false);
    if (!ok) continue;
    const walletRef = `pva_${f.funding_ref}`.slice(0, 120);
    await walletService.credit(userId, Number(f.amount_kobo), walletRef, 'topup');
    await q(`UPDATE payment.va_funding SET status = 'credited', confirmed_by = 'history', wallet_ref = $2, credited_at = now() WHERE id = $1`, [f.id, walletRef]);
    credited++;
  }
  return credited;
}

// ---------- views ----------

export interface AccountView {
  status: 'active' | 'pending' | 'not_available';
  reason?: Eligibility['reason'] | 'paga_error';
  accountNumber?: string; accountName?: string; bankName?: string;
  sandbox?: boolean; nextRotateAt?: string | null;
}

export async function accountView(userId: string): Promise<AccountView> {
  let va: VaRow | null = null;
  try { va = await ensureVirtualAccount(userId); }
  catch (e) { observability.captureException(e); return { status: 'not_available', reason: 'paga_error' }; }
  if (va?.status === 'active' && va.account_number) {
    await reconfirmPending(userId).catch(() => 0);
    const last = await q<{ retired_at: string }>(`SELECT retired_at FROM payment.virtual_account WHERE user_id = $1 AND retired_reason = 'rotated' ORDER BY retired_at DESC LIMIT 1`, [userId]);
    const next = last[0] ? new Date(new Date(last[0].retired_at).getTime() + ROTATE_COOLDOWN_MS) : null;
    return {
      status: 'active', accountNumber: va.account_number, accountName: va.account_name, bankName: va.bank_name,
      sandbox: va.env === 'sandbox', nextRotateAt: next && next.getTime() > Date.now() ? next.toISOString() : null,
    };
  }
  if (va?.status === 'pending') return { status: 'pending' };
  const elig = await eligibility(userId);
  return { status: 'not_available', reason: elig.ok ? 'paga_error' : elig.reason };
}

export async function fundingsFor(userId: string, limit = 50) {
  const rows = await q<Record<string, unknown>>(
    `SELECT f.amount_kobo, f.payer_name, f.payer_bank, f.payer_account_masked, f.narration, f.paid_at, f.status, f.created_at, v.account_number
       FROM payment.va_funding f JOIN payment.virtual_account v ON v.id = f.virtual_account_id
      WHERE f.user_id = $1 ORDER BY f.created_at DESC LIMIT $2`, [userId, limit],
  );
  return rows.map((r) => ({
    amountKobo: String(r.amount_kobo), payerName: r.payer_name ?? null, payerBank: r.payer_bank ?? null,
    payerAccount: r.payer_account_masked ?? null, narration: r.narration ?? null, status: String(r.status),
    paidAt: r.paid_at ? String(r.paid_at) : String(r.created_at), toAccount: r.account_number ? String(r.account_number) : null,
  }));
}

/** Admin: who has an account number, who has paid in, who has not. */
export async function adminList(opts: { filter?: 'all' | 'funded' | 'never_funded' | 'unconfirmed'; limit?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const rows = await q<Record<string, unknown>>(
    `SELECT v.user_id, v.account_number, v.account_name, v.status, v.env, v.created_at,
            u.phone, u.email,
            COALESCE(f.funded_kobo, 0) AS funded_kobo, COALESCE(f.funding_count, 0) AS funding_count,
            COALESCE(f.unconfirmed_count, 0) AS unconfirmed_count, f.last_funded_at,
            COALESCE(c.spent_kobo, 0) AS spent_kobo
       FROM payment.virtual_account v
       JOIN identity.users u ON u.id = v.user_id
       LEFT JOIN (
         SELECT virtual_account_id,
                SUM(CASE WHEN status = 'credited' THEN amount_kobo ELSE 0 END) AS funded_kobo,
                SUM(CASE WHEN status = 'credited' THEN 1 ELSE 0 END) AS funding_count,
                SUM(CASE WHEN status = 'unconfirmed' THEN 1 ELSE 0 END) AS unconfirmed_count,
                MAX(CASE WHEN status = 'credited' THEN paid_at ELSE NULL END) AS last_funded_at
           FROM payment.va_funding GROUP BY virtual_account_id
       ) f ON f.virtual_account_id = v.id
       LEFT JOIN (
         SELECT virtual_account_id, SUM(amount_kobo) AS spent_kobo
           FROM payment.va_charge WHERE status = 'successful' GROUP BY virtual_account_id
       ) c ON c.virtual_account_id = v.id
      WHERE v.status IN ('active', 'retired', 'rotating')
      ORDER BY v.created_at DESC LIMIT $1`, [limit],
  );
  const items = rows.map((r) => ({
    userId: String(r.user_id), accountNumber: r.account_number ? String(r.account_number) : null, accountName: String(r.account_name),
    status: String(r.status), sandbox: r.env === 'sandbox', createdAt: String(r.created_at),
    phone: r.phone ? `${String(r.phone).slice(0, 6)}…${String(r.phone).slice(-2)}` : null, email: r.email ? String(r.email) : null,
    fundedKobo: String(r.funded_kobo), fundingCount: Number(r.funding_count), unconfirmedCount: Number(r.unconfirmed_count),
    lastFundedAt: r.last_funded_at ? String(r.last_funded_at) : null, spentKobo: String(r.spent_kobo),
  }));
  const f = opts.filter ?? 'all';
  return items.filter((i) => f === 'all' || (f === 'funded' && i.fundingCount > 0) || (f === 'never_funded' && i.fundingCount === 0) || (f === 'unconfirmed' && i.unconfirmedCount > 0));
}

// ---------- KYC hook ----------

let hooked = false;
/** Give the account number as soon as KYC verifies (customer or provider). Never blocks KYC. */
export function installVirtualAccountHooks(onEmitFn: (l: (event: string, props: Record<string, unknown>) => void) => void): void {
  if (hooked) return; hooked = true;
  onEmitFn((event, props) => {
    if (!virtualAccountsEnabled()) return;
    let userIdP: Promise<string | null> | null = null;
    if (event === 'kyc.user.auto_verified' || event === 'kyc.user.approved') userIdP = Promise.resolve(props.userId ? String(props.userId) : null);
    else if (event === 'kyc.auto_verified' || event === 'kyc.approved') {
      userIdP = q<{ user_id: string }>(`SELECT user_id FROM provider.provider WHERE id::text = $1`, [String(props.providerId ?? '')]).then((r) => r[0]?.user_id ?? null);
    }
    if (!userIdP) return;
    void userIdP.then((uid) => (uid ? ensureVirtualAccount(uid) : null)).catch((e) => observability.captureException(e));
  });
}
