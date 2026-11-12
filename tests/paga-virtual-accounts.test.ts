// Customer account numbers on Paga Subsidiary Accounts: who gets one, funding
// (confirmed before any wallet credit), paying from the wallet, rotation.
// Paga's HTTP is stubbed; the database is the in-memory test database.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import crypto, { randomUUID } from 'node:crypto';
import { PagaClient, type PagaConfig } from '../modules/payments/paga/client.js';
import {
  setVirtualAccountClient, ensureVirtualAccount, accountView, handleSubsidiaryNotification, reconfirmPending,
  chargeForWalletPayment, rotate, fundingsFor, adminList, verifyFundingHash, installVirtualAccountHooks, liveAccount, VaError,
} from '../modules/payments/paga/virtual-accounts.js';
import { walletService } from '../modules/wallet/wallet.service.js';
import { emit, onEmit } from '../packages/observability/emit.js';
import { q } from '../packages/database/db.js';

const HK = 'hash_test';
const CFG: PagaConfig = { env: 'sandbox', publicKey: 'pub_test', secretKey: 'sec_test', hashKey: HK, timeoutMs: 2000 };
const sha512 = (s: string) => crypto.createHash('sha512').update(s).digest('hex');

type Call = { method: string; url: string; headers: Record<string, string>; body: any };
const calls: Call[] = [];
let responder: (c: Call) => { status?: number; json: unknown } = () => ({ json: { statusCode: '0' } });
const fakeFetch = (async (url: string, init: RequestInit) => {
  const c: Call = { method: String(init.method ?? 'POST'), url, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined };
  calls.push(c);
  const r = responder(c);
  return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
}) as unknown as typeof fetch;

/** A small fake of Paga's sub-account ledger. */
const paga = { n: 0, balances: new Map<string, number>(), numbers: new Map<string, string>(), history: new Map<string, any[]>(), disabled: new Set<string>(), seenRefs: new Set<string>() };
function pagaFake(c: Call) {
  const path = new URL(c.url).pathname;
  if (c.method === 'POST' && path === '/subsidiary-accounts') {
    const num = `07${String(++paga.n).padStart(8, '0')}`;
    paga.numbers.set(c.body.accountReference, num); paga.balances.set(c.body.accountReference, 0);
    return { json: { statusCode: '0', statusMessage: 'success', accountNumber: num, accountReference: c.body.accountReference, status: 'ACTIVE', balance: 0.0, currency: 'NGN' } };
  }
  let m = path.match(/^\/subsidiary-accounts\/([^/]+)\/balance$/);
  if (m) return { json: { statusCode: '0', balance: paga.balances.get(decodeURIComponent(m[1])) ?? 0, currency: 'NGN' } };
  m = path.match(/^\/subsidiary-accounts\/([^/]+)\/history$/);
  if (m) { const items = paga.history.get(decodeURIComponent(m[1])) ?? []; return { json: { statusCode: '0', itemCount: items.length, transactions: items } }; }
  m = path.match(/^\/subsidiary-accounts\/([^/]+)\/charge$/);
  if (m) {
    const ref = decodeURIComponent(m[1]);
    if (!paga.seenRefs.has(c.body.referenceNumber)) { paga.seenRefs.add(c.body.referenceNumber); paga.balances.set(ref, (paga.balances.get(ref) ?? 0) - c.body.amount); }
    return { json: { statusCode: '0', transactionId: `tx_${c.body.referenceNumber}`, newBalance: paga.balances.get(ref) } };
  }
  if (c.method === 'POST' && path === '/subsidiary-accounts/transfer') {
    if (!paga.seenRefs.has(c.body.referenceNumber)) {
      paga.seenRefs.add(c.body.referenceNumber);
      paga.balances.set(c.body.sourceAccountIdentifier, (paga.balances.get(c.body.sourceAccountIdentifier) ?? 0) - c.body.amount);
      paga.balances.set(c.body.destinationAccountIdentifier, (paga.balances.get(c.body.destinationAccountIdentifier) ?? 0) + c.body.amount);
    }
    return { json: { statusCode: '0', transactionId: 'tx' } };
  }
  m = path.match(/^\/subsidiary-accounts\/([^/]+)$/);
  if (m && c.method === 'PUT') { paga.disabled.add(decodeURIComponent(m[1])); return { json: { statusCode: '0', status: c.body.status } }; }
  return { status: 404, json: {} };
}

const envBefore = { ...process.env };
async function user(opts: { isTest?: boolean; kyc?: 'VERIFIED' | 'PENDING' | null; name?: string } = {}): Promise<string> {
  const id = String((await q<{ id: string }>(
    `INSERT INTO identity.users (email, phone, name, is_test) VALUES ($1,$2,$3,$4) RETURNING id`,
    [`va-${randomUUID()}@kendibo.local`, `23480${Math.floor(Math.random() * 1e8).toString().padStart(8, '0')}`, opts.name ?? 'Ada Obi', opts.isTest ?? true],
  ))[0].id);
  if (opts.kyc !== null) {
    await q(`INSERT INTO kyc.customer (user_id, status, tier, verified_legal_name) VALUES ($1,$2,1,$3)`, [id, opts.kyc ?? 'VERIFIED', 'ADA CHIOMA OBI']);
  }
  return id;
}

function fundingBody(accountNumber: string, fundingRef: string, amount = '"1,500.00"') {
  return `{"statusCode":"0","statusMessage":"success","transactionReference":"T${fundingRef}","fundingTransactionReference":"${fundingRef}","accountNumber":"${accountNumber}","accountName":"Kendibo Ada","amount":${amount},"transactionDate":"2026-11-12T10:00:00","timestamp":"2026-11-12T10:00:02","narration":"rent","payerDetails":{"paymentMethod":"BANK_TRANSFER","payerName":"JOHN DOE","payerBankName":"GTBank","payerBankAccountNumber":"0123456789"}}`;
}
function signedHeaders(raw: string) {
  const v = (n: string) => { const m = raw.match(new RegExp(`"${n}":("([^"]*)"|[0-9.]+)`)); return m ? (m[2] ?? m[1]) : ''; };
  return {
    'x-paga-hash-v3': sha512(`${v('transactionReference')}${v('transactionDate')}${v('amount')}${v('accountNumber')}${v('timestamp')}${HK}`),
    'x-paga-hash-v3-parameters': 'transactionReference,transactionDate,amount,accountNumber,timestamp',
  };
}

describe('Paga customer account numbers (Subsidiary Accounts)', () => {
  before(() => {
    process.env.DATABASE_URL = '';
    Object.assign(process.env, { PAGA_MODE: 'test-accounts', PAGA_PUBLIC_KEY: 'pub_test', PAGA_SECRET_KEY: 'sec_test', PAGA_HASH_KEY: HK, PAGA_ENV: 'sandbox' });
    setVirtualAccountClient(() => new PagaClient(CFG, fakeFetch));
  });
  after(() => {
    setVirtualAccountClient(null);
    for (const k of ['PAGA_MODE', 'PAGA_PUBLIC_KEY', 'PAGA_SECRET_KEY', 'PAGA_HASH_KEY', 'PAGA_ENV']) {
      if (envBefore[k] === undefined) delete process.env[k]; else process.env[k] = envBefore[k];
    }
  });
  beforeEach(() => { calls.length = 0; responder = pagaFake; });

  it('only KYC-verified test accounts get a number; nobody else reaches Paga', async () => {
    const real = await user({ isTest: false });
    const unverified = await user({ kyc: 'PENDING' });
    assert.deepEqual(await accountView(real), { status: 'not_available', reason: 'not_test_account' });
    assert.deepEqual(await accountView(unverified), { status: 'not_available', reason: 'kyc_not_verified' });
    const saved = process.env.PAGA_MODE; delete process.env.PAGA_MODE;
    assert.equal((await accountView(await user())).reason, 'disabled');
    process.env.PAGA_MODE = saved;
    assert.equal(calls.length, 0);
  });

  it('creates one sub-account with the documented hash and keeps it', async () => {
    const u = await user();
    const va = await ensureVirtualAccount(u);
    assert.equal(va?.status, 'active');
    assert.match(String(va?.account_number), /^07\d{8}$/);
    const create = calls.find((c) => c.url.endsWith('/subsidiary-accounts'))!;
    assert.equal(create.url, 'https://beta-collect.paga.com/subsidiary-accounts');
    assert.equal(create.body.firstName, 'ADA');
    assert.equal(create.body.lastName, 'CHIOMA OBI', 'legal name from KYC');
    assert.equal(create.body.autoSweep, undefined, 'ledger-backed: the money stays in the customer account');
    assert.equal(create.headers.hash, sha512(`${create.body.referenceNumber}${create.body.accountReference}${create.body.callbackUrl}${HK}`));
    assert.equal(create.body.callbackUrl, 'https://api.kendibo.ng/webhooks/paga/subsidiary');
    const again = await ensureVirtualAccount(u);
    assert.equal(again?.account_number, va?.account_number);
    assert.equal(calls.filter((c) => c.url.endsWith('/subsidiary-accounts')).length, 1);
    const view = await accountView(u);
    assert.equal(view.status, 'active'); assert.equal(view.accountNumber, va?.account_number); assert.equal(view.sandbox, true);
  });

  it('KYC approval hands out the number without blocking KYC', async () => {
    installVirtualAccountHooks(onEmit);
    const u = await user({ kyc: 'PENDING' });
    await q(`UPDATE kyc.customer SET status='VERIFIED' WHERE user_id=$1`, [u]);
    emit('kyc.user.approved', { userId: u, by: 'admin' });
    for (let i = 0; i < 50 && !(await liveAccount(u))?.account_number; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal((await liveAccount(u))?.status, 'active');
  });

  it('a signed funding credits the wallet once and records who paid', async () => {
    const u = await user();
    const va = (await ensureVirtualAccount(u))!;
    const raw = fundingBody(va.account_number!, `F${randomUUID().slice(0, 8)}`);
    assert.equal((await handleSubsidiaryNotification(raw, signedHeaders(raw))).handled, 'credited');
    assert.equal((await handleSubsidiaryNotification(raw, signedHeaders(raw))).handled, 'duplicate');
    assert.equal(await walletService.getBalance(u), 150000);
    const [f] = await fundingsFor(u);
    assert.equal(f.payerName, 'JOHN DOE'); assert.equal(f.payerBank, 'GTBank'); assert.equal(f.payerAccount, '******6789');
    assert.equal(f.status, 'credited'); assert.equal(f.amountKobo, '150000');
  });

  it('an unsigned notification credits nothing until Paga history shows the money', async () => {
    const u = await user();
    const va = (await ensureVirtualAccount(u))!;
    const raw = fundingBody(va.account_number!, `F${randomUUID().slice(0, 8)}`, '2500');
    assert.equal((await handleSubsidiaryNotification(raw, {})).handled, 'unconfirmed');
    assert.equal(await walletService.getBalance(u), 0);
    paga.history.set(va.account_reference, [{ transactionType: 'CREDIT', amount: 2500, transactionDate: '2026-11-12T10:00:00', status: 'SUCCESSFUL' }]);
    assert.equal(await reconfirmPending(u), 1);
    assert.equal(await walletService.getBalance(u), 250000);
    assert.equal(await reconfirmPending(u), 0, 'one history credit confirms one transfer, not two');
  });

  it('refuses a hash whose parameter list leaves out the amount or account', () => {
    const raw = fundingBody('0700000001', 'Fx');
    const h = signedHeaders(raw);
    assert.equal(verifyFundingHash(raw, h, HK), true);
    const forged = { 'x-paga-hash-v3': sha512(`T Fx${HK}`), 'x-paga-hash-v3-parameters': 'transactionReference' };
    assert.equal(verifyFundingHash(raw, forged, HK), false);
    assert.equal(verifyFundingHash(raw.replace('1,500.00', '9,500.00'), h, HK), false, 'tampered amount');
  });

  it('paying from the wallet charges the sub-account once, for what it holds', async () => {
    const u = await user();
    const va = (await ensureVirtualAccount(u))!;
    paga.balances.set(va.account_reference, 3000);
    const c1 = await chargeForWalletPayment(u, 'bw_test_1', 500000);
    assert.equal(c1?.amountKobo, 300000n, 'charges only what Paga holds');
    const charge = calls.find((c) => c.url.endsWith('/charge'))!;
    assert.equal(charge.headers.hash, sha512(`${charge.body.referenceNumber}3000NGNKendibo booking payment${HK}`));
    const c2 = await chargeForWalletPayment(u, 'bw_test_1', 500000);
    assert.equal(c2?.reference, c1?.reference);
    assert.equal(calls.filter((c) => c.url.endsWith('/charge')).length, 1, 'a replay does not charge again');
    assert.equal(paga.balances.get(va.account_reference), 0);
    assert.equal(await chargeForWalletPayment(await user({ isTest: false }), 'bw_x', 100), null, 'no account number: nothing to charge');
  });

  it('rotation: new number, balance moves, old number disabled, once per 24h; money sent to the old number still lands', async () => {
    const u = await user();
    const old = (await ensureVirtualAccount(u))!;
    paga.balances.set(old.account_reference, 1200);
    const fresh = await rotate(u);
    assert.notEqual(fresh.account_number, old.account_number);
    assert.equal(paga.balances.get(fresh.account_reference), 1200);
    assert.equal(paga.balances.get(old.account_reference), 0);
    assert.ok(paga.disabled.has(old.account_reference));
    const oldRow = (await q<{ status: string; live_user_id: string | null }>(`SELECT status, live_user_id FROM payment.virtual_account WHERE id=$1`, [old.id]))[0];
    assert.equal(oldRow.status, 'retired'); assert.equal(oldRow.live_user_id, null);
    assert.equal((await accountView(u)).accountNumber, fresh.account_number);
    await assert.rejects(rotate(u), (e: unknown) => e instanceof VaError && e.code === 'ROTATE_TOO_SOON');

    paga.balances.set(old.account_reference, 500); // someone used the old number
    const raw = fundingBody(old.account_number!, `F${randomUUID().slice(0, 8)}`, '"500.00"');
    assert.equal((await handleSubsidiaryNotification(raw, signedHeaders(raw))).handled, 'credited');
    assert.equal(await walletService.getBalance(u), 50000);
    assert.equal(paga.balances.get(fresh.account_reference), 1700, 'moved to the current number');
  });

  it('a failed create frees the slot so the next view can retry; rotation failure keeps the old number', async () => {
    const u = await user();
    responder = (c) => (c.url.endsWith('/subsidiary-accounts') ? { status: 400, json: { statusMessage: 'invalid hash' } } : pagaFake(c));
    assert.equal(await ensureVirtualAccount(u), null);
    responder = pagaFake;
    const va = (await ensureVirtualAccount(u))!;
    assert.equal(va.status, 'active');
    responder = (c) => (c.url.endsWith('/subsidiary-accounts') ? { status: 500, json: {} } : pagaFake(c));
    await assert.rejects(rotate(u), (e: unknown) => e instanceof VaError && e.code === 'PAGA_UNAVAILABLE');
    assert.equal((await liveAccount(u))?.account_number, va.account_number);
  });

  it('admin list shows who has paid in and who has not', async () => {
    const payer = await user(); const idle = await user();
    const va = (await ensureVirtualAccount(payer))!; await ensureVirtualAccount(idle);
    const raw = fundingBody(va.account_number!, `F${randomUUID().slice(0, 8)}`);
    await handleSubsidiaryNotification(raw, signedHeaders(raw));
    const funded = await adminList({ filter: 'funded', limit: 500 });
    const never = await adminList({ filter: 'never_funded', limit: 500 });
    assert.ok(funded.some((r) => r.userId === payer && r.fundedKobo === '150000'));
    assert.ok(never.some((r) => r.userId === idle));
    assert.ok(!never.some((r) => r.userId === payer));
  });
});
