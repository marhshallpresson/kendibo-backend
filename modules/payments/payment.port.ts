// PaymentPort — every PSP behind this interface. No business module imports an SDK.
// Single PSP: BachsAdapter (Flutterwave removed Oct 2026). Paystack is NOT supported.
import type { Kobo } from './money.js';

export type PSP = 'bachs';

export interface CreateCheckoutInput {
  bookingId: string;
  amountKobo: Kobo;
  currency?: 'NGN';
  customerEmail?: string;
  customerName?: string;
  reference: string; // our idempotency reference, max 128 chars
  metadata?: Record<string, string>;
  idempotencyKey: string;
}

export interface CheckoutSession {
  psp: PSP;
  checkoutId: string;
  checkoutUrl: string | null; // Bachs hosted checkout URL
  reference: string;
  status: 'open' | 'pending';
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
