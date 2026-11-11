// PagaAdapter — PaymentPort on Paga (https://developer-docs.paga.com).
// Collections use Collect "payment requests" paid by bank transfer: Paga issues
// a one-off account number per payment, and those payments are refundable
// through Collect /refund/v2 (Checkout card refunds are not documented, so
// Checkout is not the default). Payouts and bank checks use the Business API.
// Webhook != truth: a callback only triggers a server-side /status check.
import type { PaymentPort, CreateCheckoutInput, CheckoutSession, VerifiedPayment, RefundInput, PayoutInput } from './payment.port.js';
import { PagaClient, PagaError, koboToNaira, koboToNairaString, nairaToKobo, sameHash } from './paga/client.js';

/** Where the customer sees the account number and amount (our page, signed link). */
export type PayPageUrl = (reference: string) => string;

export interface PagaPaymentDetails {
  accountNumber: string | null;
  bankName: string | null;
  amountToPayKobo: string;
  expiresAt: string | null;
}

/** Paga's payment status codes (Collect): 0 paid, 1 in process, 2 partial, negatives/114+ failed or expired. */
function statusFrom(code: string | number | undefined): VerifiedPayment['status'] {
  const c = String(code ?? '');
  if (c === '0') return 'successful';
  if (c === '1' || c === '2' || c === '') return 'pending';
  return 'failed';
}

const callbackUrl = () =>
  `${(process.env.PUBLIC_API_URL || process.env.WHATSAPP_WEB_BASE_URL || 'https://api.kendibo.ng').replace(/\/+$/, '')}/webhooks/payments/paga`;
const transferCallbackUrl = () =>
  `${(process.env.PUBLIC_API_URL || process.env.WHATSAPP_WEB_BASE_URL || 'https://api.kendibo.ng').replace(/\/+$/, '')}/webhooks/paga/transfer`;

export class PagaAdapter implements PaymentPort {
  readonly name = 'paga' as const;
  constructor(private client = new PagaClient(), private payPageUrl: PayPageUrl = () => '') {}

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
    const amount = koboToNaira(input.amountKobo);
    const currency = input.currency ?? 'NGN';
    const phone = (input.metadata?.phone ?? '').replace(/\D/g, '') || '08000000000';
    const email = input.customerEmail ?? '';
    const expiry = new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 19);
    const json = await this.client.collect('/paymentRequest', {
      referenceNumber: input.reference,
      amount,
      currency,
      payer: { name: input.customerName || 'Kendibo customer', phoneNumber: phone, ...(email ? { email } : {}) },
      payee: { name: 'Kendibo' },
      expiryDateTimeUTC: expiry,
      isSuppressMessages: true,
      // Kendibo absorbs Paga's collection fee: the customer pays exactly the quoted price.
      payerCollectionFeeShare: 0,
      payeeCollectionFeeShare: 1,
      isAllowPartialPayments: false,
      isAllowOverPayments: false,
      callBackUrl: callbackUrl(),
      paymentMethods: ['BANK_TRANSFER'],
    }, [input.reference, amount, currency, phone, email]);
    if (String(json.statusCode) !== '0') throw new PagaError(`REQUEST_${json.statusCode}`, String(json.statusMessage ?? 'payment request refused'), undefined, json);
    const transfer = (json.paymentMethods ?? []).find((m: any) => m?.properties?.AccountNumber || m?.properties?.accountNumber) ?? {};
    const details: PagaPaymentDetails = {
      accountNumber: transfer.properties?.AccountNumber ?? transfer.properties?.accountNumber ?? null,
      bankName: transfer.properties?.bankName ?? json.bankName ?? null,
      amountToPayKobo: String(nairaToKobo(json.totalPaymentAmount ?? amount)),
      expiresAt: json.expiryDateTimeUTC ?? expiry,
    };
    return { psp: 'paga', checkoutId: input.reference, checkoutUrl: this.payPageUrl(input.reference) || null, reference: input.reference, status: 'open', details: { ...details } };
  }

  async getCheckout(checkoutId: string, reference: string): Promise<CheckoutSession> {
    const v = await this.verifyByReference(reference || checkoutId);
    return { psp: 'paga', checkoutId, checkoutUrl: this.payPageUrl(reference) || null, reference, status: v.status === 'pending' ? 'open' : 'pending' };
  }

  async verifyByReference(reference: string): Promise<VerifiedPayment> {
    const json = await this.client.collect('/status', { referenceNumber: reference }, [reference]);
    if (String(json.statusCode) !== '0') {
      if (String(json.statusCode) === '121' || String(json.data?.statusCode) === '121') throw new PagaError('404', 'payment request not found');
      throw new PagaError(`STATUS_${json.statusCode}`, String(json.statusMessage ?? 'status query failed'), undefined, json);
    }
    const d = json.data ?? {};
    return {
      psp: 'paga',
      chargeId: reference,
      reference: String(d.referenceNumber ?? reference),
      // requestAmount is what we asked for; the customer's fee share is 0, so it equals what they paid.
      amountKobo: nairaToKobo(d.requestAmount ?? 0),
      currency: 'NGN',
      status: statusFrom(d.statusCode),
    };
  }

  verifyByChargeId(chargeId: string): Promise<VerifiedPayment> {
    return this.verifyByReference(chargeId); // Paga charges are identified by our reference
  }

  async refund(input: RefundInput): Promise<{ refundId: string; status: string }> {
    let amountKobo = input.amountKobo;
    if (amountKobo === undefined) amountKobo = (await this.verifyByReference(input.chargeId)).amountKobo;
    const refundAmount = koboToNaira(amountKobo);
    const json = await this.client.collect('/refund/v2', {
      referenceNumber: input.reference,
      paymentRequestReference: input.chargeId,
      refundAmount,
      currency: 'NGN',
      ...(input.reason ? { reason: input.reason.slice(0, 140) } : {}),
    }, [input.reference, refundAmount]);
    const code = String(json.statusCode);
    if (code === '102') return { refundId: input.reference, status: 'duplicate' }; // same refund reference already used
    if (code !== '0') throw new PagaError(`REFUND_${code}`, String(json.statusMessage ?? 'refund refused'), undefined, json);
    return { refundId: String(json.referenceNumber ?? input.reference), status: 'requested' };
  }

  /** destinationId = "<bank uuid>:<account number>" from getBanks + validateDepositToBank. */
  async createPayout(input: PayoutInput): Promise<{ payoutId: string; status: string }> {
    const [bankUuid, accountNumber] = String(input.destinationId).split(':');
    if (!bankUuid || !/^\d{10}$/.test(accountNumber ?? '')) throw new PagaError('BAD_DESTINATION', 'destination must be "<bankUUID>:<10-digit account>"');
    const amount = koboToNairaString(input.amountKobo);
    const json = await this.client.business('depositToBank', {
      referenceNumber: input.reference,
      amount,
      currency: 'NGN',
      destinationBankUUID: bankUuid,
      destinationBankAccountNumber: accountNumber,
      statusCallbackUrl: transferCallbackUrl(),
      ...(input.narration ? { remarks: input.narration.slice(0, 100) } : {}),
    }, [input.reference, amount, bankUuid, accountNumber]);
    const code = Number(json.responseCode);
    if (code === 0) return { payoutId: String(json.transactionId ?? input.reference), status: 'processing' };
    // Pending or unknown outcome: never retry with a new reference; reconcile on the callback or status.
    if (code === 3 || code === -1 || code === 105 || code === 135) return { payoutId: String(json.transactionId ?? input.reference), status: 'pending' };
    if (code === 139) throw new PagaError('INSUFFICIENT_BALANCE', 'Paga business balance is too low for this payout', undefined, json);
    throw new PagaError(`PAYOUT_${code}`, String(json.message ?? 'payout refused'), undefined, json);
  }

  async createVirtualAccount(): Promise<{ accountName: string; accountNumber: string; bankName: string }> {
    throw new PagaError('UNSUPPORTED', 'permanent customer accounts are not enabled for Paga yet');
  }

  async verifyBankAccount(input: { accountNumber: string; bankCode: string }): Promise<{ accountName: string; valid: boolean }> {
    const reference = `vb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const amount = '100.00';
    try {
      const json = await this.client.business('validateDepositToBank', {
        referenceNumber: reference, amount, currency: 'NGN',
        destinationBankUUID: input.bankCode, destinationBankAccountNumber: input.accountNumber,
      }, [reference, amount, input.bankCode, input.accountNumber]);
      const ok = Number(json.responseCode) === 0 && Boolean(json.destinationAccountHolderNameAtBank);
      return { accountName: ok ? String(json.destinationAccountHolderNameAtBank) : '', valid: ok };
    } catch (e) {
      if (e instanceof PagaError && e.code === 'BAD_REQUEST') return { accountName: '', valid: false };
      throw e;
    }
  }

  async listBanks(): Promise<{ name: string; code: string }[]> {
    const reference = `bk_${Date.now()}`;
    const json = await this.client.business('getBanks', { referenceNumber: reference }, [reference]);
    if (Number(json.responseCode) !== 0) throw new PagaError(`BANKS_${json.responseCode}`, String(json.message ?? 'banks unavailable'));
    return (json.banks ?? []).map((b: any) => ({ name: String(b.name), code: String(b.uuid) }));
  }

  /**
   * Collect payment callback: the hash is in the body,
   * notificationId + statusCode + externalReferenceNumber + state + outstandingBalance + hashKey,
   * with outstandingBalance to two decimals and left out when null.
   */
  verifyWebhookSignature(rawBody: Buffer | string): boolean {
    let e: any;
    try { e = JSON.parse(String(rawBody)); } catch { return false; }
    if (!e?.hash || !e?.notificationId) return false;
    const balance = e.outstandingBalance === null || e.outstandingBalance === undefined ? '' : Number(e.outstandingBalance).toFixed(2);
    const expected = this.client.hash([e.notificationId, e.statusCode, e.externalReferenceNumber, e.state, balance]);
    return sameHash(expected, String(e.hash));
  }

  /** Business money-transfer notification: x-paga-hash over referenceNumber + transactionDate + transactionId + amount + sessionId. */
  verifyTransferNotification(rawBody: Buffer | string, headers: Record<string, string | string[] | undefined>): boolean {
    const given = String(headers['x-paga-hash'] ?? '');
    if (!given) return false;
    let e: any;
    try { e = JSON.parse(String(rawBody)); } catch { return false; }
    const expected = this.client.hash([e.referenceNumber, e.transactionDate, e.transactionId, e.amount, e.sessionId]);
    return sameHash(expected, given);
  }
}
