// The public service catalog is built from verified vendors' offerings.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { q } from '../packages/database/db.js';
import { catalogService } from '../modules/catalog/catalog.service.js';
import { kycService } from '../modules/kyc/kyc.service.js';
import { offeringService } from '../modules/vendors/offering.service.js';

async function vendor(o: { kyc?: string; status?: string; isTest?: boolean; suspended?: boolean; rating?: number } = {}) {
  const uid = String((await q<{ id: string }>(
    `INSERT INTO identity.users (email, role, name, is_test, suspended_at) VALUES ($1,'PROVIDER','Vendor',$2,$3) RETURNING id`,
    [`cat-${randomUUID()}@kendibo.local`, o.isTest ?? false, o.suspended ? new Date().toISOString() : null],
  ))[0].id);
  const pid = String((await q<{ id: string }>(
    `INSERT INTO provider.provider (user_id, kyc_status, status, kyc_tier, rating, business_name) VALUES ($1,$2,$3,2,$4,'Acme Fixes') RETURNING id`,
    [uid, o.kyc ?? 'VERIFIED', o.status ?? 'active', o.rating ?? 4.5],
  ))[0].id);
  return { uid, pid };
}
const CAT = 'ac';
const offer = (pid: string, name: string, price = 500000n) =>
  offeringService.create(pid, { categoryId: CAT, name, priceKobo: price }) as Promise<{ id: string }>;
const names = async (category?: string) => (await catalogService.list(category)).map((s) => s.name);

describe('catalog built from verified vendor offerings', () => {
  it('a verified vendor offering appears, with price, vendor and detail lookup', async () => {
    const v = await vendor();
    const o = await offer(v.pid, 'AC deep clean visible');
    const hit = (await catalogService.list(CAT)).find((s) => s.id === o.id);
    assert.ok(hit);
    assert.equal(hit!.categoryId, CAT);
    assert.equal(hit!.bookingMode, 'fixed');
    assert.equal(hit!.baseKobo, 500000n);
    assert.equal(hit!.providerName, 'Acme Fixes');
    assert.equal(hit!.offeringId, o.id);
    assert.equal((await catalogService.get(o.id))?.name, 'AC deep clean visible');
    assert.ok((await catalogService.search('deep clean visible')).some((s) => s.id === o.id));
  });

  it('unverified, suspended, inactive and test vendors are hidden', async () => {
    for (const [label, opts] of [
      ['unverified', { kyc: 'UNDER_REVIEW' }], ['status-suspended', { status: 'suspended' }],
      ['test-user', { isTest: true }], ['user-suspended', { suspended: true }],
    ] as const) {
      const v = await vendor(opts);
      const o = await offer(v.pid, `hidden ${label}`);
      assert.ok(!(await names()).includes(`hidden ${label}`), label);
      assert.equal(await catalogService.get(o.id), null, `${label} detail`);
    }
  });

  it('removing or pausing the offering hides it, and un-verifying the vendor hides it', async () => {
    const v = await vendor();
    const a = await offer(v.pid, 'pausable offer');
    const b = await offer(v.pid, 'unverify offer');
    assert.ok((await names()).includes('pausable offer'));
    await offeringService.update(v.pid, a.id, { active: false });
    assert.ok(!(await names()).includes('pausable offer'));
    await q(`DELETE FROM provider.offering WHERE id=$1`, [b.id]);
    assert.ok(!(await names()).includes('unverify offer'));
    const c = await offer(v.pid, 'revoked offer');
    assert.ok((await names()).includes('revoked offer'));
    await q(`UPDATE provider.provider SET kyc_status='REJECTED' WHERE id=$1`, [v.pid]);
    assert.ok(!(await names()).includes('revoked offer'));
    assert.equal(await catalogService.get(c.id), null);
  });

  it('admin approval makes existing offerings appear without any other step', async () => {
    const v = await vendor({ kyc: 'UNDER_REVIEW' });
    await offer(v.pid, 'appears on approval');
    assert.ok(!(await names()).includes('appears on approval'));
    await kycService.markApproved(v.pid, 'admin-1');
    assert.ok((await names()).includes('appears on approval'));
  });

  it('category filter works and most popular (jobs, then rating) comes first', async () => {
    const lo = await vendor({ rating: 3 }); const hi = await vendor({ rating: 5 }); const busy = await vendor({ rating: 2 });
    await offer(lo.pid, 'pop-low'); await offer(hi.pid, 'pop-high'); await offer(busy.pid, 'pop-busy');
    await q(`INSERT INTO provider.earning (provider_id, job_id, amount_kobo) VALUES ($1,'j1',1000)`, [busy.pid]);
    const order = (await names(CAT)).filter((n) => n.startsWith('pop-'));
    assert.deepEqual(order, ['pop-busy', 'pop-high', 'pop-low']);
    assert.ok(!(await names('definitely-not-a-category')).includes('pop-low'));
  });
});
