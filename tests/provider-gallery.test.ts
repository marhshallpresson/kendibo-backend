import 'dotenv/config';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { signAccess } from '../packages/auth/auth.js';
import { q } from '../packages/database/db.js';

let app: { inject: (opts: unknown) => Promise<{ statusCode: number; json: () => any }>; close?: () => Promise<void> };
before(async () => {
  // Isolate BEFORE main.js import (main loads dotenv + touches DB at import):
  // force test so main never listens on :3000, neutralize URLs to '' so
  // dotenv cannot restore the live URL and openPeriod uses pg-mem.
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = '';
  process.env.REDIS_URL = '';
  ({ app } = await import('../apps/api/src/main.js'));
  // main.js loads dotenv (.env holds the LIVE url) — scrub AFTER import so
  // tests always run against isolated pg-mem, never production data.
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
});
after(async () => {
  await app?.close?.().catch(() => {});
});

const auth = (sub: string) => ({ authorization: `Bearer ${signAccess(sub, [])}` });

async function realUser() {
  const rows = await q(`INSERT INTO identity.users (email) VALUES ($1) RETURNING id`, [`gal-${randomUUID()}@kendibo.local`]);
  return String(rows[0].id);
}

/** Seeded assets are 'clean' so they pass the galleryAttach guard. */
async function cleanAsset() {
  const id = `med_${randomUUID()}`;
  await q(`INSERT INTO media.asset (id, folder, status, url, mime) VALUES ($1,'photos','clean',$2,'image/jpeg')`,
    [id, `https://cdn.kendibo.local/${id}.jpg`]);
  return id;
}

async function pendingAsset() {
  const id = `med_${randomUUID()}`;
  await q(`INSERT INTO media.asset (id, folder, status) VALUES ($1,'photos','quarantined')`, [id]);
  return id;
}

describe('provider storefront gallery', () => {
  it('rejects unauthenticated writes and reads my gallery with a session', async () => {
    const userId = await realUser();
    const un = await app.inject({ method: 'POST', url: '/v1/provider/gallery', payload: { assetId: 'med_x' } });
    assert.equal(un.statusCode, 401);

    await app.inject({ method: 'POST', url: '/v1/provider/onboarding', headers: auth(userId) });
    const mine = await app.inject({ method: 'GET', url: '/v1/provider/gallery/mine', headers: auth(userId) });
    assert.equal(mine.statusCode, 200);
    assert.deepEqual(mine.json().data, []);
  });

  it('rejects an asset that has not cleared the media pipeline', async () => {
    const userId = await realUser();
    await app.inject({ method: 'POST', url: '/v1/provider/onboarding', headers: auth(userId) });
    const assetId = await pendingAsset();

    const res = await app.inject({ method: 'POST', url: '/v1/provider/gallery', headers: auth(userId), payload: { assetId } });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error?.code ?? res.json().code, 'NOT_CLEAN');
  });

  it('rejects an unknown asset id', async () => {
    const userId = await realUser();
    await app.inject({ method: 'POST', url: '/v1/provider/onboarding', headers: auth(userId) });

    const res = await app.inject({ method: 'POST', url: '/v1/provider/gallery', headers: auth(userId), payload: { assetId: 'med_missing' } });
    assert.equal(res.statusCode, 404);
  });

  it('appends in order, is idempotent per asset, and removes own entries', async () => {
    const userId = await realUser();
    await app.inject({ method: 'POST', url: '/v1/provider/onboarding', headers: auth(userId) });
    const a1 = await cleanAsset();
    const a2 = await cleanAsset();

    const first = await app.inject({ method: 'POST', url: '/v1/provider/gallery', headers: auth(userId), payload: { assetId: a1, caption: 'Kitchen refit' } });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().data.length, 1);
    assert.equal(first.json().data[0].position, 0);
    assert.equal(first.json().data[0].caption, 'Kitchen refit');

    await app.inject({ method: 'POST', url: '/v1/provider/gallery', headers: auth(userId), payload: { assetId: a2 } });
    const list = await app.inject({ method: 'GET', url: '/v1/provider/gallery/mine', headers: auth(userId) });
    assert.deepEqual(list.json().data.map((r: any) => r.position), [0, 1]);
    assert.deepEqual(list.json().data.map((r: any) => r.assetId), [a1, a2]);

    // Re-adding the same asset must not duplicate or shift positions.
    const dup = await app.inject({ method: 'POST', url: '/v1/provider/gallery', headers: auth(userId), payload: { assetId: a1 } });
    assert.equal(dup.statusCode, 200);
    assert.equal(dup.json().data.duplicate, true);
    const afterDup = await app.inject({ method: 'GET', url: '/v1/provider/gallery/mine', headers: auth(userId) });
    assert.equal(afterDup.json().data.length, 2);

    const entryId = list.json().data[0].id;
    const del = await app.inject({ method: 'DELETE', url: `/v1/provider/gallery/${entryId}`, headers: auth(userId) });
    assert.equal(del.statusCode, 200);
    const afterDel = await app.inject({ method: 'GET', url: '/v1/provider/gallery/mine', headers: auth(userId) });
    assert.deepEqual(afterDel.json().data.map((r: any) => r.assetId), [a2]);
  });

  it('scopes removal so another provider cannot delete my entry', async () => {
    const owner = await realUser();
    const intruder = await realUser();
    await app.inject({ method: 'POST', url: '/v1/provider/onboarding', headers: auth(owner) });
    await app.inject({ method: 'POST', url: '/v1/provider/onboarding', headers: auth(intruder) });

    const assetId = await cleanAsset();
    const added = await app.inject({ method: 'POST', url: '/v1/provider/gallery', headers: auth(owner), payload: { assetId } });
    const entryId = added.json().data[0].id;

    const denied = await app.inject({ method: 'DELETE', url: `/v1/provider/gallery/${entryId}`, headers: auth(intruder) });
    assert.equal(denied.statusCode, 404);

    const mine = await app.inject({ method: 'GET', url: '/v1/provider/gallery/mine', headers: auth(owner) });
    assert.equal(mine.json().data.length, 1);
  });

  it('lets signed-in members (not anonymous visitors) read a gallery by provider id', async () => {
    const userId = await realUser();
    const onboarded = await app.inject({ method: 'POST', url: '/v1/provider/onboarding', headers: auth(userId) });
    const providerId = onboarded.json().data.id;

    const assetId = await cleanAsset();
    await app.inject({ method: 'POST', url: '/v1/provider/gallery', headers: auth(userId), payload: { assetId } });

    const anon = await app.inject({ method: 'GET', url: `/v1/provider/${providerId}/gallery` });
    assert.equal(anon.statusCode, 401, 'Kendibo is members-only');
    const res = await app.inject({ method: 'GET', url: `/v1/provider/${providerId}/gallery`, headers: auth(await realUser()) });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.length, 1);
    assert.equal(res.json().data[0].assetId, assetId);
  });
});
