// The public storefront gives the app a signed link for the vendor's logo and
// cover (like offering photos), or null when none is set.
import 'dotenv/config';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { providerService } from '../modules/providers/provider.service.js';
import { q } from '../packages/database/db.js';

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

async function vendor() {
  const pu = String((await q<{ id: string }>(`INSERT INTO identity.users (email, name) VALUES ($1,'Blizzit Solar') RETURNING id`, [`pro-${randomUUID()}@kendibo.local`]))[0].id);
  const p = await providerService.onboard(pu);
  await providerService.addSkill(p.id, 'hvac');
  await providerService.verifyKyc(p.id);
  await providerService.setOnline(p.id, true, 6.45, 3.4);
  await q(`UPDATE provider.provider SET slug=$2, storefront_published=true WHERE id=$1`, [p.id, `sf-${randomUUID().slice(0, 8)}`]);
  return p.id;
}

describe('public storefront logo', () => {
  it('is null without a logo and a signed link once one is set', async () => {
    const id = await vendor();
    let r = await app.inject({ method: 'GET', url: `/v1/providers/${id}/storefront` });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().data.logoUrl, null);
    assert.equal(r.json().data.coverUrl, null);

    const assetId = randomUUID();
    await q(`UPDATE provider.provider SET logo_asset_id=$2 WHERE id=$1`, [id, assetId]);
    r = await app.inject({ method: 'GET', url: `/v1/providers/${id}/storefront` });
    const url = String(r.json().data.logoUrl);
    assert.ok(url.includes(assetId), `signed link for the logo asset: ${url}`);
  });
});
