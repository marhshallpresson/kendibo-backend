// FlutterwaveAdapter (FALLBACK) — implements PaymentPort against Flutterwave v3.
// Docs: https://developer.flutterwave.com/docs
// Auth: Bearer FLW_SECRET_KEY. Webhook: `verif-hash` header == FLW_SECRET_HASH, 200 fast,
// then re-query verify endpoint before giving value. Amounts: major units (2000 == NGN 2000).
import crypto from 'node:crypto';
import type { PaymentPort, CreateCheckoutInput, CheckoutSession, VerifiedPayment, RefundInput, PayoutInput } from './payment.port.js';
import { koboToFlutterwaveMajor } from './money.js';

const BASE = process.env.FLW_BASE_URL ?? 'https://api.flutterwave.com/v3';
const SECRET = process.env.FLW_SECRET_KEY ?? '';
const SECRET_HASH = process.env.FLW_SECRET_HASH ?? '';

async function flwFetch(path: string, init: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json', ...((init.headers as any) ?? {}) },
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || json.status === 'error') {
    const err = new Error(`FLW_${json.message ?? res.status}`) as Error & { data?: unknown };
    err.data = json;
    throw err;
  }
  return json;
}

export class FlutterwaveAdapter implements PaymentPort {
  readonly name = 'flutterwave' as const;

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
    // Flutterwave Standard: POST /payments { tx_ref, amount, currency, redirect_url, customer }
    const json = await flwFetch('/payments', {
      method: 'POST',
      body: JSON.stringify({
        tx_ref: input.reference,
        amount: koboToFlutterwaveMajor(input.amountKobo),
        currency: input.currency ?? 'NGN',
        redirect_url: 'https://kendibo.com/payment/callback',
        customer: { email: input.customerEmail, name: input.customerName },
        meta: { bookingId: input.bookingId },
      }),
    });
    return {
      psp: 'flutterwave',
      checkoutId: input.reference,
      checkoutUrl: json.data?.link ?? null,
      reference: input.reference,
      status: 'pending',
    };
  }

  async verifyByReference(reference: string): Promise<VerifiedPayment> {
    // Verify by tx_ref: list then confirm id via /transactions/:id/verify (per docs).
    const list = await flwFetch(`/transactions?tx_ref=${encodeURIComponent(reference)}`, { method: 'GET' });
    const tx = list.data?.[0];
    if (!tx) return { psp: 'flutterwave', chargeId: reference, reference, amountKobo: 0n, currency: 'NGN', status: 'pending' };
    return this.verifyByChargeId(String(tx.id));
  }

  async verifyByChargeId(chargeId: string): Promise<VerifiedPayment> {
    const json = await flwFetch(`/transactions/${encodeURIComponent(chargeId)}/verify`, { method: 'GET' });
    const d = json.data;
    const ok = d.status === 'successful' && d.currency === 'NGN';
    return {
      psp: 'flutterwave',
      chargeId: String(d.id),
      reference: d.tx_ref,
      amountKobo: BigInt(Math.round(Number(d.amount) * 100)),
      currency: 'NGN',
      status: ok ? 'successful' : d.status === 'failed' ? 'failed' : 'pending',
    };
  }

  async refund(input: RefundInput): Promise<{ refundId: string; status: string }> {
    // POST /transactions/:id/refund { amount?, comments } — min NGN 100.
    const body: Record<string, unknown> = { comments: input.reason ?? 'KENDIBO refund' };
    if (input.amountKobo !== undefined) body.amount = koboToFlutterwaveMajor(input.amountKobo);
    const json = await flwFetch(`/transactions/${encodeURIComponent(input.chargeId)}/refund`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return { refundId: String(json.data?.id ?? input.chargeId), status: json.data?.status ?? 'processing' };
  }

  async createPayout(input: PayoutInput): Promise<{ payoutId: string; status: string }> {
    // Payouts require a transfer recipient first; destinationId carries "bankCode:accountNumber".
    // POST /transfers { account_bank, account_number, amount, currency, reference, narration }
    const [account_bank, account_number] = input.destinationId.split(':');
    const json = await flwFetch('/transfers', {
      method: 'POST',
      body: JSON.stringify({
        account_bank,
        account_number,
        amount: koboToFlutterwaveMajor(input.amountKobo),
        currency: 'NGN',
        reference: input.reference,
        narration: input.narration ?? 'KENDIBO provider payout',
      }),
    });
    return { payoutId: String(json.data?.id), status: json.data?.status ?? 'NEW' };
  }

  async createVirtualAccount(input: { userId: string; email: string; name: string }) {
    return { accountName: input.name, accountNumber: '0000000000', bankName: 'Flutterwave Dummy' };
  }

  async verifyBankAccount(input: { accountNumber: string; bankCode: string }) {
    return { accountName: 'FW Verified', valid: true };
  }

  verifyWebhookSignature(_rawBody: Buffer | string, headers: Record<string, string | string[] | undefined>): boolean {
    const sig = String(headers['verif-hash'] ?? '');
    if (!sig || !SECRET_HASH) return false;
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(SECRET_HASH));
  }
}
