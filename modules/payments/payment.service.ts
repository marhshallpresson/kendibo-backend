// PaymentService — Paga is the only payment provider.
// Rules: server owns money; webhook != truth until verified; every mutation idempotent.
// Transient PSP failures (timeouts, 429/5xx) get one quick retry with the SAME
// reference — safe, because Paga dedupes on it — before the caller sees PSP_UNAVAILABLE.
//
// Paga is always on when its keys are set (PAGA_PUBLIC_KEY, PAGA_SECRET_KEY, PAGA_HASH_KEY);
// PAGA_ENV (sandbox|live) only picks the environment. Without keys checkout fails with
// PspUnavailableError (HTTP 503 PSP_UNAVAILABLE) — it never falls back to another PSP.
//
// One reference format for every checkout (booking, wallet top-up, tier fee, Kendibo Pro):
//   kb_<p>_<24 hex>   p = b booking | w top-up | t tier | s subscription
// minted here from (purpose, owner, subject, idempotency key). The owner of a payment is
// always the user_id stored on our row, never parsed from the reference or taken from
// client input; for bookings it is the booking's own customer.
import { createHash } from 'node:crypto';
import type { PaymentPort, PSP, CheckoutPurpose, CreateCheckoutInput, CheckoutSession, VerifiedPayment } from './payment.port.js';
import { PagaAdapter, paymentExpiryHours } from './paga.adapter.js';
import { PagaClient, pagaConfigured } from './paga/client.js';
import { q } from '../../packages/database/db.js';

export const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
export const REFERENCE_PREFIX = 'kb_';
const PURPOSE_LETTER: Record<CheckoutPurpose, string> = { booking: 'b', topup: 'w', tier: 't', subscription: 's' };

/** Paga is not configured (or unreachable for good): checkout answers 503 PSP_UNAVAILABLE. */
export class PspUnavailableError extends Error {
  readonly code = 'PSP_UNAVAILABLE';
  constructor(message = 'Paga is not configured') { super(`PSP_UNAVAILABLE: ${message}`); }
}

/** What a caller asks for. `reference` is accepted only as a legacy subject for tier/subscription rows. */
export interface CheckoutRequest {
  bookingId: string; // a booking id, or 'wallet_topup' for every non-booking purpose
  amountKobo: bigint;
  purpose?: CheckoutPurpose;
  customerEmail?: string;
  customerName?: string;
  reference?: string;
  idempotencyKey: string;
  metadata?: Record<string, string>;
  /** Payer for top-ups / tier / subscription. Bookings ignore it: the booking's own customer pays. */
  userId?: string;
}

/** The hash-verified fields of a Paga Collect callback that decide how much money arrived. */
export interface PagaCallback {
  notificationId: string | null; state: string | null; statusCode: string | null;
  paymentKobo: bigint | null; cumulativeKobo: bigint | null; outstandingKobo: bigint | null;
}

export interface PaymentRow {
  reference: string; psp: string; status: string; purpose: string; booking_id: string;
  amount_kobo: string | number; received_kobo: string | number; user_id: string | null; subject_ref: string | null;
  charge_id: string | null; settled_at: string | null; confirmed_at: string | null; created_at: string; psp_details: unknown;
  callback_state: string | null; callback_cumulative_kobo: string | number | null; review_flag: string | null;
}

const transient = (e: unknown) => {
  const m = String((e as Error)?.message ?? '');
  return /PAGA_HTTP_5\d\d|PAGA_TIMEOUT|PAGA_RATE_LIMITED|timeout|aborted|ECONNRESET|ETIMEDOUT|fetch failed/i.test(m);
};

/** Signed page where a Paga bank-transfer payer sees the account number and amount. */
async function pagaPayPage(reference: string): Promise<string> {
  const { signLink, webBase } = await import('../whatsapp/links.js');
  // Link lives as long as the payment request itself.
  return `${webBase()}/w/paga/pay?t=${encodeURIComponent(signLink({ w: 'paga', d: reference, p: 'paga' }, paymentExpiryHours() * 3600))}`;
}
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) {
    if (!transient(e)) throw e;
    await new Promise((r) => setTimeout(r, 400));
    return fn();
  }
}

/** Deterministic server-minted reference: the same (purpose, owner, subject, key) always maps to the same one. */
export function mintReference(purpose: CheckoutPurpose, userId: string, subject: string, idempotencyKey: string): string {
  const h = createHash('sha256').update([purpose, userId, subject, idempotencyKey].join('|')).digest('hex').slice(0, 24);
  return `${REFERENCE_PREFIX}${PURPOSE_LETTER[purpose]}_${h}`;
}

export class PaymentService {
  private paga: PaymentPort;
  /** A test passed its own Paga adapter, so Paga counts as configured. */
  private readonly injected: boolean;

  /** Pass a fake adapter in tests to avoid PSP network calls. */
  constructor(adapters?: Partial<Record<PSP, PaymentPort>>) {
    this.injected = Boolean(adapters?.paga);
    this.paga = adapters?.paga ?? new PagaAdapter(new PagaClient(), () => '');
  }

  isConfigured(): boolean { return this.injected || pagaConfigured(); }
  private requireConfigured() { if (!this.isConfigured()) throw new PspUnavailableError(); }

  /** Work out purpose, owner and subject from our own records. */
  private async resolve(input: CheckoutRequest): Promise<{ purpose: CheckoutPurpose; userId: string; subject: string; bookingId: string }> {
    if (input.bookingId !== 'wallet_topup') {
      const rows = await q<{ user_id: string }>(`SELECT user_id FROM booking.booking WHERE id = $1`, [input.bookingId]);
      if (!rows[0]) throw new Error('BOOKING_NOT_FOUND');
      return { purpose: 'booking', userId: String(rows[0].user_id), subject: input.bookingId, bookingId: input.bookingId };
    }
    const legacy = input.reference ?? '';
    const purpose: CheckoutPurpose = input.purpose
      ?? (legacy.startsWith('tier_') ? 'tier' : legacy.startsWith('sub_') ? 'subscription' : 'topup');
    if (purpose === 'booking') throw new Error('CHECKOUT_PURPOSE_INVALID');
    if (!input.userId) throw new Error('CHECKOUT_OWNER_REQUIRED');
    return { purpose, userId: input.userId, subject: purpose === 'topup' ? '' : legacy, bookingId: ZERO_UUID };
  }

  private async recordIntent(
    r: { purpose: CheckoutPurpose; userId: string; subject: string; bookingId: string },
    reference: string, checkoutId: string, checkoutUrl: string | null, amountKobo: bigint, details: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      await q(
        `INSERT INTO payment.payment (booking_id, psp, reference, charge_id, amount_kobo, status, checkout_url, psp_details, user_id, purpose, subject_ref, next_check_at)
         VALUES ($1, 'paga', $2, $3, $4, 'pending', $5, $6::jsonb, $7, $8, $9, $10)`,
        [r.bookingId, reference, checkoutId, Number(amountKobo), checkoutUrl, JSON.stringify(details), r.userId, r.purpose,
          r.subject || null, new Date(Date.now() + 60_000).toISOString()],
      );
      return true;
    } catch (error) {
      if ((error as { code?: string }).code !== '23505') throw error;
      const existing = await q<{ booking_id: string; amount_kobo: string; psp: string; user_id: string | null }>(
        `SELECT booking_id, amount_kobo, psp, user_id FROM payment.payment WHERE reference=$1`, [reference],
      );
      if (!existing[0] || String(existing[0].booking_id) !== r.bookingId || BigInt(String(existing[0].amount_kobo)) !== amountKobo || existing[0].psp !== 'paga' || String(existing[0].user_id ?? '') !== r.userId) throw new Error('PAYMENT_REFERENCE_CONFLICT');
      return false;
    }
  }

  async createCheckout(input: CheckoutRequest): Promise<CheckoutSession> {
    this.requireConfigured();
    if (input.amountKobo <= 0n) throw new Error('BAD_AMOUNT');
    const resolved = await this.resolve(input);
    const reference = mintReference(resolved.purpose, resolved.userId, resolved.subject, input.idempotencyKey);

    const existing = await q<{ psp: string; charge_id: string; booking_id: string; amount_kobo: string; status: string; checkout_url: string | null; user_id: string | null }>(
      `SELECT psp, charge_id, booking_id, amount_kobo, status, checkout_url, user_id FROM payment.payment WHERE reference=$1 LIMIT 1`, [reference],
    );
    if (existing[0]) {
      if (String(existing[0].booking_id) !== resolved.bookingId || BigInt(String(existing[0].amount_kobo)) !== input.amountKobo || existing[0].psp !== 'paga' || String(existing[0].user_id ?? '') !== resolved.userId) throw new Error('PAYMENT_REFERENCE_CONFLICT');
      if (existing[0].status !== 'pending' || !existing[0].charge_id || !existing[0].checkout_url) throw new Error('CHECKOUT_NOT_OPEN');
      const getCheckout = this.paga.getCheckout;
      if (!getCheckout) throw new Error('CHECKOUT_RECOVERY_UNAVAILABLE');
      const session = await withRetry(() => getCheckout.call(this.paga, existing[0].charge_id, reference));
      return { ...session, checkoutUrl: existing[0].checkout_url };
    }

    // Payer details come from the owner's own profile (they go into the Paga request and its hash).
    const payer = (await q<{ name: string | null; phone: string | null; email: string | null }>(
      `SELECT name, phone, email FROM identity.users WHERE id::text = $1`, [resolved.userId],
    ).catch(() => []))[0];
    const customerName = input.customerName || payer?.name || undefined;
    const customerEmail = input.customerEmail || payer?.email || undefined;
    const adapterInput: CreateCheckoutInput = {
      bookingId: resolved.bookingId, amountKobo: input.amountKobo, reference, idempotencyKey: input.idempotencyKey, userId: resolved.userId,
      ...(customerEmail ? { customerEmail } : {}),
      ...(customerName ? { customerName } : {}),
      metadata: { ...(input.metadata ?? {}), ...(payer?.phone ? { phone: payer.phone } : {}) },
    };
    const s = await withRetry(() => this.paga.createCheckout(adapterInput));
    // Paga bank transfers have no hosted page: the customer gets our signed pay page.
    if (!s.checkoutUrl) s.checkoutUrl = await pagaPayPage(reference);
    if (!s.checkoutId || !s.checkoutUrl) throw new Error('CHECKOUT_UNAVAILABLE');
    const details = { ...(s.details ?? {}), ...(input.metadata?.source ? { source: input.metadata.source } : {}) };
    return await this.recordIntent(resolved, reference, s.checkoutId, s.checkoutUrl, input.amountKobo, details) ? s : this.createCheckout(input);
  }

  /** Server-side status of a payment at Paga (webhooks and clients are never trusted for amounts). */
  async verifyReference(reference: string): Promise<VerifiedPayment> {
    this.requireConfigured();
    return withRetry(() => this.paga.verifyByReference(reference));
  }

  /** Server-side verify of a stored payment (admin/client verify endpoint). Legacy rows have no live PSP to ask. */
  async verify(psp: string, chargeId: string): Promise<VerifiedPayment> {
    if (psp !== 'paga') throw new Error('VERIFY_RETIRED_PSP');
    return withRetry(() => this.paga.verifyByChargeId(chargeId));
  }

  /** Paga refund for a verified charge (policy decision happens in refundService first). */
  async refund(reference: string, amountKobo?: bigint, reason?: string): Promise<{ refundId: string; status: string }> {
    const rows = await q<{ charge_id: string; psp: string }>(`SELECT charge_id, psp FROM payment.payment WHERE reference=$1`, [reference]);
    const row = rows[0];
    if (!row?.charge_id) throw new Error('CHARGE_NOT_SETTLED');
    if (row.psp !== 'paga') throw new Error('REFUND_RETIRED_PSP'); // pre-Paga charges: refund in that provider's dashboard
    this.requireConfigured();
    return this.paga.refund({
      chargeId: row.charge_id, reference: `rf_${reference}`,
      ...(amountKobo !== undefined ? { amountKobo } : {}),
      reason, idempotencyKey: `rf_${reference}`,
    });
  }

  async createVirtualAccount(userId: string, email: string, name: string) {
    this.requireConfigured();
    return this.paga.createVirtualAccount({ userId, email, name });
  }

  async verifyBankAccount(accountNumber: string, bankCode: string) {
    this.requireConfigured();
    return this.paga.verifyBankAccount({ accountNumber, bankCode });
  }

  /** Supported payout banks for a country (PSP reference data). */
  async listBanks(country = 'NG') {
    this.requireConfigured();
    if (!this.paga.listBanks) throw new Error('BANKS_UNSUPPORTED');
    return this.paga.listBanks(country);
  }

  /** Signature check + parse of a Paga payment callback. The body is only a pointer to a reference: amounts always come from /status. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): { ok: false } | { ok: true; eventId: string; reference: string | null; raw: string; callback: PagaCallback } {
    if (!this.paga.verifyWebhookSignature(rawBody, headers)) return { ok: false };
    const raw = rawBody.toString('utf-8');
    const event = JSON.parse(raw) as Record<string, unknown>;
    const ref = event.externalReferenceNumber ?? event.referenceNumber;
    const kobo = (v: unknown): bigint | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) || Number(v) < 0 ? null : BigInt(Math.round(Number(v) * 100)));
    const notificationId = event.notificationId ? String(event.notificationId) : null;
    return {
      ok: true, raw,
      eventId: notificationId ? `paga:${notificationId}` : `paga:${createHash('sha256').update(raw).digest('hex').slice(0, 32)}`,
      reference: ref ? String(ref) : null,
      callback: {
        notificationId, state: event.state ? String(event.state).toUpperCase() : null, statusCode: event.statusCode === undefined ? null : String(event.statusCode),
        paymentKobo: kobo(event.paymentAmount), cumulativeKobo: kobo(event.cumulativePaymentAmount), outstandingKobo: kobo(event.outstandingBalance),
      },
    };
  }
}
