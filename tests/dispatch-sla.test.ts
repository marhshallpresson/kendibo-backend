// Hybrid dispatch: SLA expiry, escalation, MATCHING entry and customer-pick
// fallback. Service-level tests hit the dispatch module; route tests use the
// real Fastify app (app.inject) so the mobile-facing contract is verified.
import 'dotenv/config';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { providerService } from '../modules/providers/provider.service.js';
import { dispatchService } from '../modules/dispatch/dispatch.service.js';
import { q } from '../packages/database/db.js';
import { signAccess } from '../packages/auth/auth.js';

// Isolate BEFORE importing main.js (which loads dotenv + touches the DB).
process.env.NODE_ENV = 'test';

let app: {
  inject: (opts: unknown) => Promise<{ statusCode: number; json: () => any }>;
  close?: () => Promise<void>;
};
before(async () => {
  process.env.DATABASE_URL = '';
  process.env.REDIS_URL = '';
  ({ app } = await import('../apps/api/src/main.js'));
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
});
after(async () => {
  await app?.close?.().catch(() => {});
});

const auth = (sub: string) => ({ authorization: `Bearer ${signAccess(sub, [])}` });
const idem = () => ({ 'idempotency-key': `idem-${randomUUID()}` });

async function testUser(): Promise<string> {
  const rows = await q<{ id: string }>(
    `INSERT INTO identity.users (email) VALUES ($1) RETURNING id`,
    [`sla-${randomUUID()}@kendibo.local`],
  );
  return String(rows[0].id);
}

async function skilledOnlineProvider(lat: number, lng: number): Promise<string> {
  const p = await providerService.onboard(await testUser());
  await providerService.addSkill(p.id, 'hvac');
  await providerService.verifyKyc(p.id);
  await providerService.setOnline(p.id, true, lat, lng);
  return p.id;
}

describe('dispatch SLA (hybrid matching)', () => {
  it('expires overdue offers and escalates to the next un-offered candidate', async () => {
    const p1 = await skilledOnlineProvider(4.99, 7.93);
    await skilledOnlineProvider(4.98, 7.94);
    const jobId = `job_${randomUUID()}`;

    const offer = await dispatchService.assign(jobId, p1, -10); // already past SLA
    assert.ok(offer.expiresAt, 'assignment records an SLA expiry');

    await dispatchService.expireOverdueOffers();
    // pg-mem misses direct TEXT job_id lookups, so scan + filter in JS.
    const forJob = async () => (await q<{ job_id: string; provider_id: string; status: string }>(
      `SELECT job_id, provider_id, status FROM dispatch.assignment`,
    )).filter((r) => String(r.job_id) === jobId);
    const afterExpiry = (await forJob()).filter((r) => String(r.provider_id) === p1);
    assert.equal(String(afterExpiry[0].status), 'expired');

    const escalated = await dispatchService.escalateNext(jobId, 'svc_ac_general', 4.99, 7.93);
    assert.equal(escalated, true);
    const offered = (await forJob()).filter((r) => String(r.status) === 'offered');
    assert.ok(offered.length >= 1, 'next candidate receives a fresh offer');
  });
});

describe('hybrid matching routes (customer app contract)', () => {
  it('booking enters MATCHING, lists candidates, and accepts a customer pick', async () => {
    const user = await testUser();
    const providerId = await skilledOnlineProvider(4.99, 7.93);
    const addr = await q<{ id: string }>(
      `INSERT INTO property.address (user_id, lat, lng, contact_phone) VALUES ($1,$2,$3,$4) RETURNING id`,
      [user, 4.99, 7.93, '08000000000'],
    );
    const addressId = String(addr[0].id);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/bookings',
      headers: { ...auth(user), ...idem() },
      payload: { serviceId: 'svc_ac_general', addressId, scheduledAt: new Date().toISOString() },
    });
    assert.equal(created.statusCode, 200);
    const booking = created.json().data;
    assert.equal(booking.status, 'MATCHING');

    const candidates = await app.inject({
      method: 'GET',
      url: `/v1/bookings/${booking.id}/match/candidates`,
      headers: auth(user),
    });
    assert.equal(candidates.statusCode, 200);
    const list = candidates.json().data.candidates;
    assert.ok(Array.isArray(list) && list.length >= 1);
    assert.ok(list.some((c: { providerId: string }) => c.providerId === providerId));

    const pick = await app.inject({
      method: 'POST',
      url: `/v1/bookings/${booking.id}/match/pick`,
      headers: { ...auth(user), ...idem() },
      payload: { providerId },
    });
    assert.equal(pick.statusCode, 200);
    assert.equal(pick.json().data.status, 'offered');
  });

  it('rejects pick from a non-owner', async () => {
    const user = await testUser();
    await skilledOnlineProvider(4.99, 7.93);
    const addr = await q<{ id: string }>(
      `INSERT INTO property.address (user_id, lat, lng, contact_phone) VALUES ($1,$2,$3,$4) RETURNING id`,
      [user, 4.99, 7.93, '08000000001'],
    );
    const created = await app.inject({
      method: 'POST',
      url: '/v1/bookings',
      headers: { ...auth(user), ...idem() },
      payload: { serviceId: 'svc_ac_general', addressId: String(addr[0].id), scheduledAt: new Date().toISOString() },
    });
    const bookingId = created.json().data.id;
    const intruder = await testUser();
    const pick = await app.inject({
      method: 'POST',
      url: `/v1/bookings/${bookingId}/match/pick`,
      headers: { ...auth(intruder), ...idem() },
      payload: { providerId: randomUUID() },
    });
    assert.equal(pick.statusCode, 403);
  });
});
