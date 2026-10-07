// PaymentService — PSP router. Primary Bachs, fallback Flutterwave.
// Rules: server owns money; webhook != truth until verified; every mutation idempotent.
import type { PaymentPort, PSP, CreateCheckoutInput, VerifiedPayment } from './payment.port.js';
import { BachsAdapter } from './bachs.adapter.js';
import { FlutterwaveAdapter } from './flutterwave.adapter.js';
import { q } from '../../packages/database/db.js';

export class PaymentService {
  private adapters: Record<PSP, PaymentPort>;

  /** Pass fake adapters in tests to avoid PSP network calls. */
  constructor(adapters?: Partial<Record<PSP, PaymentPort>>) {
    this.adapters = {
      bachs: adapters?.bachs ?? new BachsAdapter(),
      flutterwave: adapters?.flutterwave ?? new FlutterwaveAdapter(),
    };
  }

  private async recordIntent(psp: PSP, checkoutId: string, input: CreateCheckoutInput): Promise<void> {
    const bookingId = input.bookingId === 'wallet_topup' ? '00000000-0000-0000-0000-000000000000' : input.bookingId;
    try {
      await q(
        `INSERT INTO payment.payment (booking_id, psp, reference, charge_id, amount_kobo, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')`,
        [bookingId, psp, input.reference, checkoutId, Number(input.amountKobo)],
      );
    } catch { /* duplicate reference -> idempotent replay, ignore */ }
  }

  async createCheckout(input: CreateCheckoutInput, preferred: PSP = 'bachs') {
    // Check postgres for idempotency
    const existing = await q<{ psp: PSP; charge_id: string }>(
      `SELECT psp, charge_id FROM payment.payment WHERE reference=$1 LIMIT 1`,
      [input.reference]
    );
    if (existing[0]) return { psp: existing[0].psp, checkoutId: existing[0].charge_id || '' };

    try {
      const s = await this.adapters[preferred].createCheckout(input);
      await this.recordIntent(s.psp, s.checkoutId, input);
      return s;
    } catch (e) {
      if (preferred === 'bachs') {
        // Rule 10: no single-PSP dependency — fail over to Flutterwave
        const s = await this.adapters.flutterwave.createCheckout(input);
        await this.recordIntent(s.psp, s.checkoutId, input);
        return s;
      }
      throw e;
    }
  }

  /** Server-side verify of a charge (webhook is never trusted alone). */
  async verify(psp: PSP, chargeId: string): Promise<VerifiedPayment> {
    return this.adapters[psp].verifyByChargeId(chargeId);
  }

  /** PSP refund for a verified charge (policy decision happens in refundService first). */
  async refund(reference: string, amountKobo?: bigint, reason?: string): Promise<{ refundId: string; status: string }> {
    const rows = await q<{ charge_id: string; psp: PSP }>(
      `SELECT charge_id, psp FROM payment.payment WHERE reference=$1`, [reference],
    );
    const row = rows[0];
    if (!row?.charge_id) throw new Error('CHARGE_NOT_SETTLED');
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

  /** Webhook handler core: persist raw event, verify signature, then server-side verify before ledger. */
  async handleWebhook(psp: PSP, rawBody: Buffer, headers: Record<string, string | undefined>): Promise<{ ok: boolean; verified?: VerifiedPayment }> {
    const adapter = this.adapters[psp];
    const raw = rawBody.toString('utf-8');
    if (!adapter.verifyWebhookSignature(rawBody, headers)) return { ok: false };
    
    const event = JSON.parse(raw) as any;
    const eventId = event.id ?? event.event_id ?? `${psp}:${Date.now()}`;
    
    try {
      await q(`INSERT INTO payment.webhook_event (psp, event_id, raw) VALUES ($1,$2,$3)`, [psp, eventId, raw]);
    } catch (e) {
      // UNIQUE constraint violation means we already processed this webhook event
      return { ok: true, verified: undefined }; 
    }
    
    const reference =
      event.data?.tx_ref ?? event.data?.reference ?? event.data?.checkout_id ?? event.txRef;
    const chargeId = event.data?.id ?? event.data?.charge_id;
    const verified = chargeId
      ? await adapter.verifyByChargeId(String(chargeId))
      : await adapter.verifyByReference(String(reference));
    
    // Mark payment successful in local db
    if (verified && verified.status === 'successful') {
       await q(`UPDATE payment.payment SET status='successful', charge_id=$1 WHERE reference=$2`, [verified.chargeId || chargeId, verified.reference]);
    }

    // Only `successful` + amount/currency match may credit the ledger (caller checks expected amount).
    return { ok: true, verified };
  }
}
