// Pricing + cancellation numbers come from the database (pricing.config.ts):
// seeded defaults equal the old hard-coded values, admins edit them via
// /v1/admin/settings/pricing, and the pricing engine / cancel quote use them.
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

let ipN = 0;
const ip = () => { ipN++; return `10.78.${Math.floor(ipN / 250)}.${(ipN % 250) + 1}`; };
const call = (method: string, url: string, sub: string, payload?: unknown) =>
  app.inject({ method, url, remoteAddress: ip(), headers: { authorization: `Bearer ${signAccess(sub, [])}` }, ...(payload !== undefined ? { payload } : {}) });
async function user(role: string) {
  return String((await q<{ id: string }>(
    `INSERT INTO identity.users (email, role, name) VALUES ($1,$2,'Pricing Admin') RETURNING id`,
    [`price-${randomUUID()}@kendibo.local`, role],
  ))[0].id);
}

describe('pricing config in the database', () => {
  it('seeded values equal the old hard-coded defaults', async () => {
    const sa = await user('SUPER_ADMIN');
    assert.equal((await app.inject({ method: 'GET', url: '/v1/admin/settings/pricing', remoteAddress: ip() })).statusCode, 401);
    assert.equal((await call('GET', '/v1/admin/settings/pricing', await user('PROVIDER'))).statusCode, 403);
    const res = await call('GET', '/v1/admin/settings/pricing', sa);
    assert.equal(res.statusCode, 200, res.body);
    const d = res.json().data;
    assert.deepEqual(d.config, d.defaults);
    assert.equal(d.config.vatBps, 750);
    assert.equal(d.config.cancellation.en_route.refundBps, 8500);
  });

  it('PUT validates, versions the pricebook, audit-logs and takes effect in pricing + cancel quote', async () => {
    const { price } = await import('../modules/pricing/pricing.engine.js');
    const { evaluateCancellationLive } = await import('../modules/bookings/cancellation.js');
    const sa = await user('SUPER_ADMIN');
    const cur = (await call('GET', '/v1/admin/settings/pricing', sa)).json().data.config;
    const before = await price({ serviceId: 'svc_ac_general', urgent: true, distanceKm: 2 });

    const bad = await call('PUT', '/v1/admin/settings/pricing', sa, { ...cur, vatBps: 20000, cancellation: { ...cur.cancellation, arrived: { refundBps: -1, calloutApplies: true } } });
    assert.equal(bad.statusCode, 400, bad.body);
    assert.ok(bad.json().error.fields.vatBps);
    assert.ok(bad.json().error.fields['cancellation.arrived.refundBps']);
    assert.equal((await call('PUT', '/v1/admin/settings/pricing', await user('PROVIDER'), cur)).statusCode, 403);

    const next = { ...cur, vatBps: 1000, perKmKobo: 30000, urgencyBps: 5000, cancellation: { ...cur.cancellation, en_route: { refundBps: 7000, calloutApplies: false } } };
    const ok = await call('PUT', '/v1/admin/settings/pricing', sa, next);
    assert.equal(ok.statusCode, 200, ok.body);
    const saved = ok.json().data.config;
    assert.equal(saved.vatBps, 1000);
    assert.notEqual(saved.version, cur.version, 'a VAT change creates a new pricebook version');

    const afterPrice = await price({ serviceId: 'svc_ac_general', urgent: true, distanceKm: 2 });
    assert.equal(afterPrice.ruleVersion, saved.version);
    assert.equal(afterPrice.distanceKobo, 60000n);
    assert.equal(afterPrice.urgencyKobo, (afterPrice.baseKobo * 5000n) / 10000n);
    assert.ok(afterPrice.totalKobo > before.totalKobo);
    assert.equal((await evaluateCancellationLive('EN_ROUTE')).refundBps, 7000);

    const logs = await q(`SELECT 1 FROM audit.log WHERE action='settings.pricing.update' AND actor=$1`, [sa]);
    assert.equal(logs.length, 1);

    // restore for other tests
    assert.equal((await call('PUT', '/v1/admin/settings/pricing', sa, { ...cur, version: undefined })).statusCode, 200);
    assert.equal((await evaluateCancellationLive('EN_ROUTE')).refundBps, 8500);
  });
});
