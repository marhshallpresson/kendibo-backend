// BachsAdapter (PRIMARY) — implements PaymentPort against Bachs.io REST.
// Docs: https://docs.bachs.io (sandbox https://sandbox-api.bachs.io, prod https://api.bachs.io)
// Conventions: Bearer sk_sandbox_/sk_live_, money = decimal STRING ("7000.00") + currency,
// Idempotency-Key header on POST, webhooks signed X-Bachs-Signature = HMAC_SHA256("{ts}.{rawBody}").
import crypto from 'node:crypto';
import type { PaymentPort, CreateCheckoutInput, CheckoutSession, VerifiedPayment, RefundInput, PayoutInput } from './payment.port.js';
import { koboToBachsDecimal, bachsDecimalToKobo } from './money.js';

const BASE = process.env.BACHS_BASE_URL ?? 'https://sandbox-api.bachs.io';
const KEY = process.env.BACHS_API_KEY ?? '';
const WEBHOOK_SECRET = process.env.BACHS_WEBHOOK_SECRET ?? '';

async function bachsFetch(path: string, init: RequestInit & { idempotencyKey?: string }) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${KEY}`,
    Accept: 'application/json',
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    const err = new Error(`BACHS_${res.status}`) as Error & { data?: unknown };
    err.data = json;
    throw err;
  }
  return json;
}

export class BachsAdapter implements PaymentPort {
  readonly name = 'bachs' as const;

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
    // KENDIBO prices server-side in kobo; Bachs takes raw `pricing` decimal string.
    // https://docs.bachs.io/guides/checkout/checkout-sessions (Charge a raw amount)
    // Redirects are deep-links back into the apps; webhook stays source of truth.
    const amount = koboToBachsDecimal(input.amountKobo);
    const json = await bachsFetch('/v1/checkout-sessions', {
      method: 'POST',
      idempotencyKey: input.idempotencyKey,
      body: JSON.stringify({
        pricing: { currency: input.currency ?? 'NGN', amount },
        customer: { email: input.customerEmail, name: input.customerName },
        reference: input.reference,
        // Live Bachs rejects non-http(s) schemes ("success_url must use http://
        // or https:// scheme") — deep-link fallbacks belong on the https page.
        success_url: process.env.BACHS_SUCCESS_URL ?? 'https://kendibo-app.pxxl.click/payment/callback',
        cancel_url: process.env.BACHS_CANCEL_URL ?? 'https://kendibo-app.pxxl.click/payment/callback',
        metadata: { bookingId: input.bookingId, ...(input.metadata ?? {}) },
      }),
    });
    return {
      psp: 'bachs',
      checkoutId: json.checkout_id,
      checkoutUrl: json.checkout_url ?? null,
      reference: input.reference,
      status: 'open',
    };
  }

  async verifyByReference(reference: string): Promise<VerifiedPayment> {
    // Source of truth = webhooks (collection.succeeded) + GET payment; never client redirect.
    const json = await bachsFetch(`/v1/payments?reference=${encodeURIComponent(reference)}`, { method: 'GET' });
    const p = json.items?.[0] ?? json.data?.[0] ?? json;
    return this.toVerified(p, reference);
  }

  async verifyByChargeId(chargeId: string): Promise<VerifiedPayment> {
    const json = await bachsFetch(`/v1/payments/${encodeURIComponent(chargeId)}`, { method: 'GET' });
    return this.toVerified(json, json.reference ?? chargeId);
  }

  private toVerified(p: any, fallbackRef: string): VerifiedPayment {
    const status = String(p.status ?? '').toUpperCase();
    return {
      psp: 'bachs',
      chargeId: p.charge_id ?? p.id ?? fallbackRef,
      reference: p.reference ?? fallbackRef,
      amountKobo: bachsDecimalToKobo(String(p.amount ?? '0.00')),
      currency: 'NGN',
      status: status === 'SUCCEEDED' || status === 'SUCCESS' ? 'successful' : status === 'FAILED' ? 'failed' : 'pending',
    };
  }

  async refund(input: RefundInput): Promise<{ refundId: string; status: string }> {
    // POST /v1/refunds { charge_id, reference (unique), amount? decimal } — one refund per charge.
    // https://docs.bachs.io/guides/refunds
    const body: Record<string, string> = { charge_id: input.chargeId, reference: input.reference };
    if (input.amountKobo !== undefined) body.amount = koboToBachsDecimal(input.amountKobo);
    if (input.reason) body.reason = input.reason;
    const json = await bachsFetch('/v1/refunds', {
      method: 'POST',
      idempotencyKey: input.idempotencyKey,
      body: JSON.stringify(body),
    });
    return { refundId: json.refund_id, status: json.status };
  }

  async createPayout(input: PayoutInput): Promise<{ payoutId: string; status: string }> {
    // Withdrawals are async: POST /v1/payouts { destination, amount decimal, reference }.
    // Track via payout.paid / payout.failed webhooks or GET /v1/payouts/{id}.
    // https://docs.bachs.io/connect/withdrawals
    const json = await bachsFetch('/v1/payouts', {
      method: 'POST',
      idempotencyKey: input.idempotencyKey,
      headers: { 'X-Account-Id': process.env.BACHS_ACCOUNT_ID ?? '' },
      body: JSON.stringify({
        destination: input.destinationId,
        amount: koboToBachsDecimal(input.amountKobo),
        currency: 'NGN',
        reference: input.reference,
      }),
    });
    return { payoutId: json.id, status: json.status };
  }

  async createVirtualAccount(input: { userId: string; email: string; name: string }) {
    const json = await bachsFetch('/v1/virtual-accounts', {
      method: 'POST',
      body: JSON.stringify({
        customer: { email: input.email, name: input.name },
        reference: 'va_' + input.userId,
      }),
    });
    return {
      accountName: json.account_name,
      accountNumber: json.account_number,
      bankName: json.bank_name,
    };
  }

  async verifyBankAccount(input: { accountNumber: string; bankCode: string }) {
    // Documented endpoint: POST /v1/misc/bank-accounts/resolve.
    // (The previous GET /v1/resolve-account path was never in the Bachs API —
    // every call 404'd, which is why payout onboarding never resolved names.)
    try {
      const json = await bachsFetch('/v1/misc/bank-accounts/resolve', {
        method: 'POST',
        body: JSON.stringify({ account_number: input.accountNumber, bank_code: input.bankCode }),
      });
      const name = json.account_name ?? json.data?.account_name ?? json.accountName;
      return { accountName: name ?? '', valid: Boolean(name) };
    } catch {
      return { accountName: '', valid: false };
    }
  }

  /** Supported payout banks for a country (reference data; cache upstream). */
  async listBanks(country = 'NG'): Promise<{ name: string; code: string }[]> {
    const json = await bachsFetch(`/v1/reference/banks?country=${encodeURIComponent(country)}`, { method: 'GET' });
    const banks = json.banks ?? json.items ?? json.data ?? [];
    return (Array.isArray(banks) ? banks : [])
      .map((b: { name?: string; code?: string }) => ({ name: String(b.name ?? ''), code: String(b.code ?? '') }))
      .filter((b: { name: string; code: string }) => b.name && b.code);
  }

  verifyWebhookSignature(rawBody: Buffer | string, headers: Record<string, string | string[] | undefined>): boolean {
    // X-Bachs-Signature over "{timestamp}.{rawBody}", tolerance 300s.
    try {
      const sig = String(headers['x-bachs-signature'] ?? '');
      const ts = String(headers['x-bachs-timestamp'] ?? headers['timestamp'] ?? '');
      if (!sig || !ts || !WEBHOOK_SECRET) return false;
      if (Math.abs(Date.now() / 1000 - parseInt(ts, 10)) > 300) return false;
      const raw = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf-8');
      const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${raw}`).digest('hex');
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
    } catch {
      return false;
    }
  }
}
