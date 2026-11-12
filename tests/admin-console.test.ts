// Admin console API: user/provider management, categories, admin 2FA, login
// protection, idle timeout and audit — route-level through the real gate.
import 'dotenv/config';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
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

const UA = 'admin-console-test/1.0';
const bearer = (token: string) => ({ authorization: `Bearer ${token}`, 'user-agent': UA });
const auth = (sub: string) => bearer(signAccess(sub, []));
async function user(role: string, name = 'Test User') {
  const email = `${role.toLowerCase()}-${randomUUID()}@kendibo.local`;
  const id = String((await q<{ id: string }>(`INSERT INTO identity.users (email, role, name) VALUES ($1,$2,$3) RETURNING id`, [email, role, name]))[0].id);
  return { id, email };
}
async function otpLogin(email: string) {
  const { code } = await issueOtp('email', email);
  return app.inject({ method: 'POST', url: '/v1/auth/otp/verify', headers: { 'user-agent': UA }, payload: { channel: 'email', identity: email, code } });
}
async function providerFor(userId: string, extra = `kyc_status='VERIFIED', verify_level='verified', online=TRUE`) {
  const id = String((await q<{ id: string }>(`INSERT INTO provider.provider (user_id, business_name) VALUES ($1,'Ada Fix') RETURNING id`, [userId]))[0].id);
  await q(`UPDATE provider.provider SET ${extra} WHERE id=$1`, [id]);
  return id;
}

describe('access', () => {
  it('anonymous gets 401 and non-admins get 403 on every console route', async () => {
    const cust = await user('CUSTOMER');
    const routes: [string, string][] = [
      ['GET', '/v1/admin/users'], ['GET', `/v1/admin/users/${cust.id}`],
      ['POST', `/v1/admin/users/${cust.id}/suspend`], ['POST', `/v1/admin/users/${cust.id}/reactivate`],
      ['POST', `/v1/admin/users/${cust.id}/signout`], ['POST', `/v1/admin/users/${cust.id}/erase`],
      ['POST', `/v1/admin/providers/${randomUUID()}/reactivate`], ['POST', `/v1/admin/providers/${randomUUID()}/revoke-verification`],
      ['GET', '/v1/admin/categories'], ['POST', '/v1/admin/categories'], ['PATCH', '/v1/admin/categories/cleaning'],
      ['POST', '/v1/admin/categories/cleaning/disable'], ['POST', '/v1/admin/categories/cleaning/enable'], ['POST', '/v1/admin/categories/cleaning/merge'],
      ['GET', '/v1/admin/category-groups'], ['POST', '/v1/admin/category-groups'], ['PATCH', '/v1/admin/category-groups/other'],
      ['GET', '/v1/admin/2fa/status'], ['POST', '/v1/admin/2fa/enroll'], ['POST', '/v1/admin/2fa/verify'], ['POST', '/v1/admin/2fa/disable'],
      ['GET', '/v1/admin/audit'],
    ];
    for (const [method, url] of routes) {
      assert.equal((await app.inject({ method, url, payload: {} })).statusCode, 401, `${method} ${url} anon`);
      const r = await app.inject({ method, url, headers: auth(cust.id), payload: {} });
      assert.equal(r.statusCode, 403, `${method} ${url} customer`);
    }
    // Support can look people up but not suspend them.
    const support = await user('CUSTOMER_SUPPORT');
    assert.equal((await app.inject({ method: 'GET', url: '/v1/admin/users', headers: auth(support.id) })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: `/v1/admin/users/${cust.id}/suspend`, headers: auth(support.id), payload: { reason: 'nope' } })).statusCode, 403);
  });
});

describe('users', () => {
  it('searches and filters by role and status', async () => {
    const admin = await user('TRUST_SAFETY');
    const tag = `Zed${randomUUID().slice(0, 6)}`;
    const c = await user('CUSTOMER', `${tag} Customer`);
    const p = await user('PROVIDER', `${tag} Provider`);
    const pid = await providerFor(p.id);
    const list = await app.inject({ method: 'GET', url: `/v1/admin/users?q=${tag.toLowerCase()}`, headers: auth(admin.id) });
    assert.equal(list.statusCode, 200, list.body);
    assert.equal(list.json().data.total, 2);
    const prov = await app.inject({ method: 'GET', url: `/v1/admin/users?q=${tag}&role=provider`, headers: auth(admin.id) });
    const items = prov.json().data.items;
    assert.deepEqual(items.map((i: { id: string }) => i.id), [p.id]);
    assert.equal(items[0].role, 'provider');
    assert.deepEqual({ id: items[0].provider.id, kyc: items[0].provider.kycStatus, online: items[0].provider.online }, { id: pid, kyc: 'VERIFIED', online: true });
    assert.equal(items[0].kycStatus, 'VERIFIED');
    await q(`UPDATE identity.users SET status='suspended' WHERE id=$1`, [c.id]);
    const sus = await app.inject({ method: 'GET', url: `/v1/admin/users?q=${tag}&status=suspended`, headers: auth(admin.id) });
    assert.deepEqual(sus.json().data.items.map((i: { id: string }) => i.id), [c.id]);
    const detail = await app.inject({ method: 'GET', url: `/v1/admin/users/${p.id}`, headers: auth(admin.id) });
    const d = detail.json().data;
    assert.equal(d.id, p.id);
    assert.equal(d.bookingsCount, 0);
    assert.equal(d.walletBalanceKobo, '0');
    assert.ok(Array.isArray(d.devices) && Array.isArray(d.recentAudit));
    assert.equal(d.provider.id, pid);
  });

  it('suspend refuses login, refresh and authenticated calls with ACCOUNT_SUSPENDED; reactivate restores', async () => {
    const admin = await user('TRUST_SAFETY');
    const c = await user('CUSTOMER');
    const login = (await otpLogin(c.email)).json().data;
    assert.ok(login.access && login.refresh);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(login.access) })).statusCode, 200);

    assert.equal((await app.inject({ method: 'POST', url: `/v1/admin/users/${c.id}/suspend`, headers: auth(admin.id), payload: {} })).statusCode, 400, 'reason required');
    const s = await app.inject({ method: 'POST', url: `/v1/admin/users/${c.id}/suspend`, headers: { ...auth(admin.id), 'x-forwarded-for': '41.58.1.2' }, payload: { reason: 'Fraud reports from three customers' } });
    assert.equal(s.statusCode, 200, s.body);
    assert.equal(s.json().data.status, 'suspended');

    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(login.access) });
    assert.equal(me.statusCode, 403);
    assert.equal(me.json().error.code, 'ACCOUNT_SUSPENDED');
    const fresh = await app.inject({ method: 'GET', url: '/v1/me', headers: auth(c.id) });
    assert.equal(fresh.json().error.code, 'ACCOUNT_SUSPENDED');
    const ref = await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refresh: login.refresh } });
    assert.equal(ref.statusCode, 403);
    assert.equal(ref.json().error.code, 'ACCOUNT_SUSPENDED');
    const again = await otpLogin(c.email);
    assert.equal(again.statusCode, 403);
    assert.equal(again.json().error.code, 'ACCOUNT_SUSPENDED');

    // Audit row carries actor, reason, ip and user agent.
    const row = (await q<Record<string, unknown>>(`SELECT * FROM audit.log WHERE action='admin.user.suspend' AND entity_id=$1`, [c.id]))[0];
    assert.equal(row.actor, admin.id);
    assert.equal(row.entity_type, 'user');
    assert.equal(row.reason, 'Fraud reports from three customers');
    assert.equal(row.user_agent, UA);
    assert.ok(row.ip, 'ip recorded');
    const auditor = await user('SUPER_ADMIN');
    const trail = await app.inject({ method: 'GET', url: `/v1/admin/audit?action=admin.user.suspend&entity=user&actor=${admin.id}`, headers: auth(auditor.id) });
    assert.equal(trail.statusCode, 200, trail.body);
    const t = trail.json().data;
    assert.equal(t.total, 1);
    assert.deepEqual({ entityId: t.items[0].entityId, ua: t.items[0].ua, reason: t.items[0].reason }, { entityId: c.id, ua: UA, reason: 'Fraud reports from three customers' });
    assert.ok(t.items[0].ip && t.items[0].at && t.items[0].actorName);

    const re = await app.inject({ method: 'POST', url: `/v1/admin/users/${c.id}/reactivate`, headers: auth(admin.id), payload: { reason: 'Cleared after review' } });
    assert.equal(re.statusCode, 200, re.body);
    const back = (await otpLogin(c.email)).json().data;
    assert.ok(back.access);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(back.access) })).statusCode, 200);
  });

  it('signout revokes refresh tokens and live access tokens', async () => {
    const admin = await user('TRUST_SAFETY');
    const c = await user('CUSTOMER');
    const login = (await otpLogin(c.email)).json().data;
    const r = await app.inject({ method: 'POST', url: `/v1/admin/users/${c.id}/signout`, headers: auth(admin.id), payload: {} });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().data.revokedSessions, 1);
    const ref = await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refresh: login.refresh } });
    assert.equal(ref.json().error.code, 'REFRESH_REJECTED');
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(login.access) });
    assert.equal(me.statusCode, 401);
    assert.equal(me.json().error.code, 'SESSION_REVOKED');
    assert.equal((await q(`SELECT 1 FROM identity.refresh_token WHERE user_id=$1`, [c.id])).length, 0);
    // Signing in again works.
    const back = (await otpLogin(c.email)).json().data;
    assert.equal((await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(back.access) })).statusCode, 200);
  });

  it('erase needs confirm, is refused with open bookings and erases once they close', async () => {
    const sa = await user('SUPER_ADMIN');
    const ts = await user('TRUST_SAFETY');
    const c = await user('CUSTOMER', 'Bola Erase');
    const b = String((await q<{ id: string }>(
      `INSERT INTO booking.booking (user_id, service_id, price_kobo, price_snapshot, idempotency_key) VALUES ($1,'svc_ac_general',1500000,'{}',$2) RETURNING id`,
      [c.id, randomUUID()]))[0].id);
    assert.equal((await app.inject({ method: 'POST', url: `/v1/admin/users/${c.id}/erase`, headers: auth(ts.id), payload: { reason: 'NDPA request', confirm: 'ERASE' } })).statusCode, 403, 'erase is super admin only');
    const noConfirm = await app.inject({ method: 'POST', url: `/v1/admin/users/${c.id}/erase`, headers: auth(sa.id), payload: { reason: 'NDPA request' } });
    assert.equal(noConfirm.json().error.code, 'CONFIRM_REQUIRED');
    const open = await app.inject({ method: 'POST', url: `/v1/admin/users/${c.id}/erase`, headers: auth(sa.id), payload: { reason: 'NDPA request', confirm: 'ERASE' } });
    assert.equal(open.statusCode, 409);
    assert.equal(open.json().error.code, 'OPEN_BOOKINGS');
    await q(`UPDATE booking.booking SET status='COMPLETED' WHERE id=$1`, [b]);
    const ok = await app.inject({ method: 'POST', url: `/v1/admin/users/${c.id}/erase`, headers: auth(sa.id), payload: { reason: 'NDPA request', confirm: 'ERASE' } });
    assert.equal(ok.statusCode, 200, ok.body);
    const u = (await q<{ status: string; email: string | null; name: string }>(`SELECT status, email, name FROM identity.users WHERE id=$1`, [c.id]))[0];
    assert.deepEqual(u, { status: 'deleted', email: null, name: 'Deleted user' });
    assert.ok((await q(`SELECT 1 FROM audit.log WHERE action='admin.user.erase' AND entity_id=$1 AND reason='NDPA request'`, [c.id]))[0]);
  });
});

describe('providers', () => {
  it('revoke-verification puts KYC back under review and takes them offline; reactivate restores status', async () => {
    const ts = await user('TRUST_SAFETY');
    const pu = await user('PROVIDER');
    const pid = await providerFor(pu.id);
    const r = await app.inject({ method: 'POST', url: `/v1/admin/providers/${pid}/revoke-verification`, headers: auth(ts.id), payload: { reason: 'ID document looks altered' } });
    assert.equal(r.statusCode, 200, r.body);
    const p = (await q<Record<string, unknown>>(`SELECT kyc_status, online, verify_level, kyc_pending_reason FROM provider.provider WHERE id=$1`, [pid]))[0];
    assert.deepEqual(p, { kyc_status: 'UNDER_REVIEW', online: false, verify_level: 'under_review', kyc_pending_reason: 'admin_revoked' });
    const queue = await app.inject({ method: 'GET', url: '/v1/admin/kyc/queue', headers: auth(ts.id) });
    assert.ok(queue.json().data.some((i: { subjectId: string }) => i.subjectId === pid), 'back in the KYC queue');

    await q(`UPDATE provider.provider SET status='suspended', verify_level='suspended' WHERE id=$1`, [pid]);
    const re = await app.inject({ method: 'POST', url: `/v1/admin/providers/${pid}/reactivate`, headers: auth(ts.id), payload: {} });
    assert.equal(re.statusCode, 200, re.body);
    assert.equal((await q<{ status: string }>(`SELECT status FROM provider.provider WHERE id=$1`, [pid]))[0].status, 'active');
    assert.ok((await q(`SELECT 1 FROM audit.log WHERE action='admin.provider.revoke_verification' AND entity_id=$1 AND user_agent=$2`, [pid, UA]))[0]);
  });
});

describe('categories', () => {
  it('create, edit, disable/enable, merge (offerings move) and group create', async () => {
    const sa = await user('SUPER_ADMIN');
    const g = await app.inject({ method: 'POST', url: '/v1/admin/category-groups', headers: auth(sa.id), payload: { name: 'Events & Parties', kind: 'service', iconName: 'PartyPopper' } });
    assert.equal(g.statusCode, 201, g.body);
    assert.equal(g.json().data.id, 'events-parties');
    const created = await app.inject({ method: 'POST', url: '/v1/admin/categories', headers: auth(sa.id), payload: { name: 'Event Decoration', groupId: 'events-parties', kind: 'service', keywords: ['decor', 'balloons'], commissionBps: 1200 } });
    assert.equal(created.statusCode, 201, created.body);
    const c = created.json().data;
    assert.equal(c.id, 'event-decoration');
    assert.deepEqual({ group: c.groupName, bps: c.commissionBps, active: c.active, kw: c.keywords }, { group: 'Events & Parties', bps: 1200, active: true, kw: ['decor', 'balloons'] });
    assert.equal((await app.inject({ method: 'POST', url: '/v1/admin/categories', headers: auth(sa.id), payload: { name: 'Event Decoration', groupId: 'events-parties', kind: 'service' } })).statusCode, 409);
    const patched = await app.inject({ method: 'PATCH', url: '/v1/admin/categories/event-decoration', headers: auth(sa.id), payload: { shortName: 'Event Decor', commissionBps: 1000 } });
    assert.deepEqual({ s: patched.json().data.shortName, b: patched.json().data.commissionBps }, { s: 'Event Decor', b: 1000 });
    const groups = (await app.inject({ method: 'GET', url: '/v1/admin/category-groups', headers: auth(sa.id) })).json().data;
    assert.equal(groups.find((x: { id: string }) => x.id === 'events-parties').categoriesCount, 1);

    const dis = await app.inject({ method: 'POST', url: '/v1/admin/categories/event-decoration/disable', headers: auth(sa.id), payload: { reason: 'Not launched yet' } });
    assert.equal(dis.json().data.active, false);
    assert.ok(!(await app.inject({ method: 'GET', url: '/v1/categories' })).json().data.some((x: { id: string }) => x.id === 'event-decoration'));
    const inactive = (await app.inject({ method: 'GET', url: '/v1/admin/categories?status=inactive&group=events-parties', headers: auth(sa.id) })).json().data;
    assert.deepEqual(inactive.map((x: { id: string }) => x.id), ['event-decoration']);
    await app.inject({ method: 'POST', url: '/v1/admin/categories/event-decoration/enable', headers: auth(sa.id), payload: {} });
    assert.ok((await app.inject({ method: 'GET', url: '/v1/categories' })).json().data.some((x: { id: string }) => x.id === 'event-decoration'));

    // Merge: a duplicate trade with an offering moves onto the target.
    await app.inject({ method: 'POST', url: '/v1/admin/categories', headers: auth(sa.id), payload: { id: 'party-decor', name: 'Party Decor', groupId: 'events-parties', kind: 'service' } });
    const pu = await user('PROVIDER');
    const pid = await providerFor(pu.id);
    await q(`INSERT INTO provider.offering (provider_id, category_id, name, price_kobo) VALUES ($1,'party-decor','Balloon arch',2500000)`, [pid]);
    const before = (await app.inject({ method: 'GET', url: '/v1/admin/categories?group=events-parties', headers: auth(sa.id) })).json().data;
    assert.equal(before.find((x: { id: string }) => x.id === 'party-decor').offeringsCount, 1);
    const m = await app.inject({ method: 'POST', url: '/v1/admin/categories/party-decor/merge', headers: auth(sa.id), payload: { targetId: 'event-decoration', reason: 'Duplicate trade' } });
    assert.equal(m.statusCode, 200, m.body);
    assert.equal(m.json().data.from.active, false);
    assert.equal(m.json().data.into.offeringsCount, 1);
    assert.deepEqual((await q<{ category_id: string }>(`SELECT category_id FROM provider.offering WHERE provider_id=$1`, [pid])).map((o) => o.category_id), ['event-decoration']);
    assert.ok((await q(`SELECT 1 FROM audit.log WHERE action='admin.category.merge' AND entity_id='party-decor' AND reason='Duplicate trade'`))[0]);
  });
});

describe('admin 2FA and login protection', () => {
  it('enroll + verify with a TOTP code; login then needs the code; wrong code refused', async () => {
    const admin = await user('SUPER_ADMIN');
    const tok = auth(admin.id);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/admin/2fa/status', headers: tok })).json().data.enabled, false);
    const en = await app.inject({ method: 'POST', url: '/v1/admin/2fa/enroll', headers: tok });
    assert.equal(en.statusCode, 200, en.body);
    const { secret, otpauthUrl } = en.json().data;
    assert.match(secret, /^[A-Z2-7]{32}$/);
    assert.ok(otpauthUrl.startsWith('otpauth://totp/') && otpauthUrl.includes(`secret=${secret}`));
    const stored = (await q<{ pending_secret_enc: string }>(`SELECT pending_secret_enc FROM identity.admin_2fa WHERE user_id=$1`, [admin.id]))[0];
    assert.ok(stored.pending_secret_enc.startsWith('v1:') && !stored.pending_secret_enc.includes(secret), 'secret encrypted at rest');
    assert.equal((await app.inject({ method: 'POST', url: '/v1/admin/2fa/verify', headers: tok, payload: { code: '000000' } })).statusCode, 400);
    const ok = await app.inject({ method: 'POST', url: '/v1/admin/2fa/verify', headers: tok, payload: { code: totpCode(secret) } });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/admin/2fa/status', headers: tok })).json().data.enabled, true);
    // A session that never passed 2FA can't use the console.
    const blocked = await app.inject({ method: 'GET', url: '/v1/admin/users', headers: tok });
    assert.equal(blocked.statusCode, 403);
    assert.equal(blocked.json().error.code, 'TWO_FACTOR_REQUIRED');

    const first = await otpLogin(admin.email);
    const ch = first.json().data;
    assert.equal(ch.twoFactorRequired, true, first.body);
    assert.ok(ch.challengeId && !ch.access, 'no tokens before the second factor');
    const wrong = await app.inject({ method: 'POST', url: '/v1/admin/login/2fa', headers: { 'user-agent': UA }, payload: { challengeId: ch.challengeId, code: '123456' } });
    assert.equal(wrong.statusCode, 401);
    assert.equal(wrong.json().error.code, 'BAD_TWO_FACTOR_CODE');
    // The enrollment code's 30 s step is spent (no replay): use the next one.
    const good = await app.inject({ method: 'POST', url: '/v1/admin/login/2fa', headers: { 'user-agent': UA }, payload: { challengeId: ch.challengeId, code: totpCode(secret, Date.now() + 30_000) } });
    assert.equal(good.statusCode, 200, good.body);
    const s = good.json().data;
    assert.ok(s.access && s.refresh);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/admin/users', headers: bearer(s.access) })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/admin/login/2fa', payload: { challengeId: ch.challengeId, code: totpCode(secret) } })).json().error.code, 'CHALLENGE_INVALID', 'single use');
    const logs = (await q<{ action: string; ip: string | null; user_agent: string | null }>(`SELECT action, ip, user_agent FROM audit.log WHERE actor=$1 AND action LIKE 'admin.login.%'`, [admin.id]));
    for (const a of ['admin.login.challenge', 'admin.login.failed', 'admin.login.success']) {
      const r = logs.find((l) => l.action === a);
      assert.ok(r && r.ip && r.user_agent === UA, `${a} audited with ip/ua`);
    }
  });

  it('ADMIN_2FA_REQUIRED forces enrollment; 2fa routes stay open', async () => {
    const admin = await user('OPERATIONS');
    process.env.ADMIN_2FA_REQUIRED = 'true';
    try {
      const r = await app.inject({ method: 'GET', url: '/v1/admin/users', headers: auth(admin.id) });
      assert.equal(r.statusCode, 403);
      assert.equal(r.json().error.code, 'TWO_FACTOR_REQUIRED');
      assert.equal((await app.inject({ method: 'GET', url: '/v1/admin/2fa/status', headers: auth(admin.id) })).statusCode, 200);
    } finally { delete process.env.ADMIN_2FA_REQUIRED; }
    assert.equal((await app.inject({ method: 'GET', url: '/v1/admin/users', headers: auth(admin.id) })).statusCode, 200);
  });

  it('idle admin sessions are refused after ADMIN_IDLE_TIMEOUT_MIN', async () => {
    const admin = await user('OPERATIONS');
    const s = (await otpLogin(admin.email)).json().data;
    assert.equal((await app.inject({ method: 'GET', url: '/v1/admin/users', headers: bearer(s.access) })).statusCode, 200);
    await q(`UPDATE identity.admin_session SET last_seen_at=$2 WHERE sid=$1`, [s.deviceId, new Date(Date.now() - 31 * 60_000).toISOString()]);
    const r = await app.inject({ method: 'GET', url: '/v1/admin/users', headers: bearer(s.access) });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().error.code, 'SESSION_IDLE_TIMEOUT');
    assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refresh: s.refresh } })).json().error.code, 'REFRESH_REJECTED');
  });

  it('locks admin sign-in for 15 minutes after 5 failures', async () => {
    await q(`DELETE FROM identity.admin_login_lock`);
    const admin = await user('SUPER_ADMIN');
    const secret =(await app.inject({ method: 'POST', url: '/v1/admin/2fa/enroll', headers: auth(admin.id) })).json().data.secret;
    await app.inject({ method: 'POST', url: '/v1/admin/2fa/verify', headers: auth(admin.id), payload: { code: totpCode(secret) } });
    const ch = (await otpLogin(admin.email)).json().data.challengeId;
    for (let i = 1; i <= 4; i++) {
      const r = await app.inject({ method: 'POST', url: '/v1/admin/login/2fa', payload: { challengeId: ch, code: '000000' } });
      assert.equal(r.statusCode, 401, `attempt ${i}`);
    }
    const fifth = await app.inject({ method: 'POST', url: '/v1/admin/login/2fa', payload: { challengeId: ch, code: '000000' } });
    assert.equal(fifth.statusCode, 429);
    assert.equal(fifth.json().error.code, 'ADMIN_LOGIN_LOCKED');
    assert.ok(Number(fifth.headers['retry-after']) > 800);
    // The first factor is refused too while locked, even with the right OTP.
    const otp = await otpLogin(admin.email);
    assert.equal(otp.statusCode, 429);
    assert.ok(Number(otp.headers['retry-after']) > 0);
    assert.ok((await q(`SELECT 1 FROM audit.log WHERE actor=$1 AND action='admin.login.locked'`, [admin.id]))[0]);
    await q(`DELETE FROM identity.admin_login_lock`);
  });
});
