// Admin console password sign-in: success, wrong password, non-admin, 2FA hand-off,
// lockout, and changing the password.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { q } from '../packages/database/db.js';
import { adminPassword, passwordProblem, hashPassword, checkPassword } from '../modules/identity/admin-password.js';

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

async function seat(role = 'SUPER_ADMIN') {
  const email = `adm-${randomUUID().slice(0, 8)}@kendibo.local`;
  const id = String((await q<{ id: string }>(`INSERT INTO identity.users (email, name, role) VALUES ($1,'Ops Admin',$2) RETURNING id`, [email, role]))[0].id);
  return { id, email };
}
const login = (email: string, password: string, ip = '10.0.0.1') =>
  app.inject({ method: 'POST', url: '/v1/admin/login/password', headers: { 'x-forwarded-for': ip }, payload: { email, password } });

describe('admin password sign-in', () => {
  it('hashes with scrypt and rejects weak passwords', async () => {
    const h = await hashPassword('correct horse 42');
    assert.match(h, /^scrypt\$/);
    assert.equal(await checkPassword('correct horse 42', h), true);
    assert.equal(await checkPassword('wrong horse 42', h), false);
    assert.ok(passwordProblem('short1'));
    assert.ok(passwordProblem('onlyletterslong'));
    assert.equal(passwordProblem('Kendibo-Console-2026'), null);
  });

  it('signs in with the right password; wrong password and non-admins get the same answer', async () => {
    const a = await seat();
    await adminPassword.set(a.id, 'Kendibo-Console-2026', true);
    const ok = await login(a.email, 'Kendibo-Console-2026');
    assert.equal(ok.statusCode, 200, ok.body);
    assert.ok(ok.json().data.access, 'session issued');
    assert.equal(ok.json().data.mustChangePassword, true);
    const bad = await login(a.email, 'nope-nope-1234', '10.0.0.2');
    assert.equal(bad.statusCode, 401);
    assert.equal(bad.json().error.code, 'BAD_CREDENTIALS');
    const cust = await seat('CUSTOMER');
    await q(`INSERT INTO identity.admin_credential (user_id, password_hash) VALUES ($1,$2)`, [cust.id, await hashPassword('Kendibo-Console-2026')]);
    assert.equal((await login(cust.email, 'Kendibo-Console-2026', '10.0.0.3')).json().error.code, 'BAD_CREDENTIALS', 'customers cannot use admin sign-in');
  });

  it('hands off to the authenticator step when 2FA is on', async () => {
    const a = await seat();
    await adminPassword.set(a.id, 'Kendibo-Console-2026');
    await q(`INSERT INTO identity.admin_2fa (user_id, secret_enc, enabled_at) VALUES ($1,'x',now())`, [a.id]);
    const r = await login(a.email, 'Kendibo-Console-2026', '10.0.0.4');
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().data.twoFactorRequired, true);
    assert.ok(r.json().data.challengeId);
    assert.equal(r.json().data.access, undefined, 'no tokens before the code');
  });

  it('locks the seat after repeated wrong passwords', async () => {
    const a = await seat();
    await adminPassword.set(a.id, 'Kendibo-Console-2026');
    let last: Res | null = null;
    for (let i = 0; i < 6; i++) last = await login(a.email, `wrong-pass-${i}x`, `10.1.0.${i}`);
    assert.equal(last!.statusCode, 429);
    assert.equal((await login(a.email, 'Kendibo-Console-2026', '10.1.1.1')).statusCode, 429, 'even the right password waits out the lock');
  });

  it('a signed-in admin changes the password (current one required)', async () => {
    const a = await seat();
    await adminPassword.set(a.id, 'Kendibo-Console-2026', true);
    const s = (await login(a.email, 'Kendibo-Console-2026', '10.2.0.1')).json().data;
    const auth = { authorization: `Bearer ${s.access}`, 'x-forwarded-for': '10.2.0.1' };
    const noCurrent = await app.inject({ method: 'POST', url: '/v1/admin/password', headers: auth, payload: { newPassword: 'Another-Strong-2027' } });
    assert.equal(noCurrent.statusCode, 401);
    const weak = await app.inject({ method: 'POST', url: '/v1/admin/password', headers: auth, payload: { currentPassword: 'Kendibo-Console-2026', newPassword: 'short' } });
    assert.equal(weak.json().error.code, 'WEAK_PASSWORD');
    const ok = await app.inject({ method: 'POST', url: '/v1/admin/password', headers: auth, payload: { currentPassword: 'Kendibo-Console-2026', newPassword: 'Another-Strong-2027' } });
    assert.equal(ok.statusCode, 200, ok.body);
    const st = await app.inject({ method: 'GET', url: '/v1/admin/password', headers: auth });
    assert.deepEqual(st.json().data, { hasPassword: true, mustChange: false });
    assert.equal((await login(a.email, 'Another-Strong-2027', '10.2.0.2')).statusCode, 200);
  });
});
