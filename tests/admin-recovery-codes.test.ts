// Admin 2FA recovery codes: issued on enrolment, accepted once at the login
// 2FA step, regenerated behind a current authenticator code.
import 'dotenv/config';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { q } from '../packages/database/db.js';
import { issueOtp, signAccess } from '../packages/auth/auth.js';
import { totpCode } from '../modules/identity/admin-security.service.js';

process.env.NODE_ENV = 'test';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: { inject: (opts: any) => Promise<any>; close?: () => Promise<void> };
before(async () => {
  process.env.DATABASE_URL = '';
  process.env.REDIS_URL = '';
  ({ app } = await import('../apps/api/src/main.js'));
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
});
after(async () => { await app?.close?.().catch(() => {}); });

const UA = 'admin-recovery-test/1.0';
const bearer = (token: string) => ({ authorization: `Bearer ${token}`, 'user-agent': UA });
const auth = (sub: string) => bearer(signAccess(sub, []));
const CODE_RE = /^[abcdefghjkmnpqrstuvwxyz23456789]{4}-[abcdefghjkmnpqrstuvwxyz23456789]{4}$/;

async function admin(role = 'SUPER_ADMIN') {
  const email = `${role.toLowerCase()}-${randomUUID()}@kendibo.local`;
  const id = String((await q<{ id: string }>(`INSERT INTO identity.users (email, role, name) VALUES ($1,$2,'Recovery Test') RETURNING id`, [email, role]))[0].id);
  return { id, email };
}
async function otpLogin(email: string) {
  const { code } = await issueOtp('email', email);
  return app.inject({ method: 'POST', url: '/v1/auth/otp/verify', headers: { 'user-agent': UA }, payload: { channel: 'email', identity: email, code } });
}
async function loginWith(email: string, code: string) {
  const first = await otpLogin(email);
  const ch = first.json().data;
  assert.equal(ch.twoFactorRequired, true, first.body);
  return app.inject({ method: 'POST', url: '/v1/admin/login/2fa', headers: { 'user-agent': UA }, payload: { challengeId: ch.challengeId, code } });
}
/** Enrols and verifies 2FA; returns the secret and the one-time recovery codes. */
async function enrolled(a: { id: string }) {
  const en = await app.inject({ method: 'POST', url: '/v1/admin/2fa/enroll', headers: auth(a.id) });
  const { secret } = en.json().data;
  const ok = await app.inject({ method: 'POST', url: '/v1/admin/2fa/verify', headers: auth(a.id), payload: { code: totpCode(secret) } });
  assert.equal(ok.statusCode, 200, ok.body);
  return { secret, codes: ok.json().data.recoveryCodes as string[] };
}

describe('admin 2FA recovery codes', () => {
  it('enrolment returns ten codes once; only sha256 hashes are stored', async () => {
    const a = await admin();
    const { codes } = await enrolled(a);
    assert.equal(codes.length, 10);
    assert.equal(new Set(codes).size, 10, 'codes are distinct');
    for (const c of codes) assert.match(c, CODE_RE);

    const rows = await q<{ code_hash: string; used_at: unknown }>(`SELECT code_hash, used_at FROM identity.admin_recovery_code WHERE user_id=$1`, [a.id]);
    assert.equal(rows.length, 10);
    const stored = new Set(rows.map((r) => r.code_hash));
    for (const c of codes) {
      assert.ok(!stored.has(c), 'plaintext not stored');
      assert.ok(stored.has(createHash('sha256').update(c.replace('-', '')).digest('hex')), 'sha256 of the normalized code is stored');
    }
    assert.ok(rows.every((r) => r.used_at == null), 'all unused');

    const status = await app.inject({ method: 'GET', url: '/v1/admin/2fa/status', headers: auth(a.id) });
    assert.equal(status.json().data.recoveryCodesRemaining, 10);
    const again = await app.inject({ method: 'GET', url: '/v1/admin/2fa/status', headers: auth(a.id) });
    assert.ok(!JSON.stringify(again.json()).includes(codes[0]), 'status never returns codes');
  });

  it('a recovery code signs in once; reuse is rejected and the use is audited', async () => {
    const a = await admin();
    const { codes } = await enrolled(a);
    // Typed loosely: upper case and no hyphen still match the stored code.
    const typed = codes[0].replace('-', '').toUpperCase();
    const good = await loginWith(a.email, typed);
    assert.equal(good.statusCode, 200, good.body);
    const s = good.json().data;
    assert.ok(s.access && s.refresh);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/admin/users', headers: bearer(s.access) })).statusCode, 200, 'session passed 2FA');

    const reused = await loginWith(a.email, codes[0]);
    assert.equal(reused.statusCode, 401);
    assert.equal(reused.json().error.code, 'BAD_TWO_FACTOR_CODE');

    const other = await loginWith(a.email, codes[1]);
    assert.equal(other.statusCode, 200, 'another unused code still works');

    const audit = await q<{ action: string; ip: string | null; user_agent: string | null }>(
      `SELECT action, ip, user_agent FROM audit.log WHERE actor=$1 AND action='admin.2fa.recovery_used'`, [a.id]);
    assert.equal(audit.length, 2, 'one audit row per recovery login');
    assert.ok(audit.every((r) => r.user_agent === UA));
    const left = (await app.inject({ method: 'GET', url: '/v1/admin/2fa/status', headers: bearer(s.access) })).json().data.recoveryCodesRemaining;
    assert.equal(left, 8);
  });

  it('regenerate needs a current authenticator code and invalidates the old set', async () => {
    const a = await admin();
    const { secret, codes: oldCodes } = await enrolled(a);

    const wrong = await app.inject({ method: 'POST', url: '/v1/admin/2fa/recovery-codes/regenerate', headers: auth(a.id), payload: { code: '000000' } });
    assert.equal(wrong.statusCode, 400);
    assert.equal(wrong.json().error.code, 'BAD_TWO_FACTOR_CODE');

    // The enrolment spent the current 30 s step; the next step is a fresh code.
    const re = await app.inject({ method: 'POST', url: '/v1/admin/2fa/recovery-codes/regenerate', headers: auth(a.id), payload: { code: totpCode(secret, Date.now() + 30_000) } });
    assert.equal(re.statusCode, 200, re.body);
    const newCodes = re.json().data.recoveryCodes as string[];
    assert.equal(newCodes.length, 10);
    assert.ok(newCodes.every((c) => !oldCodes.includes(c)));

    const rows = await q<{ n: string | number }>(`SELECT COUNT(*) AS n FROM identity.admin_recovery_code WHERE user_id=$1`, [a.id]);
    assert.equal(Number(rows[0].n), 10, 'old rows deleted');

    const old = await loginWith(a.email, oldCodes[0]);
    assert.equal(old.statusCode, 401, 'old code no longer works');
    const fresh = await loginWith(a.email, newCodes[0]);
    assert.equal(fresh.statusCode, 200, fresh.body);

    const audit = await q<{ action: string }>(`SELECT action FROM audit.log WHERE actor=$1 AND action='admin.2fa.recovery_regenerate'`, [a.id]);
    assert.equal(audit.length, 1);
  });

  it('regenerate is refused when 2FA is not on', async () => {
    const a = await admin();
    const r = await app.inject({ method: 'POST', url: '/v1/admin/2fa/recovery-codes/regenerate', headers: auth(a.id), payload: { code: '123456' } });
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().error.code, 'TWO_FACTOR_NOT_ENABLED');
  });
});
