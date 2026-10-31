// On-demand request lifecycle: create with coordinates auto-broadcasts offers,
// the first provider accept mints + links a booking and an accepted dispatch
// assignment, and the booking advances to PROVIDER_ACCEPTED so tracking works.
// Route-level (app.inject) so the mobile-facing contract is what we verify.
import 'dotenv/config';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { providerService } from '../modules/providers/provider.service.js';
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
    [`lifecycle-${randomUUID()}@kendibo.local`],
  );
  return String(rows[0].id);
}

// Returns the provider id plus the vendor's user id: accepting an offer is a
// vendor-session action (the offer must belong to the signed-in provider).
async function onlinePro(lat: number, lng: number): Promise<string> {
  const uid = await testUser();
  const p = await providerService.onboard(uid);
  await providerService.addSkill(p.id, 'hvac');
  await providerService.verifyKyc(p.id);
  await providerService.setOnline(p.id, true, lat, lng);
  proUsers.set(p.id, uid);
  return p.id;
}
const proUsers = new Map<string, string>();

describe('on-demand request lifecycle', () => {
  it('create with coords auto-offers; accept creates and links a booking', async () => {
    const user = await testUser();
    const providerId = await onlinePro(4.99, 7.93);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/service-requests',
      headers: { ...auth(user), ...idem() },
      payload: {
        categoryId: 'ac', title: 'AC not cooling', details: 'warm air',
        urgency: 'today', lat: 4.99, lng: 7.93,
      },
    });
    assert.equal(created.statusCode, 200);
    const req = created.json().data;
    assert.equal(req.status, 'OFFERED', 'request is auto-matched on create');
    assert.equal(req.categoryId, 'ac');

    // pg-mem misses prefixed TEXT index lookups; scan + filter in JS.
    const offerRows = await q<Record<string, unknown>>(
      `SELECT id, request_id, provider_id, status FROM booking.request_offer`,
    );
    const offer = offerRows.find(
      (r) => String(r.request_id) === req.id && String(r.provider_id) === providerId,
    );
    assert.ok(offer, 'an offer row was created for the online provider');
    assert.equal(String(offer!.status), 'offered');

    const accepted = await app.inject({
      method: 'POST',
      url: `/v1/provider/requests/${offer!.id}/respond`,
      headers: auth(proUsers.get(providerId)!),
      payload: { accept: true },
    });
    assert.equal(accepted.statusCode, 200);
    const result = accepted.json().data;
    assert.equal(result.status, 'accepted');
    assert.ok(result.bookingId, 'accept returns a linked bookingId');

    const fetched = await app.inject({
      method: 'GET', url: `/v1/service-requests/${req.id}`, headers: auth(user),
    });
    assert.equal(fetched.statusCode, 200);
    assert.equal(fetched.json().data.status, 'BOOKED');
    assert.equal(fetched.json().data.bookingId, result.bookingId);

    const assignments = await q<Record<string, unknown>>(
      `SELECT job_id, provider_id, status FROM dispatch.assignment WHERE provider_id=$1`, [providerId],
    );
    const acceptedAssignment = assignments.find((a) => String(a.job_id) === String(result.bookingId));
    assert.ok(acceptedAssignment, 'accepted assignment exists for the booking job');
    assert.equal(String(acceptedAssignment!.status), 'accepted');

    const booking = await app.inject({
      method: 'GET', url: `/v1/bookings/${result.bookingId}`, headers: auth(user),
    });
    assert.equal(booking.statusCode, 200);
    assert.equal(booking.json().data.status, 'PROVIDER_ACCEPTED');
  });

  it('non-owners cannot read, match or convert a request', async () => {
    const user = await testUser();
    await onlinePro(4.99, 7.93);
    const created = await app.inject({
      method: 'POST',
      url: '/v1/service-requests',
      headers: { ...auth(user), ...idem() },
      payload: { categoryId: 'ac', title: 'Door hinge', lat: 4.99, lng: 7.93 },
    });
    const id = created.json().data.id;
    const intruder = await testUser();

    const read = await app.inject({ method: 'GET', url: `/v1/service-requests/${id}`, headers: auth(intruder) });
    assert.equal(read.statusCode, 403);

    const matches = await app.inject({ method: 'GET', url: `/v1/service-requests/${id}/matches`, headers: auth(intruder) });
    assert.equal(matches.statusCode, 403);

    const convert = await app.inject({ method: 'POST', url: `/v1/service-requests/${id}/convert`, headers: auth(intruder) });
    assert.equal(convert.statusCode, 403);

    const unauthed = await app.inject({ method: 'GET', url: `/v1/service-requests/${id}` });
    assert.equal(unauthed.statusCode, 401);
  });
});
