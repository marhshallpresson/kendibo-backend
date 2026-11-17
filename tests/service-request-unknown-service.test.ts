// A bad serviceId (e.g. a category id sent by an older app build) must not 500
// the request: the FK to catalog.service would reject it, so it is dropped.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { q } from '../packages/database/db.js';
import { requestService } from '../modules/requests/request.service.js';

async function newUser() {
  return String((await q<{ id: string }>(
    `INSERT INTO identity.users (email, role, name) VALUES ($1,'CUSTOMER','Req Tester') RETURNING id`, [`req-${randomUUID()}@kendibo.local`],
  ))[0].id);
}

describe('service request: serviceId handling', () => {
  it('unknown serviceId does not fail; request is created with null service_id', async () => {
    const uid = await newUser();
    const r = await requestService.create(uid, {
      serviceId: 'not-a-real-service', categoryId: 'some-category', title: 'Fix AC', idempotencyKey: randomUUID(),
    });
    assert.ok(r.id);
    assert.equal(r.serviceId, null);
    assert.equal(r.categoryId, 'some-category');
    const rows = await q<{ service_id: string | null }>(`SELECT service_id FROM booking.service_request WHERE id=$1`, [r.id]);
    assert.equal(rows[0].service_id, null);
  });

  it('request without serviceId is still created', async () => {
    const uid = await newUser();
    const r = await requestService.create(uid, { categoryId: 'c1', title: 'Plumbing', idempotencyKey: randomUUID() });
    assert.ok(r.id);
    assert.equal(r.serviceId, null);
  });
});
