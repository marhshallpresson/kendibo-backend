// PaymentPort — every PSP behind this interface. No business module imports an SDK.
// PSPs: BachsAdapter (live today) and PagaAdapter (sandbox, test accounts only until
// Paga live approval). Flutterwave removed Oct 2026. Paystack is NOT supported.
import type { Kobo } from './money.js';

export type PSP = 'bachs' | 'paga';

export interface CreateCheckoutInput {
  bookingId: string;
  amountKobo: Kobo;
  currency?: 'NGN';
  customerEmail?: string;
  customerName?: string;
  reference: string; // our idempotency reference, max 128 chars
  metadata?: Record<string, string>;
  idempotencyKey: string;
  /** Paying user, stored on the payment row (wallet top-ups credit this user). */
  userId?: string;
}

export interface CheckoutSession {
  psp: PSP;
  checkoutId: string;
  checkoutUrl: string | null; // hosted checkout (Bachs) or our pay page (Paga bank transfer)
  reference: string;
  status: 'open' | 'pending';
  /** PSP payment instructions to keep with the payment row (e.g. Paga account number). */
  details?: Record<string, unknown>;
}

export interface VerifiedPayment {
  psp: PSP;
  chargeId: string;
  reference: string;
  amountKobo: Kobo;
  currency: 'NGN';
  status: 'successful' | 'failed' | 'pending';
}

export interface RefundInput {
  chargeId: string;
  reference: string;
  amountKobo?: Kobo; // omit = full refund (Bachs: one refund per charge)
  reason?: string;
  idempotencyKey: string;
}

export interface PayoutInput {
  destinationId: string; // pre-registered + verified destination
  amountKobo: Kobo;
  reference: string;
  narration?: string;
  idempotencyKey: string;
}

export interface PaymentPort {
  readonly name: PSP;
  createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession>;
  getCheckout?(checkoutId: string, reference: string): Promise<CheckoutSession>;
  verifyByReference(reference: string): Promise<VerifiedPayment>;
  verifyByChargeId(chargeId: string): Promise<VerifiedPayment>;
  refund(input: RefundInput): Promise<{ refundId: string; status: string }>;
  createPayout(input: PayoutInput): Promise<{ payoutId: string; status: string }>;
  createVirtualAccount(input: { userId: string; email: string; name: string }): Promise<{ accountName: string; accountNumber: string; bankName: string }>;
  verifyBankAccount(input: { accountNumber: string; bankCode: string }): Promise<{ accountName: string; valid: boolean }>;
  /** Optional PSP reference data: supported payout banks for a country. */
  listBanks?(country: string): Promise<{ name: string; code: string }[]>;
  verifyWebhookSignature(rawBody: Buffer | string, headers: Record<string, string | string[] | undefined>): boolean;
}
