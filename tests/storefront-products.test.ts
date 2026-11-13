// Storefront products: the public /s/<slug> page lists the vendor's active
// product offerings (kind='product', migration 052) with price per item and
// stock note, HTML-escaping every user value.
import 'dotenv/config';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { providerService } from '../modules/providers/provider.service.js';
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

const UYO = { lat: 5.0377, lng: 7.9128 };
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function publishedVendor(slug: string) {
  await q(`UPDATE provider.provider SET online=false`);
  const pu = String((await q<{ id: string }>(`INSERT INTO identity.users (email, name) VALUES ($1,'Ibom Solar Hub') RETURNING id`, [`pro-${randomUUID()}@kendibo.local`]))[0].id);
  const p = await providerService.onboard(pu);
  await providerService.addSkill(p.id, 'hvac');
  await providerService.verifyKyc(p.id);
  await providerService.setOnline(p.id, true, UYO.lat, UYO.lng);
  await q(`UPDATE provider.provider SET slug=$2, storefront_published=true WHERE id=$1`, [p.id, slug]);
  return { pu, providerId: p.id, token: signAccess(pu, []) };
}

describe('storefront products', () => {
  it('lists active product offerings on the public storefront page, escaped', async () => {
    const slug = `sf-${randomUUID().slice(0, 8)}`;
    const v = await publishedVendor(slug);
    const post = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/v1/provider/offerings', headers: bearer(v.token), payload });

    let r = await post({ kind: 'product', categoryId: 'prod-solar-equipment', name: 'Battery <Pro> & Co', priceKobo: 45000000, stockNote: 'In stock: 3 left' });
    assert.equal(r.statusCode, 200, r.body);
    const product = r.json().data;

    const page = await app.inject({ method: 'GET', url: `/s/${slug}`, headers: {} });
    assert.equal(page.statusCode, 200, page.body);
    assert.match(page.body, /<h2[^>]*>Products<\/h2>/);
    assert.ok(page.body.includes('Battery &lt;Pro&gt; &amp; Co'), 'product name is HTML-escaped');
    assert.ok(!page.body.includes('Battery <Pro>'), 'raw product name never reaches the page');
    assert.ok(page.body.includes('₦450,000.00 per item'), 'price per item is shown');
    assert.ok(page.body.includes('In stock: 3 left'), 'stock note is shown');

    // An inactive product no longer appears.
    await q(`UPDATE provider.offering SET active=false WHERE id=$1`, [product.id]);
    const after2 = await app.inject({ method: 'GET', url: `/s/${slug}`, headers: {} });
    assert.ok(!after2.body.includes('Battery &lt;Pro&gt;'), 'inactive product hidden');
    assert.ok(!after2.body.includes('>Products</h2>'), 'empty products section hidden');
  });
});
