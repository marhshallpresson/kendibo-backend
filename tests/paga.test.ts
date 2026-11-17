// Paga integration (sandbox): hashing per endpoint, adapter mapping, routing
// (test accounts only), callbacks, refunds and payouts. Paga's HTTP is stubbed.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto, { randomUUID } from 'node:crypto';
import { PagaClient, pagaHash, koboToNairaString, nairaToKobo, type PagaConfig } from '../modules/payments/paga/client.js';
import { PagaAdapter } from '../modules/payments/paga.adapter.js';
import { PaymentService } from '../modules/payments/payment.service.js';
import type { PaymentPort } from '../modules/payments/payment.port.js';
import { q } from '../packages/database/db.js';

const CFG: PagaConfig = { env: 'sandbox', publicKey: 'pub_test', secretKey: 'sec_test', hashKey: 'hash_test', timeoutMs: 2000 };
const sha512 = (s: string) => crypto.createHash('sha512').update(s).digest('hex');

type Call = { url: string; headers: Record<string, string>; body: any };
function stubFetch(responder: (call: Call) => { status?: number; json: unknown }) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const call = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
    calls.push(call);
    const r = responder(call);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('Paga hashing and money helpers', () => {
  it('hash = SHA-512 of values in order with the hash key last, lowercase hex', () => {
    assert.equal(pagaHash(['ref1', 5000, 'NGN', '0803', ''], 'hk'), sha512('ref15000NGN0803hk'));
    assert.match(pagaHash(['x'], 'k'), /^[0-9a-f]{128}$/);
  });
  it('converts kobo for Paga bodies without float drift', () => {
    assert.equal(koboToNairaString(1250050n), '12500.50');
    assert.equal(koboToNairaString(5n), '0.05');
    assert.equal(nairaToKobo('5000.0'), 500000n);
    assert.equal(nairaToKobo(19.99), 1999n);
  });
});

describe('PagaClient auth per product', () => {
  it('Collect uses Basic + hash header on the sandbox host', async () => {
    const { f, calls } = stubFetch(() => ({ json: { statusCode: '0' } }));
    await new PagaClient(CFG, f).collect('/status', { referenceNumber: 'r1' }, ['r1']);
    assert.equal(calls[0].url, 'https://beta-collect.paga.com/status');
    assert.equal(calls[0].headers.Authorization, `Basic ${Buffer.from('pub_test:sec_test').toString('base64')}`);
    assert.equal(calls[0].headers.hash, sha512('r1hash_test'));
    // Node fetch would send "Accept-Language: *", which Paga Collect answers with "system error".
    assert.equal(calls[0].headers['Accept-Language'], 'en');
  });
  it('Business uses principal/credentials/hash on the business-rest path', async () => {
    const { f, calls } = stubFetch(() => ({ json: { responseCode: 0, banks: [] } }));
    await new PagaClient(CFG, f).business('getBanks', { referenceNumber: 'b1' }, ['b1']);
    assert.equal(calls[0].url, 'https://beta.mypaga.com/paga-webservices/business-rest/secured/getBanks');
    assert.equal(calls[0].headers.principal, 'pub_test');
    assert.equal(calls[0].headers.credentials, 'sec_test');
    assert.equal(calls[0].headers.hash, sha512('b1hash_test'));
  });
  it('live hosts only when PAGA_ENV=live', async () => {
    const { f, calls } = stubFetch(() => ({ json: { statusCode: '0' } }));
    await new PagaClient({ ...CFG, env: 'live' }, f).collect('/status', { referenceNumber: 'r' }, ['r']);
    assert.equal(calls[0].url, 'https://collect.paga.com/status');
  });
  it('maps 403 to IP_NOT_WHITELISTED and refuses without keys', async () => {
    const { f } = stubFetch(() => ({ status: 403, json: {} }));
    await assert.rejects(() => new PagaClient(CFG, f).collect('/status', {}, ['r']), /PAGA_IP_NOT_WHITELISTED/);
    await assert.rejects(() => new PagaClient({ ...CFG, hashKey: '' }, f).collect('/status', {}, ['r']), /PAGA_NOT_CONFIGURED/);
  });
});

describe('PagaAdapter', () => {
  it('creates a bank-transfer payment request with the documented hash and returns pay details', async () => {
    const { f, calls } = stubFetch(() => ({ json: {
      referenceNumber: 'bk_1', statusCode: '0', totalPaymentAmount: 15000, expiryDateTimeUTC: '2026-11-12T10:00:00',
      paymentMethods: [{ name: 'BANK_TRANSFER', properties: { bankName: 'Paga', AccountNumber: '3080242757' } }],
    } }));
    const s = await new PagaAdapter(new PagaClient(CFG, f)).createCheckout({
      bookingId: 'b', amountKobo: 1500000n, reference: 'bk_1', customerEmail: 'ada@example.com', customerName: 'Ada', idempotencyKey: 'i', metadata: { phone: '+234 803 000 0000' },
    });
    const body = calls[0].body;
    assert.equal(calls[0].url, 'https://beta-collect.paga.com/paymentRequest');
    assert.equal(body.amount, 15000);
    assert.deepEqual(body.paymentMethods, ['BANK_TRANSFER']);
    assert.equal(body.payerCollectionFeeShare + body.payeeCollectionFeeShare, 1);
    assert.equal(calls[0].headers.hash, sha512('bk_115000NGN08030000000ada@example.comhash_test'));
    assert.equal(s.psp, 'paga');
    assert.equal(s.checkoutId, 'bk_1');
    assert.equal(s.details?.accountNumber, '3080242757');
    assert.equal(s.details?.amountToPayKobo, '1500000');
  });

  it('status maps Paga codes; requestAmount becomes kobo', async () => {
    const status = (code: string) => stubFetch(() => ({ json: { statusCode: '0', data: { referenceNumber: 'r', statusCode: code, requestAmount: 15000 } } }));
    const paid = await new PagaAdapter(new PagaClient(CFG, status('0').f)).verifyByReference('r');
    assert.equal(paid.status, 'successful'); assert.equal(paid.amountKobo, 1500000n);
    assert.equal((await new PagaAdapter(new PagaClient(CFG, status('1').f)).verifyByReference('r')).status, 'pending');
    assert.equal((await new PagaAdapter(new PagaClient(CFG, status('-2').f)).verifyByReference('r')).status, 'failed');
    const notFound = stubFetch(() => ({ json: { statusCode: '121', statusMessage: 'NOT FOUND' } }));
    await assert.rejects(() => new PagaAdapter(new PagaClient(CFG, notFound.f)).verifyByReference('r'), /404/);
  });

  it('refund uses /refund/v2 with referenceNumber + refundAmount hash; duplicate reference is not an error', async () => {
    const { f, calls } = stubFetch(() => ({ json: { statusCode: '0', referenceNumber: 'rf_1' } }));
    const r = await new PagaAdapter(new PagaClient(CFG, f)).refund({ chargeId: 'bk_1', reference: 'rf_1', amountKobo: 500000n, idempotencyKey: 'rf_1' });
    assert.equal(calls[0].url, 'https://beta-collect.paga.com/refund/v2');
    assert.equal(calls[0].body.paymentRequestReference, 'bk_1');
    assert.equal(calls[0].headers.hash, sha512('rf_15000hash_test'));
    assert.equal(r.status, 'requested');
    const dup = stubFetch(() => ({ json: { statusCode: '102' } }));
    assert.equal((await new PagaAdapter(new PagaClient(CFG, dup.f)).refund({ chargeId: 'bk_1', reference: 'rf_1', amountKobo: 1n, idempotencyKey: 'x' })).status, 'duplicate');
  });

  it('payout uses depositToBank; pending/unknown outcomes are not retried with a new reference; low balance is explicit', async () => {
    const ok = stubFetch(() => ({ json: { responseCode: 0, transactionId: 'T1' } }));
    const r = await new PagaAdapter(new PagaClient(CFG, ok.f)).createPayout({ destinationId: 'BANK-UUID:0123456789', amountKobo: 1677500n, reference: 'po_1', idempotencyKey: 'po_1' });
    assert.equal(ok.calls[0].body.amount, '16775.00');
    assert.equal(ok.calls[0].headers.hash, sha512('po_116775.00BANK-UUID0123456789hash_test'));
    assert.match(ok.calls[0].body.statusCallbackUrl, /\/webhooks\/paga\/subsidiary$/); // Paga has one callback URL
    assert.equal(r.status, 'processing');
    for (const code of [3, -1, 135]) {
      const p = stubFetch(() => ({ json: { responseCode: code } }));
      assert.equal((await new PagaAdapter(new PagaClient(CFG, p.f)).createPayout({ destinationId: 'B:0123456789', amountKobo: 100n, reference: 'po_2', idempotencyKey: 'x' })).status, 'pending');
    }
    const low = stubFetch(() => ({ json: { responseCode: 139 } }));
    await assert.rejects(() => new PagaAdapter(new PagaClient(CFG, low.f)).createPayout({ destinationId: 'B:0123456789', amountKobo: 100n, reference: 'po_3', idempotencyKey: 'x' }), /INSUFFICIENT_BALANCE/);
    await assert.rejects(() => new PagaAdapter(new PagaClient(CFG, ok.f)).createPayout({ destinationId: 'nope', amountKobo: 100n, reference: 'po_4', idempotencyKey: 'x' }), /BAD_DESTINATION/);
  });

  it('verifies the Collect callback hash (outstandingBalance 2dp; left out when null) and rejects tampering', () => {
    const a = new PagaAdapter(new PagaClient(CFG, stubFetch(() => ({ json: {} })).f));
    const cb = { notificationId: 'n1', statusCode: '0', externalReferenceNumber: 'bk_1', state: 'CONSUMED', outstandingBalance: null as number | null };
    const good = { ...cb, hash: sha512('n10bk_1CONSUMEDhash_test') };
    assert.equal(a.verifyWebhookSignature(JSON.stringify(good)), true);
    assert.equal(a.verifyWebhookSignature(JSON.stringify({ ...good, externalReferenceNumber: 'bk_2' })), false);
    const withBal = { ...cb, outstandingBalance: 50, hash: sha512('n10bk_1CONSUMED50.00hash_test') };
    assert.equal(a.verifyWebhookSignature(JSON.stringify(withBal)), true);
    assert.equal(a.verifyWebhookSignature('not json'), false);
  });

  it('verifies the money-transfer notification x-paga-hash', () => {
    const a = new PagaAdapter(new PagaClient(CFG, stubFetch(() => ({ json: {} })).f));
    const e = { referenceNumber: 'po_1', transactionDate: '2026-11-03 11:02:25.56', transactionId: 'T1', amount: '5000.0', sessionId: 'S1' };
    const h = sha512('po_12026-11-03 11:02:25.56T15000.0S1hash_test');
    assert.equal(a.verifyTransferNotification(JSON.stringify(e), { 'x-paga-hash': h }), true);
    assert.equal(a.verifyTransferNotification(JSON.stringify({ ...e, amount: '9000.0' }), { 'x-paga-hash': h }), false);
    assert.equal(a.verifyTransferNotification(JSON.stringify(e), {}), false);
  });
});

describe('checkout is always Paga', () => {
  const before0 = process.env.PAGA_MODE;
  before(() => { process.env.DATABASE_URL = ''; });
  after(() => { if (before0 === undefined) delete process.env.PAGA_MODE; else process.env.PAGA_MODE = before0; });

  it('every purpose goes to Paga whatever PAGA_MODE says, with the owner stored on our row', async () => {
    const seen: string[] = [];
    const fake = {
      name: 'paga',
      createCheckout: async (input: { reference: string }) => { seen.push(input.reference); return { psp: 'paga', checkoutId: input.reference, checkoutUrl: 'https://pay.test/x', reference: input.reference, status: 'open' }; },
    } as unknown as PaymentPort;
    const svc = new PaymentService({ paga: fake });
    const user = String((await q<{ id: string }>(`INSERT INTO identity.users (email, name) VALUES ($1,'Ada') RETURNING id`, [`c-${randomUUID()}@kendibo.local`]))[0].id);
    for (const mode of ['off', 'test-accounts', 'all']) {
      process.env.PAGA_MODE = mode;
      const s = await svc.createCheckout({ bookingId: 'wallet_topup', purpose: 'topup', amountKobo: 500000n, idempotencyKey: `k-${mode}`, userId: user });
      assert.equal(s.psp, 'paga');
      assert.match(s.reference, /^kb_w_[0-9a-f]{24}$/);
    }
    assert.equal(new Set(seen).size, 3);
    const row = (await q<{ psp: string; user_id: string }>(`SELECT psp, user_id FROM payment.payment WHERE reference=$1`, [seen[0]]))[0];
    assert.equal(row.psp, 'paga');
    assert.equal(row.user_id, user);
  });

  it('passes the real payer name and phone to Paga', async () => {
    let got: { customerName?: string; metadata?: Record<string, string> } = {};
    const fake = {
      name: 'paga',
      createCheckout: async (input: { reference: string; customerName?: string; metadata?: Record<string, string> }) => { got = input; return { psp: 'paga', checkoutId: input.reference, checkoutUrl: 'https://pay.test/x', reference: input.reference, status: 'open' }; },
    } as unknown as PaymentPort;
    const user = String((await q<{ id: string }>(`INSERT INTO identity.users (email, name, phone) VALUES ($1,'Ada Obi','+2348031112222') RETURNING id`, [`c-${randomUUID()}@kendibo.local`]))[0].id);
    await new PaymentService({ paga: fake }).createCheckout({ bookingId: 'wallet_topup', purpose: 'topup', amountKobo: 100000n, idempotencyKey: 'k-name', userId: user });
    assert.equal(got.customerName, 'Ada Obi');
    assert.equal(got.metadata?.phone, '+2348031112222');
  });

  it('the payment request allows partial and over payments and stays open for 48h by default', async () => {
    const { f, calls } = stubFetch(() => ({ json: { referenceNumber: 'kb_w_1', statusCode: '0', totalPaymentAmount: 10, paymentMethods: [{ name: 'BANK_TRANSFER', properties: { bankName: 'Paga', AccountNumber: '1' } }] } }));
    delete process.env.PAGA_PAYMENT_EXPIRY_HOURS;
    await new PagaAdapter(new PagaClient(CFG, f)).createCheckout({ bookingId: 'b', amountKobo: 1000n, reference: 'kb_w_1', idempotencyKey: 'i' });
    assert.equal(calls[0].body.isAllowPartialPayments, true);
    assert.equal(calls[0].body.isAllowOverPayments, true);
    const hours = (Date.parse(`${calls[0].body.expiryDateTimeUTC}Z`) - Date.now()) / 3600_000;
    assert.ok(hours > 47.9 && hours <= 48.01, String(hours));
  });
});
