import 'dotenv/config';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { identityService } from '../modules/identity/identity.service.js';
import { issueOtp, signAccess } from '../packages/auth/auth.js';
import { q } from '../packages/database/db.js';

let app: { inject: (opts: unknown) => Promise<{ statusCode: number; json: () => { data: any } }>; close?: () => Promise<void> };
before(async () => {
  // Isolate BEFORE main.js import (main loads dotenv + touches DB at import):
  // force test so main never listens on :3000, neutralize URLs to '' so
  // dotenv cannot restore the live URL and openPeriod uses pg-mem.
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = '';
  process.env.REDIS_URL = '';
  ({ app } = await import('../apps/api/src/main.js'));
  // main.js loads dotenv (.env holds the LIVE url) — scrub AFTER import so
  // tests always run against isolated pg-mem, never production data.
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
});
after(async () => {
  await app?.close?.().catch(() => {});
});

const auth = (sub: string) => ({ authorization: `Bearer ${signAccess(sub, [])}` });

async function realUser(email: string) {
  const rows = await q(`INSERT INTO identity.users (email) VALUES ($1) RETURNING id`, [email]);
  return String(rows[0].id);
}

describe('unified login (account check + device history)', () => {
  it('account-exists detects email and normalises phone', async () => {
    const email = `login-${randomUUID()}@kendibo.local`;
    const u = await realUser(email);
    const yes = await identityService.accountExists(email);
    assert.equal(yes.exists, true);
    assert.equal(yes.channel, 'email');
    const no = await identityService.accountExists(`nobody-${randomUUID()}@kendibo.local`);
    assert.equal(no.exists, false);
    const phoneUser = `09${String(Math.floor(100000000 + Math.random() * 899999999))}`;
    await q(`INSERT INTO identity.users (phone) VALUES ($1)`, [`+234${phoneUser.slice(1)}`]);
    const p = await identityService.accountExists(phoneUser);
    assert.equal(p.exists, true);
    assert.equal(p.channel, 'phone');
    void u;
  });

  it('device log upserts per fingerprint', async () => {
    const u = await realUser(`dev-${randomUUID()}@kendibo.local`);
    await identityService.logDevice(u, { fp: 'fp1', platform: 'android', model: 'Pixel 8', os: 'Android 14' });
    await identityService.logDevice(u, { fp: 'fp1', platform: 'android', model: 'Pixel 8', os: 'Android 14' });
    const rows = await q(`SELECT count(*) c FROM identity.device_session WHERE user_id=$1`, [u]);
    assert.equal(Number(rows[0].c), 1);
  });

  it('POST /v1/auth/account-exists route shape', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/auth/account-exists', payload: { identity: 'nope@kendibo.local' } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().data.exists, false);
    const bad = await app.inject({ method: 'POST', url: '/v1/auth/account-exists', payload: { identity: 'not-an-identity!!!' } });
    assert.equal(bad.statusCode, 400);
  });

  it('POST /v1/auth/google rejects junk tokens without network truth', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/auth/google', payload: { idToken: 'junk' } });
    assert.ok([401, 502].includes(r.statusCode));
  });

  it('OTP verify with role=provider persists role and creates provider row', async () => {
    const email = `prov-${randomUUID()}@kendibo.local`;
    const { code } = await issueOtp('email', email);
    const ver = await app.inject({
      method: 'POST', url: '/v1/auth/otp/verify',
      payload: { channel: 'email', identity: email, code, name: 'Provider One', role: 'provider' },
    });
    assert.equal(ver.statusCode, 200);
    const session = ver.json().data;
    // Roles are echoed uppercase to match ROLE_PERMS/ADMIN_ROLES keys (consumers
    // normalize case themselves, so this is the one canonical casing).
    assert.equal(session.user.role, 'PROVIDER');
    assert.equal(session.user.name, 'Provider One');
    const me = await identityService.me(session.user.id);
    assert.equal(me?.role, 'PROVIDER');
    const prov = await q(`SELECT id FROM provider.provider WHERE user_id=$1`, [session.user.id]);
    assert.equal(prov.length, 1);
  });
});

describe('POST /v1/auth/role (post-signup role pick)', () => {
  it('rejects unauthenticated requests', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/auth/role', payload: { role: 'provider' } });
    assert.equal(r.statusCode, 401);
  });

  it('rejects invalid role values', async () => {
    const u = await realUser(`role-${randomUUID()}@kendibo.local`);
    const r = await app.inject({ method: 'POST', url: '/v1/auth/role', payload: { role: 'admin' } , headers: auth(u) });
    assert.equal(r.statusCode, 400);
  });

  it('upgrades CUSTOMER → PROVIDER and reports uppercase role', async () => {
    const u = await realUser(`role-${randomUUID()}@kendibo.local`);
    const before = await q<{ role: string }>(`SELECT role FROM identity.users WHERE id=$1`, [u]);
    assert.equal(String(before[0]?.role), 'CUSTOMER');
    const r = await app.inject({ method: 'POST', url: '/v1/auth/role', payload: { role: 'provider' }, headers: auth(u) });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().data.role, 'PROVIDER');
    const after = await q<{ role: string }>(`SELECT role FROM identity.users WHERE id=$1`, [u]);
    assert.equal(String(after[0]?.role), 'PROVIDER');
  });

  it('keeps CUSTOMER on repeat customer choice (no-op)', async () => {
    const u = await realUser(`role-${randomUUID()}@kendibo.local`);
    const r = await app.inject({ method: 'POST', url: '/v1/auth/role', payload: { role: 'customer' }, headers: auth(u) });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().data.role, 'CUSTOMER');
    const after = await q<{ role: string }>(`SELECT role FROM identity.users WHERE id=$1`, [u]);
    assert.equal(String(after[0]?.role), 'CUSTOMER');
  });

  it('rejects PROVIDER → CUSTOMER with ROLE_IMMUTABLE', async () => {
    const u = await realUser(`role-${randomUUID()}@kendibo.local`);
    await q(`UPDATE identity.users SET role='PROVIDER' WHERE id=$1`, [u]);
    const r = await app.inject({ method: 'POST', url: '/v1/auth/role', payload: { role: 'customer' }, headers: auth(u) });
    assert.equal(r.statusCode, 403);
    const after = await q<{ role: string }>(`SELECT role FROM identity.users WHERE id=$1`, [u]);
    assert.equal(String(after[0]?.role), 'PROVIDER');
  });
});
