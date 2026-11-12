// Product vendors (migration 052): vendors list home products priced per item;
// customers ask for a quantity; the vendor accepts; the booking price is
// unit x quantity; the invoice shows the quantity line.
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
const idem = () => ({ 'idempotency-key': `idem-${randomUUID()}` });

async function vendor() {
  await q(`UPDATE provider.provider SET online=false`);
  const pu = String((await q<{ id: string }>(`INSERT INTO identity.users (email, name) VALUES ($1,'Ibom Solar Hub') RETURNING id`, [`pro-${randomUUID()}@kendibo.local`]))[0].id);
  const p = await providerService.onboard(pu);
  await providerService.addSkill(p.id, 'hvac');
  await providerService.verifyKyc(p.id);
  await providerService.setOnline(p.id, true, UYO.lat, UYO.lng);
  return { pu, providerId: p.id, token: signAccess(pu, []) };
}
async function customer() {
  const cu = String((await q<{ id: string }>(`INSERT INTO identity.users (email, name) VALUES ($1,'Ada') RETURNING id`, [`cust-${randomUUID()}@kendibo.local`]))[0].id);
  return { cu, token: signAccess(cu, ['booking:create', 'booking:view:self', 'booking:cancel']) };
}
async function photo(ownerUserId: string) {
  const id = `med_${randomUUID().slice(0, 12)}`;
  await q(`INSERT INTO media.asset (id, folder, status, mime, owner_user_id) VALUES ($1,'photos','clean','image/jpeg',$2)`, [id, ownerUserId]);
  return id;
}

describe('product vendors', () => {
  it('lists products with the right category/unit, orders a quantity, books the total, invoices the quantity line', async () => {
    const v = await vendor();
    const c = await customer();
    const post = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/v1/provider/offerings', headers: bearer(v.token), payload });

    // A product needs a product category and per-item pricing.
    let r = await post({ kind: 'product', categoryId: 'ac', name: 'Lithium battery 200Ah', priceKobo: 45000000 });
    assert.equal(r.statusCode, 400, r.body);
    assert.equal(r.json().error?.code ?? r.json().code, 'KIND_MISMATCH');
    assert.match(r.body, /Home Products category/);
    r = await post({ kind: 'product', categoryId: 'prod-solar-equipment', name: 'Lithium battery 200Ah', priceKobo: 45000000, priceUnit: 'job' });
    assert.equal(r.statusCode, 400, r.body);
    assert.match(r.body, /per item/);
    // A service refuses a product category.
    r = await post({ categoryId: 'prod-solar-equipment', name: 'Inverter install', priceKobo: 2000000 });
    assert.equal(r.statusCode, 400, r.body);
    assert.match(r.body, /product category/);
    // The photo must be the vendor's own upload.
    const stranger = String((await q<{ id: string }>(`INSERT INTO identity.users (email, name) VALUES ($1,'X') RETURNING id`, [`x-${randomUUID()}@kendibo.local`]))[0].id);
    r = await post({ kind: 'product', categoryId: 'prod-solar-equipment', name: 'Lithium battery 200Ah', priceKobo: 45000000, photoAssetId: await photo(stranger) });
    assert.equal(r.statusCode, 400, r.body);
    assert.match(r.body, /ASSET_NOT_FOUND/);
    r = await post({ kind: 'product', categoryId: 'prod-solar-equipment', name: 'Lithium battery 200Ah', priceKobo: 45000000, maxQuantity: 1001 });
    assert.equal(r.statusCode, 400, 'max quantity capped at 1000');

    const photoId = await photo(v.pu);
    r = await post({ kind: 'product', categoryId: 'prod-solar-equipment', name: 'Lithium battery 200Ah', priceKobo: 45000000, stockNote: 'In stock', photoAssetId: photoId, maxQuantity: 5 });
    assert.equal(r.statusCode, 200, r.body);
    const product = r.json().data;
    assert.equal(product.kind, 'product');
    assert.equal(product.priceUnit, 'item', 'products default to per-item pricing');
    assert.equal(product.maxQuantity, 5);
    const svc = await post({ categoryId: 'ac', name: 'AC general service', priceKobo: 2000000 });
    assert.equal(svc.statusCode, 200, svc.body);
    assert.equal(svc.json().data.kind, 'service');
    assert.equal(svc.json().data.maxQuantity, null);
    // Default max quantity is 20.
    const soap = await post({ kind: 'product', categoryId: 'prod-cleaning-supplies', name: 'Liquid soap 4L', priceKobo: 350000 });
    assert.equal(soap.statusCode, 200, soap.body);
    assert.equal(soap.json().data.maxQuantity, 20);

    // Customer listing: kind, stock note, signed photo URL; ?kind= filters.
    let list = await app.inject({ method: 'GET', url: `/v1/providers/${v.providerId}/offerings?kind=product`, headers: bearer(c.token) });
    assert.equal(list.statusCode, 200, list.body);
    const rows = list.json().data as any[];
    assert.equal(rows.length, 2);
    assert.ok(rows.every((o) => o.kind === 'product'));
    const battery = rows.find((o) => o.id === product.id);
    assert.equal(battery.stockNote, 'In stock');
    assert.equal(battery.photoAssetId, photoId);
    assert.match(String(battery.photoUrl), new RegExp(photoId), 'signed photo URL');
    assert.equal(battery.earnings, undefined, 'customers do not see the split');
    list = await app.inject({ method: 'GET', url: `/v1/providers/${v.providerId}/offerings?kind=service`, headers: bearer(c.token) });
    assert.deepEqual(list.json().data.map((o: any) => o.kind), ['service']);

    // Quantity above the vendor's max is refused.
    const book = (id: string, payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: `/v1/offerings/${id}/book`, headers: { ...bearer(c.token), ...idem() }, payload: { ...UYO, addressText: '12 Aka Road, Uyo', ...payload } });
    r = await book(product.id, { quantity: 6 });
    assert.equal(r.statusCode, 400, r.body);
    assert.match(r.body, /1 to 5/);
    r = await book(product.id, { quantity: 0 });
    assert.equal(r.statusCode, 400, r.body);

    // Order 3: agreed = 3 x unit, quantity and unit price stored.
    r = await book(product.id, { quantity: 3 });
    assert.equal(r.statusCode, 200, r.body);
    const { requestId, offerId, agreedKobo } = r.json().data;
    assert.equal(agreedKobo, String(3n * 45000000n));
    const sr = await q<{ agreed_kobo: string; quantity: number; unit_price_kobo: string }>(`SELECT agreed_kobo, quantity, unit_price_kobo FROM booking.service_request WHERE id=$1`, [requestId]);
    assert.equal(String(sr[0].agreed_kobo), '135000000');
    assert.equal(Number(sr[0].quantity), 3);
    assert.equal(String(sr[0].unit_price_kobo), '45000000');

    // Vendor's WhatsApp offer text.
    const { offerSummary } = await import('../modules/vendors/offering.service.js');
    assert.equal(offerSummary({ name: 'Lithium battery 200Ah', kind: 'product', priceKobo: '45000000' }, 3),
      '3 × Lithium battery 200Ah at your price of ₦450,000 each (₦1,350,000 total)');
    assert.equal(offerSummary({ name: 'AC general service', kind: 'service', priceKobo: '2000000' }, 3), 'AC general service at your price of ₦20,000');

    // Vendor accepts: the booking price is the total.
    const acc = await app.inject({ method: 'POST', url: `/v1/provider/requests/${offerId}/respond`, headers: bearer(v.token), payload: { accept: true } });
    assert.equal(acc.statusCode, 200, acc.body);
    const bookingId = String(acc.json().data.bookingId);
    const b = await q<{ price_kobo: string }>(`SELECT price_kobo FROM booking.booking WHERE id=$1`, [bookingId]);
    assert.equal(String(b[0].price_kobo), '135000000', 'booked at unit x quantity');

    // Paid (escrow) -> the final invoice shows the quantity line; totals unchanged.
    await q(`INSERT INTO payment.payment (booking_id, psp, reference, charge_id, amount_kobo, status) VALUES ($1,'bachs',$2,$2,135000000,'successful')`, [bookingId, `bk_${bookingId}_t`]);
    const { issueInvoice } = await import('../modules/invoices/invoice.service.js');
    const inv = await issueInvoice(bookingId, 'final');
    assert.ok(inv, 'final invoice issued');
    assert.equal(inv!.data.lines[0].label, '3 × Lithium battery 200Ah @ ₦450,000 = ₦1,350,000');
    assert.equal(inv!.data.lines[0].amountKobo, '135000000');
    assert.equal(inv!.data.totalKobo, '135000000');

    // Below the product order minimum (₦1,000) is refused.
    const cheap = await post({ kind: 'product', categoryId: 'prod-cleaning-supplies', name: 'Sponge', priceKobo: 30000 });
    assert.equal(cheap.statusCode, 200, cheap.body);
    r = await book(cheap.json().data.id, { quantity: 2 });
    assert.equal(r.statusCode, 400, r.body);
    assert.match(r.body, /BELOW_ORDER_MINIMUM/);
    r = await book(cheap.json().data.id, { quantity: 4 });
    assert.equal(r.statusCode, 200, r.body);
  });

  it('services ignore quantity', async () => {
    const v = await vendor();
    const c = await customer();
    const svc = await app.inject({ method: 'POST', url: '/v1/provider/offerings', headers: bearer(v.token), payload: { categoryId: 'ac', name: 'AC general service', priceKobo: 2000000 } });
    assert.equal(svc.statusCode, 200, svc.body);
    const r = await app.inject({ method: 'POST', url: `/v1/offerings/${svc.json().data.id}/book`, headers: { ...bearer(c.token), ...idem() }, payload: { ...UYO, quantity: 7 } });
    assert.equal(r.statusCode, 200, r.body);
    const sr = await q<{ agreed_kobo: string; quantity: number }>(`SELECT agreed_kobo, quantity FROM booking.service_request WHERE id=$1`, [r.json().data.requestId]);
    assert.equal(String(sr[0].agreed_kobo), '2000000');
    assert.equal(Number(sr[0].quantity), 1);
    const acc = await app.inject({ method: 'POST', url: `/v1/provider/requests/${r.json().data.offerId}/respond`, headers: bearer(v.token), payload: { accept: true } });
    assert.equal(acc.statusCode, 200, acc.body);
    const bookingId = String(acc.json().data.bookingId);
    await q(`INSERT INTO payment.payment (booking_id, psp, reference, charge_id, amount_kobo, status) VALUES ($1,'bachs',$2,$2,2000000,'successful')`, [bookingId, `bk_${bookingId}_t`]);
    const { issueInvoice } = await import('../modules/invoices/invoice.service.js');
    const inv = await issueInvoice(bookingId, 'final');
    assert.doesNotMatch(inv!.data.lines[0].label, /×/, 'service line has no quantity');
    // Storefront payload lists products separately (none for this vendor).
    const { storefrontService } = await import('../modules/storefront/storefront.service.js');
    const sf = await storefrontService.publicView(v.providerId);
    assert.deepEqual(sf?.products, []);
  });

  it('storefront includes products as their own list', async () => {
    const v = await vendor();
    const r = await app.inject({ method: 'POST', url: '/v1/provider/offerings', headers: bearer(v.token), payload: { kind: 'product', categoryId: 'prod-plumbing-materials', name: 'PVC pipe 1 inch', priceKobo: 250000, stockNote: '2–3 days' } });
    assert.equal(r.statusCode, 200, r.body);
    await app.inject({ method: 'POST', url: '/v1/provider/offerings', headers: bearer(v.token), payload: { categoryId: 'plumbing', name: 'Fix a leak', priceKobo: 500000 } });
    const { storefrontService } = await import('../modules/storefront/storefront.service.js');
    const sf = await storefrontService.publicView(v.providerId);
    assert.equal(sf?.products.length, 1);
    assert.equal(sf?.products[0].name, 'PVC pipe 1 inch');
    assert.equal(sf?.products[0].stockNote, '2–3 days');
    assert.equal((sf?.products[0] as Record<string, unknown>).earnings, undefined);
  });
});
