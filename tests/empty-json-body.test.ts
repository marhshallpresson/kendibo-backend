// Regression: POST /v1/provider/onboarding with `Content-Type: application/json`
// and no body failed 16/16 times in production with 400 "Body cannot be empty",
// so provider onboarding could never start.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { q } from '../packages/database/db.js';
import { signAccess } from '../packages/auth/auth.js';

process.env.NODE_ENV = 'test';
type Res = { statusCode: number; json: () => any; body: string };
let app: { inject: (opts: unknown) => Promise<Res>; close?: () => Promise<void> };
before(async () => {
  process.env.DATABASE_URL = '';
  process.env.REDIS_URL = '';
  ({ app } = await import('../apps/api/src/main.js'));
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
});
after(async () => { await app?.close?.().catch(() => {}); });

describe('body-less JSON POSTs', () => {
  it('starts provider onboarding when the app sends JSON content-type with no body', async () => {
    const uid = String((await q<{ id: string }>(`INSERT INTO identity.users (email, name) VALUES ($1,'Uduak Pro') RETURNING id`, [`p-${randomUUID()}@kendibo.local`]))[0].id);
    const res = await app.inject({
      method: 'POST', url: '/v1/provider/onboarding',
      headers: { authorization: `Bearer ${signAccess(uid, [])}`, 'content-type': 'application/json', 'content-length': '0' },
    });
    assert.notEqual(res.statusCode, 400, res.body);
    assert.equal(res.statusCode, 200, res.body);
  });

  it('saves onboarding after every step, never keeps NIN/BVN, and resumes where the pro stopped', async () => {
    const uid = String((await q<{ id: string }>(`INSERT INTO identity.users (email, name) VALUES ($1,'Aniekan Fixes') RETURNING id`, [`p-${randomUUID()}@kendibo.local`]))[0].id);
    const auth = { authorization: `Bearer ${signAccess(uid, [])}` };
    const fresh = await app.inject({ method: 'GET', url: '/v1/provider/onboarding/progress', headers: auth });
    assert.equal(fresh.json().data.started, false);
    assert.equal(fresh.json().data.step, 'account');

    const s1 = await app.inject({ method: 'PUT', url: '/v1/provider/onboarding/progress', headers: auth, payload: { step: 'account', accountType: 'individual', data: { kind: 'individual' } } });
    assert.equal(s1.statusCode, 200, s1.body);
    assert.equal(s1.json().data.step, 'details', 'moves on to the next step');

    const s2 = await app.inject({ method: 'PUT', url: '/v1/provider/onboarding/progress', headers: auth, payload: { step: 'details', data: { fullName: 'Aniekan Etim', phone: '08030000000', nin: '12345678901', bvn: '22222222222' } } });
    assert.equal(s2.statusCode, 200, s2.body);
    const draft = s2.json().data.draft;
    assert.equal(draft.details.fullName, 'Aniekan Etim');
    assert.equal(draft.details.nin, undefined, 'NIN never stored in the draft');
    assert.equal(draft.details.bvn, undefined, 'BVN never stored in the draft');

    // Going back to edit step 1 keeps the furthest step reached.
    const back = await app.inject({ method: 'PUT', url: '/v1/provider/onboarding/progress', headers: auth, payload: { step: 'account', accountType: 'business', data: { kind: 'business' } } });
    assert.equal(back.json().data.step, 'services');
    assert.equal(back.json().data.accountType, 'business');
    assert.equal(back.json().data.draft.details.fullName, 'Aniekan Etim', 'earlier answers kept');

    const resumed = await app.inject({ method: 'GET', url: '/v1/provider/onboarding/progress', headers: auth });
    assert.equal(resumed.json().data.started, true);
    assert.equal(resumed.json().data.step, 'services');

    const bad = await app.inject({ method: 'PUT', url: '/v1/provider/onboarding/progress', headers: auth, payload: { step: 'nope', data: {} } });
    assert.equal(bad.statusCode, 400);
    const anon = await app.inject({ method: 'GET', url: '/v1/provider/onboarding/progress' });
    assert.equal(anon.statusCode, 401);
  });

  it('still rejects malformed JSON', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/provider/onboarding', headers: { 'content-type': 'application/json' }, payload: '{bad' });
    assert.equal(res.statusCode, 400);
  });
});
