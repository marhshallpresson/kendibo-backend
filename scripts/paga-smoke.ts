// Paga sandbox smoke test. Talks to Paga only; touches no database.
// Run on the server (Paga only accepts whitelisted IPs: 203.0.113.10):
//   GOMAXPROCS=1 node --env-file=.env --import tsx scripts/paga-smoke.ts [step]
// steps: keys | banks | pay | status <reference> | account | all (default: all but status)
// Prints references, account numbers and Paga status codes. Never prints keys.
import { PagaClient, PagaError, pagaConfig, pagaConfigured } from '../modules/payments/paga/client.js';
import { PagaAdapter } from '../modules/payments/paga.adapter.js';

const cfg = pagaConfig();
const step = process.argv[2] ?? 'all';
const out = (label: string, v: unknown) => console.log(`${label.padEnd(22)} ${typeof v === 'string' ? v : JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))}`);

function explain(e: unknown) {
  if (e instanceof PagaError) {
    const hint: Record<string, string> = {
      UNAUTHORIZED: 'keys rejected: check PAGA_PUBLIC_KEY / PAGA_SECRET_KEY are the SANDBOX (test) keys',
      IP_NOT_WHITELISTED: 'Paga refused this server IP: whitelist 203.0.113.10 for the sandbox in the Paga portal',
      BAD_REQUEST: 'request refused: usually the hash (check PAGA_HASH_KEY) or a field Paga did not accept',
      TIMEOUT: 'no answer from Paga in time',
      NOT_CONFIGURED: 'keys missing in .env',
    };
    out('  FAILED', `${e.code}${e.status ? ` (HTTP ${e.status})` : ''}: ${hint[e.code] ?? e.message}`);
    if (e.data) out('  Paga said', e.data);
  } else out('  FAILED', (e as Error).message);
}

async function main() {
  out('environment', cfg.env);
  out('keys present', { publicKey: !!cfg.publicKey, secretKey: !!cfg.secretKey, hashKey: !!cfg.hashKey });
  out('PAGA_MODE', process.env.PAGA_MODE ?? '(unset = off)');
  if (!pagaConfigured(cfg)) { console.log('\nAdd PAGA_PUBLIC_KEY, PAGA_SECRET_KEY and PAGA_HASH_KEY first.'); process.exitCode = 1; return; }
  if (step === 'keys') return;
  const paga = new PagaAdapter();
  const client = new PagaClient();
  let failed = false;

  if (step === 'all' || step === 'banks') {
    console.log('\n1) Business API: bank list');
    try { const banks = await paga.listBanks(); out('  banks', `${banks.length} (e.g. ${banks.slice(0, 3).map((b) => b.name).join(', ')})`); }
    catch (e) { explain(e); failed = true; }
  }

  if (step === 'all' || step === 'pay') {
    console.log('\n2) Collect API: initiate a ₦100 bank-transfer payment request');
    const reference = `smoke${Date.now()}`;
    try {
      const s = await paga.createCheckout({
        bookingId: 'smoke-test', amountKobo: 10000n, reference, idempotencyKey: reference,
        customerName: 'Kendibo Smoke Test', customerEmail: 'smoke-test@kendibo.ng', metadata: { phone: '08000000000' },
      });
      out('  reference', reference);
      out('  pay to', s.details ?? s);
      console.log(`  Next: pay it in the sandbox simulator (https://qa-developer-portal.paga.com/simulate/inbound-bank-deposit),\n  then run: scripts/paga-smoke.ts status ${reference}`);
    } catch (e) { explain(e); failed = true; }
  }

  if (step === 'status') {
    const reference = process.argv[3];
    if (!reference) { console.log('usage: paga-smoke.ts status <reference>'); return; }
    console.log(`\nStatus of ${reference}`);
    try { out('  result', await paga.verifyByReference(reference)); } catch (e) { explain(e); failed = true; }
  }

  if (step === 'all' || step === 'account') {
    console.log('\n3) Subsidiary Accounts: create a test customer account number, then read its balance');
    const ref = `ks${Date.now()}`;
    const accountReference = `kdsmoke${Date.now()}`;
    try {
      const r = await client.collectRest('POST', '/subsidiary-accounts', {
        referenceNumber: ref, accountReference, accountName: 'Kendibo Smoke Test', firstName: 'Smoke', lastName: 'Test',
        email: 'smoke-test@kendibo.ng', phoneNumber: '08012345678',
        fundingTransactionLimit: 500000, fundingDailyLimit: 2000000, status: 'ACTIVE', // sandbox requires the limits
      }, [ref, accountReference, '', '', '', '', '']);
      out('  create', { statusCode: r?.statusCode, statusMessage: r?.statusMessage, accountNumber: r?.accountNumber, accountReference });
      const b = `kb${Date.now()}`;
      const bal = await client.collectRest('GET', `/subsidiary-accounts/${accountReference}/balance?referenceNumber=${b}`, undefined, [b, accountReference]);
      out('  balance', { statusCode: bal?.statusCode, balance: bal?.balance, currency: bal?.currency });
      if (r?.accountNumber) console.log('  Fund it with the inbound bank deposit simulator to test the funding callback (needs the server callback URL set in the Paga portal).');
    } catch (e) { explain(e); failed = true; }
  }

  console.log(failed ? '\nSome checks failed (see above).' : '\nAll requested checks passed.');
  if (failed) process.exitCode = 1;
}

main().catch((e) => { explain(e); process.exitCode = 1; });
