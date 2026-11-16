// Customers verify with NIN or BVN only (no selfie, no face match, no liveness);
// providers keep the Prembly NIN-with-face match and the liveness check.
// No real network: every Prembly call is answered here and its URL recorded.
import 'dotenv/config';
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { q } from '../packages/database/db.js';
import { signAccess } from '../packages/auth/auth.js';

process.env.NODE_ENV = 'test';

type InjectRes = { statusCode: number; json: () => any; body: string };
let app: { inject: (opts: any) => Promise<InjectRes>; close?: () => Promise<void> };
let K: any; let N: any;
const originalFetch = globalThis.fetch;
const ENV_KEYS = ['NODE_ENV', 'KYC_PROVIDER', 'PREMBLY_SECRET_KEY', 'PREMBLY_API_KEY', 'PREMBLY_BASE_URL'] as const;
let savedEnv = new Map<string, string | undefined>();
const calls: string[] = [];
const notices: { recipientId: string; template: string }[] = [];
let originalOmni: unknown;

before(async () => {
  process.env.DATABASE_URL = '';
  process.env.REDIS_URL = '';
  ({ app } = await import('../apps/api/src/main.js'));
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
  K = await import('../modules/kyc/kyc.service.js');
  N = await import('../modules/notifications/notification.service.js');
  originalOmni = N.notificationService.sendOmnichannel;
  N.notificationService.sendOmnichannel = async (o: { recipientId: string; template: string }) => {
    notices.push({ recipientId: o.recipientId, template: o.template });
    return { ok: true };
  };
});
after(async () => {
  globalThis.fetch = originalFetch;
  N.notificationService.sendOmnichannel = originalOmni;
  await app?.close?.().catch(() => {});
});
beforeEach(() => {
  calls.length = 0; notices.length = 0;
  savedEnv = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of savedEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const auth = (sub: string) => ({ authorization: `Bearer ${signAccess(sub, [])}` });
async function user(name = 'Ada Okon') {
  return String((await q<{ id: string }>(`INSERT INTO identity.users (email, role, name) VALUES ($1,'CUSTOMER',$2) RETURNING id`,
    [`customer-${randomUUID()}@kendibo.local`, name]))[0].id);
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ok = (extra: Record<string, unknown> = {}) => json(200, {
  status: true, response_code: '00', verification: { status: 'VERIFIED', reference: 'ref1' },
  nin_data: { firstname: 'Ada', surname: 'Okon' }, data: { firstname: 'Ada', surname: 'Okon' }, ...extra,
});

/** Production with a fake Prembly key; `respond` answers each call by URL. */
function prembly(respond: (url: string) => Response) {
  process.env.NODE_ENV = 'production';
  process.env.KYC_PROVIDER = 'prembly';
  process.env.PREMBLY_SECRET_KEY = 'unit-test-secret';
  process.env.PREMBLY_BASE_URL = 'https://prembly.test';
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    assert.ok(url.startsWith('https://prembly.test/'), `unexpected fetch ${url}`);
    calls.push(url);
    return respond(url);
  }) as typeof fetch;
}
const faceCalls = () => calls.filter((u) => /face|liveliness|liveness/i.test(u));

describe('customer KYC: NIN or BVN only', () => {
  it('a NIN verifies the customer without any face or liveness call, even if a selfie is sent', async () => {
    const uid = await user();
    prembly(() => ok());
    const res = await app.inject({
      method: 'POST', url: '/v1/user/kyc', headers: auth(uid),
      payload: { nin: '12345678901', selfieBase64: 'data:image/jpeg;base64,AAAAAAAAAAAA' },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().data.status, 'VERIFIED');
    assert.equal(res.json().data.faceVerified, false);
    assert.deepEqual(faceCalls(), [], `no face checks for customers: ${calls.join(', ')}`);
    assert.ok(calls.some((u) => u.endsWith('/verification/vnin')), calls.join(', '));
  });

  it('a selfie document from an older app is ignored and never stored', async () => {
    const uid = await user();
    prembly(() => ok());
    const res = await app.inject({
      method: 'POST', url: '/v1/user/kyc', headers: auth(uid),
      payload: { bvn: '22345678901', documents: [{ assetId: randomUUID(), kind: 'selfie' }] },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(faceCalls(), []);
    const docs = await q(`SELECT 1 FROM kyc.customer_document WHERE user_id=$1`, [uid]);
    assert.equal(docs.length, 0);
  });

  it('a customer is told when they become verified (auto and by an admin)', async () => {
    const uid = await user();
    prembly(() => ok());
    await app.inject({ method: 'POST', url: '/v1/user/kyc', headers: auth(uid), payload: { nin: '12345678901' } });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(notices.filter((n) => n.recipientId === uid).map((n) => n.template), ['user.kyc_verified'], 'existing auto-verify notice, not doubled');

    // Manual review → admin approval also notifies.
    const pending = await user('Bola Ade');
    prembly(() => json(503, { status: false, detail: 'down' }));
    const sub = await app.inject({ method: 'POST', url: '/v1/user/kyc', headers: auth(pending), payload: { nin: '12345678901' } });
    assert.equal(sub.json().data.status, 'UNDER_REVIEW');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(notices.filter((n) => n.recipientId === pending), [], 'nothing is sent to the customer on submission');
    await K.kycService.userApprove(pending, randomUUID());
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(notices.filter((n) => n.recipientId === pending).map((n) => n.template), ['kyc.user.verified']);
    const after = await app.inject({ method: 'GET', url: '/v1/user/kyc', headers: auth(pending) });
    assert.equal(after.json().data.status, 'VERIFIED');
  });

  it('an admin rejection tells the customer', async () => {
    const uid = await user('Tolu Bamidele');
    prembly(() => json(503, { status: false, detail: 'down' }));
    await app.inject({ method: 'POST', url: '/v1/user/kyc', headers: auth(uid), payload: { nin: '12345678901' } });
    await K.kycService.userReject(uid, 'Blurry details', randomUUID());
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(notices.filter((n) => n.recipientId === uid).map((n) => n.template), ['kyc.user.rejected']);
  });
});

describe('customer KYC: full name and date of birth', () => {
  const withDob = (dob: string) => () => ok({ nin_data: { firstname: 'Ada', surname: 'Okon', birthdate: dob }, data: { firstname: 'Ada', surname: 'Okon', birthdate: dob } });

  it('a matching name and date of birth verify straight away', async () => {
    const uid = await user('Someone Else');
    prembly(withDob('12-03-1990'));
    const res = await app.inject({
      method: 'POST', url: '/v1/user/kyc', headers: auth(uid),
      payload: { nin: '30000000001', fullName: 'Ada Okon', dateOfBirth: '1990-03-12' },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().data.status, 'VERIFIED', 'the typed full name is used, not the profile name');
  });

  it('a date of birth that does not match goes to a person, with a clear reason', async () => {
    const uid = await user('Ada Okon');
    prembly(withDob('1990-03-12'));
    const res = await app.inject({
      method: 'POST', url: '/v1/user/kyc', headers: auth(uid),
      payload: { nin: '30000000002', fullName: 'Ada Okon', dateOfBirth: '1991-01-01' },
    });
    assert.equal(res.json().data.status, 'UNDER_REVIEW');
    assert.match(String(res.json().data.rejectionReason), /Date of birth/, res.body);
  });

  it('rejects a badly formatted date of birth', async () => {
    const uid = await user();
    prembly(() => ok());
    const res = await app.inject({ method: 'POST', url: '/v1/user/kyc', headers: auth(uid), payload: { nin: '12345678901', dateOfBirth: '12/03/1990' } });
    assert.equal(res.statusCode, 400);
  });

  it('normalizes the common date formats', () => {
    for (const v of ['1990-03-12', '12-03-1990', '12/03/1990', '1990-03-12T00:00:00.000Z']) assert.equal(K.normalizeDob(v), '1990-03-12', v);
    assert.equal(K.normalizeDob(''), undefined);
  });
});

describe('provider KYC: Prembly face match and liveness', () => {
  it('a provider selfie goes through NIN-with-face and the liveness check', async () => {
    prembly(() => ok({ confidence: 92 }));
    const out = await K.kycService.runTierChecks('provider', randomUUID(), {
      nin: '12345678901', selfieBase64: 'data:image/jpeg;base64,AAAAAAAAAAAA', submittedName: 'Ada Okon',
    });
    assert.ok(calls.some((u) => u.includes('/verification/nin_w_face')), calls.join(', '));
    assert.ok(calls.some((u) => u.includes('face-liveliness')), calls.join(', '));
    assert.equal(out.faceVerified, true);
    assert.equal(out.tierReached >= 2, true);
  });

  it('a liveness outage is saved for manual review, not failed', async () => {
    prembly((u) => (u.includes('face-liveliness') ? json(503, { status: false, detail: 'down' }) : ok({ confidence: 92 })));
    const out = await K.kycService.runTierChecks('provider', randomUUID(), {
      nin: '12345678901', selfieBase64: 'data:image/jpeg;base64,AAAAAAAAAAAA', submittedName: 'Ada Okon',
    });
    assert.equal(out.tierReached, 1);
    assert.ok(out.unavailableReason, 'outage recorded so the application goes to manual review');
  });
});
