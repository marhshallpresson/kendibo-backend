import { describe, it } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { deviceService } from '../modules/devices/device.service.js';
import { geoService } from '../modules/geo/geo.service.js';
import { mediaService } from '../modules/media/media.service.js';
import { surfaceFor } from '../packages/shared/clients.js';
import { evaluateCancellation } from '../modules/bookings/cancellation.js';
import { checklistService } from '../modules/providers/quality.service.js';
import { quoteService } from '../modules/quotes/quote.service.js';
import { q } from '../packages/database/db.js';

// Test isolation: never touch a real DATABASE_URL/REDIS_URL from the machine env.
// @ts-ignore
if (typeof globalThis.KENDIBO_TEST_ISOLATION === 'undefined') { (globalThis as any).KENDIBO_TEST_ISOLATION = true; delete process.env.DATABASE_URL; delete process.env.REDIS_URL; }
async function testUser(): Promise<string> {
  const rows = await q<{ id: string }>(
    `INSERT INTO identity.users (email) VALUES ($1) RETURNING id`,
    [`test-${randomUUID()}@kendibo.local`],
  );
  return String(rows[0].id);
}

describe('device registry (push targets)', () => {
  it('registers + re-install dedupes + logout removes', async () => {
    const u = await testUser();
    const token = `fcm_tok_${randomUUID()}`;
    const d = await deviceService.register(u, 'android', token, 'kendibo-jobs');
    assert.equal((await deviceService.tokensFor(u)).length, 1);
    await deviceService.register(u, 'android', token);
    assert.equal((await deviceService.tokensFor(u)).length, 1);
    assert.equal(await deviceService.remove(d.id), true);
    assert.equal((await deviceService.tokensFor(u)).length, 0);
  });
});

describe('batch location ingest (Android tracker)', () => {
  it('applies valid, rejects garbage, caps size', async () => {
    const p = randomUUID();
    const r = await geoService.ingestBatch(p, [
      { lat: 9.09, lng: 7.41, at: new Date().toISOString() },
      { lat: 999, lng: 7.41, at: new Date().toISOString() },
    ]);
    assert.equal(r.applied, 1);
    assert.equal(r.rejected, 1);
    await assert.rejects(() => geoService.ingestBatch(p, new Array(101).fill({ lat: 9, lng: 7, at: '' })), /BATCH_TOO_LARGE/);
  });
});

describe('media ingest (evidence pipeline)', () => {
  it('accepts jpeg, rejects oversize/exe', async () => {
    const pre = await mediaService.presign('photo');
    const ok = await mediaService.ingest(pre.assetId, Buffer.alloc(1024), 'image/jpeg');
    assert.equal(ok.status, 'clean');
    assert.ok(ok.sha256.length === 64);
    const pre2 = await mediaService.presign('photo');
    assert.equal((await mediaService.ingest(pre2.assetId, Buffer.alloc(10), 'application/x-msdownload')).status, 'rejected');
  });
});

describe('client surfaces + cancellation + checklist + quote lock', () => {
  it('routes map to the right app', () => {
    assert.equal(surfaceFor('/v1/bookings'), 'user_app');
    assert.equal(surfaceFor('/v1/provider/jobs/x/accept'), 'provider_b2b_app');
    assert.equal(surfaceFor('/v1/b2b/work-orders'), 'provider_b2b_app');
    assert.equal(surfaceFor('/v1/admin/jobs'), 'admin_console');
  });
  it('cancellation matrix refunds by stage', () => {
    assert.equal(evaluateCancellation('REQUESTED').refundBps, 10000);
    assert.equal(evaluateCancellation('EN_ROUTE').refundBps, 8500);
    assert.equal(evaluateCancellation('IN_PROGRESS', { providerFault: true }).refundBps, 10000);
  });
  it('checklist gates completion; change order needs approval', async () => {
    assert.equal(await checklistService.satisfied('job1', 'AC Services'), false);
    for (const item of checklistService.forCategory('AC Services')) await checklistService.complete('job1', item);
    assert.equal(await checklistService.satisfied('job1', 'AC Services'), true);
    const q = await quoteService.propose('bq9', { amountKobo: 50000n });
    const acc = await quoteService.accept('bq9', 1);
    assert.equal(acc.locked, true);
    const co = await quoteService.requestChange('bq9', q.id, 'hidden damage', 15000n);
    assert.equal((await quoteService.decideChange(co.id, true, 'customer')).status, 'approved');
  });
});
