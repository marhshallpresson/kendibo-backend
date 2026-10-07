// PaymentPort — every PSP behind this interface. No business module imports an SDK.
// Primary: BachsAdapter. Fallback: FlutterwaveAdapter. Paystack is NOT supported.
import type { Kobo } from './money.js';

export type PSP = 'bachs' | 'flutterwave';

export interface CreateCheckoutInput {
  bookingId: string;
  amountKobo: Kobo;
  currency?: 'NGN';
  customerEmail: string;
  customerName?: string;
  reference: string; // our idempotency reference, max 128 chars
  metadata?: Record<string, string>;
  idempotencyKey: string;
}

export interface CheckoutSession {
  psp: PSP;
  checkoutId: string;
  checkoutUrl: string | null; // Bachs hosted URL; Flutterwave Standard link
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
  verifyByReference(reference: string): Promise<VerifiedPayment>;
  verifyByChargeId(chargeId: string): Promise<VerifiedPayment>;
  refund(input: RefundInput): Promise<{ refundId: string; status: string }>;
  createPayout(input: PayoutInput): Promise<{ payoutId: string; status: string }>;
  verifyWebhookSignature(rawBody: Buffer | string, headers: Record<string, string | string[] | undefined>): boolean;
}
