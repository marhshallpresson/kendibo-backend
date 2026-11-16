// PaymentService — Bachs.io is the live PSP; Paga runs in sandbox for test accounts.
// Rules: server owns money; webhook != truth until verified; every mutation idempotent.
// Transient PSP failures (timeouts, 429/5xx) get one quick retry with the SAME
// reference/idempotency key — safe, because the PSP dedupes on it — before the
// caller sees PSP_UNAVAILABLE.
//
// Routing (PAGA_MODE):
//   off (default)   every payment uses Bachs.
//   test-accounts   Paga sandbox only when the customer AND the assigned pro (if any)
//                   are flagged identity.users.is_test. Real customers never touch
//                   sandbox money; test accounts never touch live rails.
//   all             every booking payment goes to Paga — only with PAGA_ENV=live
//                   (on the sandbox it behaves like test-accounts). Card top-ups
//                   stay on Bachs; customers fund the wallet by bank transfer to
//                   their own Paga account number instead.
import type { PaymentPort, PSP, CreateCheckoutInput, CheckoutSession, VerifiedPayment } from './payment.port.js';
import { BachsAdapter } from './bachs.adapter.js';
import { PagaAdapter } from './paga.adapter.js';
import { PagaClient, pagaConfigured } from './paga/client.js';
import { q } from '../../packages/database/db.js';

const transient = (e: unknown) => {
  const m = String((e as Error)?.message ?? '');
  return /BACHS_(429|5\d\d)|PAGA_HTTP_5\d\d|timeout|aborted|ECONNRESET|ETIMEDOUT|fetch failed/i.test(m);
};

/** Signed page where a Paga bank-transfer payer sees the account number and amount. */
async function pagaPayPage(reference: string): Promise<string> {
  const { signLink, webBase } = await import('../whatsapp/links.js');
  return `${webBase()}/w/paga/pay?t=${encodeURIComponent(signLink({ w: 'paga', d: reference, p: 'paga' }, 24 * 3600))}`;
}
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) {
    if (!transient(e)) throw e;
    await new Promise((r) => setTimeout(r, 400));
    return fn();
  }
}

export class PaymentService {
  private adapters: Record<PSP, PaymentPort>;
  /** A test passed its own Paga adapter, so Paga counts as configured. */
  private readonly pagaInjected: boolean;

  /** Pass a fake adapter in tests to avoid PSP network calls. */
  constructor(adapters?: Partial<Record<PSP, PaymentPort>>) {
    this.pagaInjected = Boolean(adapters?.paga);
    this.adapters = {
      bachs: adapters?.bachs ?? new BachsAdapter(),
      paga: adapters?.paga ?? new PagaAdapter(new PagaClient(), () => ''),
    };
  }

  /** Which PSP a new payment goes to (see PAGA_MODE above). */
  async pspFor(input: CreateCheckoutInput): Promise<PSP> {
    const mode = process.env.PAGA_MODE === 'all' ? 'all' : process.env.PAGA_MODE === 'test-accounts' ? 'test-accounts' : 'off';
    if (mode === 'off') return 'bachs';
    if (!this.pagaInjected && !pagaConfigured()) return 'bachs';
    if (input.bookingId === 'wallet_topup') return 'bachs';
    if (mode === 'all' && process.env.PAGA_ENV === 'live') return 'paga';
    const customer = await q<{ is_test: boolean }>(
      `SELECT u.is_test FROM booking.booking b JOIN identity.users u ON u.id = b.user_id WHERE b.id = $1`, [input.bookingId],
    ).catch(() => []);
    if (!customer[0]?.is_test) return 'bachs';
    const pros = await q<{ is_test: boolean }>(
      `SELECT u.is_test FROM dispatch.assignment a
         JOIN provider.provider p ON p.id = a.provider_id
         JOIN identity.users u ON u.id = p.user_id
        WHERE a.job_id = $1 AND a.status = 'accepted'`, [input.bookingId],
    ).catch(() => []);
    return pros.every((p) => p.is_test) ? 'paga' : 'bachs';
  }


  private async recordIntent(psp: PSP, checkoutId: string, checkoutUrl: string | null, input: CreateCheckoutInput, details?: Record<string, unknown>): Promise<boolean> {
    const bookingId = input.bookingId === 'wallet_topup' ? '00000000-0000-0000-0000-000000000000' : input.bookingId;
    try {
      await q(
        `INSERT INTO payment.payment (booking_id, psp, reference, charge_id, amount_kobo, status, checkout_url, psp_details)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7::jsonb)`,
        [bookingId, psp, input.reference, checkoutId, Number(input.amountKobo), checkoutUrl, JSON.stringify(details ?? {})],
      );
      return true;
    } catch (error) {
      if ((error as { code?: string }).code !== '23505') throw error;
      const existing = await q<{ booking_id: string; amount_kobo: string; psp: string }>(
        `SELECT booking_id, amount_kobo, psp FROM payment.payment WHERE reference=$1`, [input.reference],
      );
      if (!existing[0] || String(existing[0].booking_id) !== bookingId || BigInt(String(existing[0].amount_kobo)) !== input.amountKobo || existing[0].psp !== psp) throw new Error('PAYMENT_REFERENCE_CONFLICT');
      return false;
    }
  }

  async createCheckout(input: CreateCheckoutInput, preferredPsp?: PSP): Promise<CheckoutSession> {
    const preferred: PSP = preferredPsp ?? (await this.pspFor(input));
    // Check postgres for idempotency
    const existing = await q<{ psp: PSP; charge_id: string; booking_id: string; amount_kobo: string; status: string; checkout_url: string | null }>(
      `SELECT psp, charge_id, booking_id, amount_kobo, status, checkout_url FROM payment.payment WHERE reference=$1 LIMIT 1`,
      [input.reference]
    );
    if (existing[0]) {
      const bookingId = input.bookingId === 'wallet_topup' ? '00000000-0000-0000-0000-000000000000' : input.bookingId;
      if (String(existing[0].booking_id) !== bookingId || BigInt(String(existing[0].amount_kobo)) !== input.amountKobo || existing[0].psp !== preferred) throw new Error('PAYMENT_REFERENCE_CONFLICT');
      if (existing[0].status !== 'pending' || !existing[0].charge_id || !existing[0].checkout_url) throw new Error('CHECKOUT_NOT_OPEN');
      const getCheckout = this.adapters[preferred].getCheckout;
      if (!getCheckout) throw new Error('CHECKOUT_RECOVERY_UNAVAILABLE');
      const session = await withRetry(() => getCheckout.call(this.adapters[preferred], existing[0].charge_id, input.reference));
      return { ...session, checkoutUrl: existing[0].checkout_url };
    }

    const s = await withRetry(() => this.adapters[preferred].createCheckout(input));
    // Paga bank transfers have no hosted page: the customer gets our signed pay page.
    if (s.psp === 'paga' && !s.checkoutUrl) s.checkoutUrl = await pagaPayPage(input.reference);
    if (!s.checkoutId || !s.checkoutUrl) throw new Error('CHECKOUT_UNAVAILABLE');
    return await this.recordIntent(s.psp, s.checkoutId, s.checkoutUrl, input, s.details) ? s : this.createCheckout(input, preferred);
  }

  /** Server-side verify of a charge (webhook is never trusted alone). */
  async verify(psp: PSP, chargeId: string): Promise<VerifiedPayment> {
    const adapter = this.adapters[psp] ?? this.adapters.bachs; // legacy rows may carry a retired PSP name
    return withRetry(() => adapter.verifyByChargeId(chargeId));
  }

  /** PSP refund for a verified charge (policy decision happens in refundService first). */
  async refund(reference: string, amountKobo?: bigint, reason?: string): Promise<{ refundId: string; status: string }> {
    const rows = await q<{ charge_id: string; psp: PSP }>(
      `SELECT charge_id, psp FROM payment.payment WHERE reference=$1`, [reference],
    );
    const row = rows[0];
    if (!row?.charge_id) throw new Error('CHARGE_NOT_SETTLED');
    if (row.psp !== 'bachs' && row.psp !== 'paga') throw new Error('REFUND_RETIRED_PSP'); // pre-Oct-2026 Flutterwave charges: refund in its dashboard
    return this.adapters[row.psp].refund({
      chargeId: row.charge_id, reference: `rf_${reference}`,
      ...(amountKobo !== undefined ? { amountKobo } : {}),
      reason, idempotencyKey: `rf_${reference}`,
    });
  }

  async createVirtualAccount(userId: string, email: string, name: string, preferred: PSP = 'bachs') {
    return this.adapters[preferred].createVirtualAccount({ userId, email, name });
  }

  async verifyBankAccount(accountNumber: string, bankCode: string, preferred: PSP = 'bachs') {
    return this.adapters[preferred].verifyBankAccount({ accountNumber, bankCode });
  }

  /** Supported payout banks for a country (PSP reference data). */
  async listBanks(country = 'NG', preferred: PSP = 'bachs') {
    const adapter = this.adapters[preferred];
    if (!adapter.listBanks) throw new Error('BANKS_UNSUPPORTED');
    return adapter.listBanks(country);
  }

  /** Webhook handler core: persist raw event, verify signature, then server-side verify before ledger. */
  async handleWebhook(psp: PSP, rawBody: Buffer, headers: Record<string, string | undefined>): Promise<{ ok: boolean; verified?: VerifiedPayment; notFound?: boolean; amountMismatch?: boolean; transitioned?: boolean }> {
    const adapter = this.adapters[psp];
    const raw = rawBody.toString('utf-8');
    if (!adapter.verifyWebhookSignature(rawBody, headers)) return { ok: false };

    const event = JSON.parse(raw) as any;
    // Paga retries reuse notificationId; Bachs sends id/event_id.
    const eventId = event.id ?? event.event_id ?? (event.notificationId ? `paga:${event.notificationId}` : `${psp}:${Date.now()}`);
    
    // Dedupe on the raw event BEFORE any PSP verify call — replays short-circuit here.
    try {
      await q(`INSERT INTO payment.webhook_event (psp, event_id, raw) VALUES ($1,$2,$3)`, [psp, eventId, raw]);
    } catch {
      // UNIQUE violation = already processed this webhook event (idempotent replay).
      return { ok: true, verified: undefined };
    }
    
    const reference =
      event.data?.tx_ref ?? event.data?.reference ?? event.data?.checkout_id ?? event.txRef ?? event.externalReferenceNumber;
    const chargeId = event.data?.charge_id ?? event.data?.payment_id ?? event.data?.id;

    let verified: VerifiedPayment;
    try {
      verified = chargeId
        ? await adapter.verifyByChargeId(String(chargeId))
        : await adapter.verifyByReference(String(reference));
    } catch (e) {
      // Unknown charge at the PSP (deleted/never existed) — 404 semantics, not a crash.
      if ((e as Error).message?.includes('404')) return { ok: true, notFound: true };
      throw e;
    }

    if (verified.status === 'successful') {
      // Amount cross-check: the PSP-verified amount must match what we recorded.
      // A mismatch means tampering or a stale reference — never mark paid.
      const rows = await q<{ amount_kobo: string | number; status: string }>(
        `SELECT amount_kobo, status FROM payment.payment WHERE reference=$1`, [verified.reference],
      );
      const local = rows[0];
      if (!local) return { ok: true, notFound: true };
      if (BigInt(String(local.amount_kobo)) !== verified.amountKobo) {
        return { ok: true, amountMismatch: true };
      }
      const changed = await q(
        `UPDATE payment.payment SET status='successful', charge_id=$1 WHERE reference=$2 AND status<>'successful' RETURNING reference`,
        [verified.chargeId || String(chargeId ?? ''), verified.reference],
      );
      return { ok: true, verified, transitioned: changed.length > 0 };
    }

    // Only `successful` + amount match may credit the ledger (caller checks expected amount).
    return { ok: true, verified };
  }

  /**
   * Pull-side sync for when the webhook is late or never arrives: ask the PSP
   * about a pending payment and mark it paid if it settled with the recorded
   * amount. `transitioned` is true only the first time, so callers settle once.
   */
  async reconcile(reference: string): Promise<{ status: string; transitioned: boolean; verified?: VerifiedPayment }> {
    const rows = await q<{ psp: PSP; charge_id: string | null; amount_kobo: string; status: string }>(
      `SELECT psp, charge_id, amount_kobo, status FROM payment.payment WHERE reference=$1`, [reference],
    );
    const local = rows[0];
    if (!local) return { status: 'not_found', transitioned: false };
    if (local.status !== 'pending' || (local.psp !== 'bachs' && local.psp !== 'paga')) return { status: local.status, transitioned: false };
    const adapter = this.adapters[local.psp];
    let verified: VerifiedPayment;
    try {
      verified = await adapter.verifyByReference(reference);
    } catch {
      return { status: 'pending', transitioned: false };
    }
    if (verified.status === 'failed') {
      await q(`UPDATE payment.payment SET status='failed' WHERE reference=$1 AND status='pending'`, [reference]);
      return { status: 'failed', transitioned: false, verified };
    }
    if (verified.status !== 'successful' || verified.reference !== reference) return { status: 'pending', transitioned: false };
    if (BigInt(String(local.amount_kobo)) !== verified.amountKobo) return { status: 'pending', transitioned: false };
    const changed = await q(
      `UPDATE payment.payment SET status='successful', charge_id=COALESCE($1, charge_id) WHERE reference=$2 AND status<>'successful' RETURNING reference`,
      [verified.chargeId || null, reference],
    );
    return { status: 'successful', transitioned: changed.length > 0, verified };
  }
}
