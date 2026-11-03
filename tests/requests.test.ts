import { describe, it } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { requestService } from '../modules/requests/request.service.js';
import { providerService } from '../modules/providers/provider.service.js';
import { bookingService } from '../modules/bookings/booking.service.js';
import { q } from '../packages/database/db.js';

// Test isolation: never touch a real DATABASE_URL/REDIS_URL from the machine env.
// @ts-ignore
if (typeof globalThis.Kendibo_TEST_ISOLATION === 'undefined') { (globalThis as any).Kendibo_TEST_ISOLATION = true; delete process.env.DATABASE_URL; delete process.env.REDIS_URL; }
async function testUser(): Promise<string> {
  const rows = await q<{ id: string }>(`INSERT INTO identity.users (email) VALUES ($1) RETURNING id`, [`rq-${randomUUID()}@kendibo.local`]);
  return String(rows[0].id);
}
function reqInput(key: string) {
  return {
    serviceId: 'svc_ac_general', title: 'AC not cooling', details: 'Warm air since yesterday',
    urgency: 'today' as const, lat: 9.09, lng: 7.41,
    contactName: 'Test User', contactPhone: '+2348012345678', idempotencyKey: key,
  };
}

describe('service requests (on-demand)', () => {
  it('create is idempotent; matches rank nearby providers', async () => {
    const u = await testUser();
    const key = `rq-${randomUUID()}`;
    const a = await requestService.create(u, reqInput(key));
    const b = await requestService.create(u, reqInput(key));
    assert.equal(a.id, b.id);
    assert.equal(a.status, 'SUBMITTED');

    const p = await providerService.onboard(await testUser());
    await providerService.addSkill(p.id, 'hvac');
    await providerService.verifyKyc(p.id);
    await providerService.setOnline(p.id, true, 9.09, 7.41);
    const m = await requestService.matches(a.id);
    assert.ok(m.candidates.some((c) => c.providerId === p.id));
  });

  it('broadcast -> first accept wins, second loses, convert mints booking', async () => {
    const u = await testUser();
    const r = await requestService.create(u, reqInput(`rq-${randomUUID()}`));
    const p1 = await providerService.onboard(await testUser());
    const p2 = await providerService.onboard(await testUser());
    for (const p of [p1, p2]) {
      await providerService.addSkill(p.id, 'hvac');
      await providerService.verifyKyc(p.id);
      await providerService.setOnline(p.id, true, 9.09, 7.41);
    }
    const bc = await requestService.broadcast(r.id, 5);
    assert.ok(bc.offersSent >= 2);
    const incoming = await requestService.incoming(p1.id);
    assert.ok(incoming.length >= 1);
    const myOffer = incoming.find((o) => String(o.request_id) === r.id);
    const won = await requestService.respondOffer(String(myOffer!.id), true);
    assert.equal(won.status, 'accepted');
    const other = (await requestService.incoming(p2.id)).find((o) => String(o.request_id) === r.id);
    if (other) await assert.rejects(() => requestService.respondOffer(String(other.id), true), /OFFER_TAKEN|OFFER_GONE/);
    const conv = await requestService.convert(r.id, u);
    assert.ok(conv.booking.id);
    const bk = await bookingService.get(conv.booking.id, u);
    assert.equal(bk?.status, 'REQUESTED');
  });

  it('convert without service needs quote flow', async () => {
    const u = await testUser();
    const r = await requestService.create(u, { title: 'Weird noise', details: 'unknown', lat: 9.09, lng: 7.41, idempotencyKey: `rq-${randomUUID()}` });
    await q(`UPDATE booking.service_request SET status='ACCEPTED' WHERE id=$1`, [r.id]);
    await assert.rejects(() => requestService.convert(r.id, u), /NEEDS_SERVICE_QUOTE/);
  });
});
