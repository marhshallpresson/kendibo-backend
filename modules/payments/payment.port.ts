// PaymentPort — every PSP behind this interface. No business module imports an SDK.
// Paga is the only PSP. Historical rows written by a retired card PSP carry
// psp='legacy_card' and are only ever read, never created.
import type { Kobo } from './money.js';

export type PSP = 'paga';

/** What a checkout pays for. Decided by the server from our own records, never by the client. */
export type CheckoutPurpose = 'booking' | 'topup' | 'tier' | 'subscription';

export interface CreateCheckoutInput {
  bookingId: string;
  amountKobo: Kobo;
  currency?: 'NGN';
  customerEmail?: string;
  customerName?: string;
  reference: string; // minted by PaymentService (kb_<purpose>_<hash>), max 128 chars
  metadata?: Record<string, string>;
  idempotencyKey: string;
  /** Paying user, stored on the payment row; settlement always credits this user. */
  userId?: string;
}

export interface CheckoutSession {
  psp: PSP;
  checkoutId: string;
  checkoutUrl: string | null; // our signed pay page (Paga bank transfer)
  reference: string;
  status: 'open' | 'pending';
  /** PSP payment instructions to keep with the payment row (e.g. Paga account number). */
  details?: Record<string, unknown>;
}

export interface VerifiedPayment {
  psp: PSP;
  chargeId: string;
  reference: string;
  /** Amount of the payment request (what we asked for, not what was received). */
  amountKobo: Kobo;
  currency: 'NGN';
  /**
   * successful = paid; partial = Paga reports a partial payment (code 2);
   * failed = terminal and unpaid (expired / cancelled); pending = anything else, including unknown codes.
   */
  status: 'successful' | 'partial' | 'failed' | 'pending';
  /** Raw Paga status code, for diagnostics. */
  code: string;
}

export interface RefundInput {
  chargeId: string;
  reference: string;
  amountKobo?: Kobo; // omit = full refund
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
