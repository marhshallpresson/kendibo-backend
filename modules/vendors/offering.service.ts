// Provider price lists ("offerings"). Providers set their own prices per
// service; customers book a listed service straight with that provider.
// Commission model: the customer pays the listed price (nothing added); Kendibo
// keeps the trade's commission (category rule, default 15%); the provider gets
// the rest, credited when the customer confirms the job.
//
// Product vendors (migration 052): an offering with kind='product' is a home
// product priced per item (category kind 'product', price_unit 'item'). The
// customer asks for a quantity; the vendor accepts; the agreed price is unit x
// quantity, and payment, escrow, settlement and commission work as for services.
import { q } from '../../packages/database/db.js';
import { emit } from '../../packages/observability/emit.js';
import { categoryRulesService } from './category-rules.service.js';

export type PriceUnit = 'job' | 'hour' | 'visit' | 'item';
export type OfferingKind = 'service' | 'product';
export interface Offering {
  id: string; providerId: string; categoryId: string; name: string; description: string | null;
  priceKobo: string; priceUnit: PriceUnit; durationMinutes: number | null; active: boolean;
  kind: OfferingKind; stockNote: string | null; photoAssetId: string | null; maxQuantity: number | null;
}
export interface OfferingInput {
  categoryId: string; name: string; description?: string; priceKobo: bigint; priceUnit?: PriceUnit; durationMinutes?: number;
  kind?: OfferingKind; stockNote?: string | null; photoAssetId?: string | null; maxQuantity?: number;
}
export interface Earnings { priceKobo: string; commissionBps: number; commissionKobo: string; vatKobo: string; vatBps: number; providerKobo: string }

const MIN_KOBO = () => BigInt(process.env.MIN_JOB_PRICE_KOBO || '300000');
/** Smallest product order (unit price x quantity), default ₦1,000. */
export const PRODUCT_MIN_ORDER_KOBO = () => BigInt(process.env.PRODUCT_MIN_ORDER_KOBO || '100000');
export const DEFAULT_MAX_QUANTITY = 20;
export const MAX_QUANTITY_CAP = 1000;

const toOffering = (r: Record<string, unknown>): Offering => ({
  id: String(r.id), providerId: String(r.provider_id), categoryId: String(r.category_id), name: String(r.name),
  description: (r.description as string) ?? null, priceKobo: String(r.price_kobo), priceUnit: String(r.price_unit) as PriceUnit,
  durationMinutes: r.duration_minutes != null ? Number(r.duration_minutes) : null, active: Boolean(r.active),
  kind: r.kind === 'product' ? 'product' : 'service',
  stockNote: r.stock_note != null ? String(r.stock_note) : null,
  photoAssetId: r.photo_asset_id != null ? String(r.photo_asset_id) : null,
  maxQuantity: r.kind === 'product' ? Number(r.max_quantity ?? DEFAULT_MAX_QUANTITY) : null,
});

const nairaText = (kobo: bigint | string) => `₦${(Number(kobo) / 100).toLocaleString('en-NG')}`;

/** The vendor's offer line, e.g. "3 × Lithium battery 200Ah at your price of ₦X each (₦Y total)". */
export function offerSummary(o: Pick<Offering, 'name' | 'kind' | 'priceKobo'>, quantity = 1): string {
  if (o.kind !== 'product') return `${o.name} at your price of ${nairaText(o.priceKobo)}`;
  const total = BigInt(o.priceKobo) * BigInt(quantity);
  return `${quantity} × ${o.name} at your price of ${nairaText(o.priceKobo)} each (${nairaText(total)} total)`;
}

/** Signed, short-lived (1h) photo link, or null. */
async function photoUrl(assetId: string | null): Promise<string | null> {
  if (!assetId) return null;
  const { objectStore } = await import('../../packages/storage/object.store.js');
  return objectStore.signedUrl(assetId, 3600).catch(() => null);
}
export async function withPhotoUrl<T extends Offering>(o: T): Promise<T & { photoUrl: string | null }> {
  return { ...o, photoUrl: await photoUrl(o.photoAssetId) };
}

/**
 * The provider owns the asset: a clean image they uploaded (media.asset
 * owner_user_id, migration 052) or, for uploads made before ownership was
 * recorded, one already in their own gallery or storefront branding.
 */
async function assetOwnedBy(assetId: string, providerId: string): Promise<boolean> {
  const a = await q<{ status: string; mime: string | null; owner_user_id: string | null }>(
    `SELECT status, mime, owner_user_id FROM media.asset WHERE id=$1`, [assetId],
  );
  if (!a[0] || String(a[0].status) !== 'clean') return false;
  if (a[0].mime && !String(a[0].mime).startsWith('image/')) return false;
  const p = await q<{ user_id: string; logo_asset_id: string | null; cover_asset_id: string | null }>(
    `SELECT user_id, logo_asset_id, cover_asset_id FROM provider.provider WHERE id=$1`, [providerId],
  );
  if (!p[0]) return false;
  if (a[0].owner_user_id) return String(a[0].owner_user_id) === String(p[0].user_id);
  if ([p[0].logo_asset_id, p[0].cover_asset_id].some((x) => x && String(x) === assetId)) return true;
  const g = await q(`SELECT 1 FROM provider.gallery WHERE provider_id=$1 AND asset_id=$2`, [providerId, assetId]).catch(() => []);
  return !!g[0];
}

/** Category kind must match the offering kind; products are sold per item. */
async function checkShape(s: { categoryId: string; kind: OfferingKind; priceUnit: PriceUnit; priceKobo: bigint; maxQuantity: number | null }) {
  const cat = await q<{ kind: string | null }>(`SELECT kind FROM catalog.category WHERE id=$1`, [s.categoryId]);
  if (!cat[0]) throw new Error('BAD_CATEGORY');
  const catKind: OfferingKind = cat[0].kind === 'product' ? 'product' : 'service';
  if (s.kind === 'product' && catKind !== 'product') throw new Error('KIND_MISMATCH:A product must be listed under a Home Products category.');
  if (s.kind === 'service' && catKind !== 'service') throw new Error('KIND_MISMATCH:This is a product category. List it as a product (kind "product", priced per item).');
  if (s.kind === 'product' && s.priceUnit !== 'item') throw new Error('KIND_MISMATCH:Products are priced per item (priceUnit "item").');
  if (s.priceKobo <= 0n) throw new Error('BAD_PRICE');
  // Service minimum applies to services only; products have an order minimum at booking.
  if (s.kind === 'service' && s.priceKobo < MIN_KOBO()) throw new Error(`BELOW_MINIMUM:${MIN_KOBO()}`);
  if (s.maxQuantity != null && (!Number.isInteger(s.maxQuantity) || s.maxQuantity < 1 || s.maxQuantity > MAX_QUANTITY_CAP)) throw new Error('BAD_MAX_QUANTITY');
}

/** What the provider takes home from a price, under the trade's commission. */
export async function earningsFor(categoryId: string | null, priceKobo: bigint, providerId?: string): Promise<Earnings> {
  let bps = categoryId ? (await categoryRulesService.ruleFor(categoryId)).commissionBps : 1500;
  // Kendibo Pro / Tier 3 pay a lower commission (same rule as settlement).
  if (providerId) {
    const { tierService } = await import('../tiers/tier.service.js');
    bps = await tierService.commissionBpsFor(providerId, bps).catch(() => bps);
  }
  const commission = (priceKobo * BigInt(bps)) / 10000n; // rounded down: the provider never loses a kobo
  const { vatOn, COMMISSION_VAT_BPS } = await import('./vendor-finance.service.js');
  const vat = vatOn(commission); // VAT on Kendibo's commission, from the provider's share
  return { priceKobo: String(priceKobo), commissionBps: bps, commissionKobo: String(commission), vatKobo: String(vat), vatBps: COMMISSION_VAT_BPS(), providerKobo: String(priceKobo - commission - vat) };
}

export const offeringService = {
  async listForProvider(providerId: string, includeInactive = false, kind?: OfferingKind) {
    const rows = await q<Record<string, unknown>>(
      `SELECT * FROM provider.offering WHERE provider_id=$1 ${includeInactive ? '' : 'AND active'} ORDER BY created_at`, [providerId],
    );
    const picked = rows.map(toOffering).filter((o) => !kind || o.kind === kind);
    return Promise.all(picked.map(async (o) => ({ ...(await withPhotoUrl(o)), earnings: await earningsFor(o.categoryId, BigInt(o.priceKobo), providerId) })));
  },

  /** Product listings are capped by tier (enforced with vendor eligibility). */
  async checkListingCap(providerId: string, ignoreId?: string) {
    const { eligibilityEnforced } = await import('./eligibility.service.js');
    if (!eligibilityEnforced()) return;
    const { tierService } = await import('../tiers/tier.service.js');
    const max = await tierService.maxListings(providerId);
    if (max === null) return;
    const rows = await q<{ id: string }>(`SELECT id FROM provider.offering WHERE provider_id=$1 AND active AND kind='product'`, [providerId]);
    if (rows.filter((r) => String(r.id) !== ignoreId).length >= max) throw new Error(`LISTING_LIMIT:${max}`);
  },

  async create(providerId: string, input: OfferingInput) {
    const kind: OfferingKind = input.kind ?? 'service';
    const priceUnit: PriceUnit = input.priceUnit ?? (kind === 'product' ? 'item' : 'job');
    const maxQuantity = kind === 'product' ? (input.maxQuantity ?? DEFAULT_MAX_QUANTITY) : null;
    const photoAssetId = input.photoAssetId ?? null;
    await checkShape({ categoryId: input.categoryId, kind, priceUnit, priceKobo: input.priceKobo, maxQuantity });
    if (photoAssetId && !(await assetOwnedBy(photoAssetId, providerId))) throw new Error('ASSET_NOT_FOUND');
    if (kind === 'product') await this.checkListingCap(providerId);
    const rows = await q<Record<string, unknown>>(
      `INSERT INTO provider.offering (provider_id, category_id, name, description, price_kobo, price_unit, duration_minutes, kind, stock_note, photo_asset_id, max_quantity)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [providerId, input.categoryId, input.name.slice(0, 80), input.description?.slice(0, 500) ?? null, String(input.priceKobo), priceUnit, input.durationMinutes ?? null,
       kind, input.stockNote?.slice(0, 60) ?? null, photoAssetId, maxQuantity],
    );
    emit('offering.created', { providerId, categoryId: input.categoryId, kind });
    const o = toOffering(rows[0]);
    return { ...(await withPhotoUrl(o)), earnings: await earningsFor(o.categoryId, input.priceKobo, providerId) };
  },

  async update(providerId: string, id: string, patch: {
    name?: string; description?: string; priceKobo?: bigint; priceUnit?: PriceUnit; durationMinutes?: number; active?: boolean;
    kind?: OfferingKind; stockNote?: string | null; photoAssetId?: string | null; maxQuantity?: number;
  }) {
    const cur = await q<Record<string, unknown>>(`SELECT * FROM provider.offering WHERE id=$1 AND provider_id=$2`, [id, providerId]);
    if (!cur[0]) throw new Error('NOT_FOUND');
    const c = toOffering(cur[0]);
    const kind = patch.kind ?? c.kind;
    const priceUnit: PriceUnit = patch.priceUnit ?? (patch.kind === 'product' && c.kind !== 'product' ? 'item' : c.priceUnit);
    const priceKobo = patch.priceKobo ?? BigInt(c.priceKobo);
    const maxQuantity = kind === 'product' ? (patch.maxQuantity ?? c.maxQuantity ?? DEFAULT_MAX_QUANTITY) : null;
    const photoAssetId = patch.photoAssetId !== undefined ? patch.photoAssetId : c.photoAssetId;
    // Re-check the shape only when it changes, so an older listing can still be paused or renamed.
    if (patch.kind !== undefined || patch.priceUnit !== undefined || patch.priceKobo !== undefined || patch.maxQuantity !== undefined) {
      await checkShape({ categoryId: c.categoryId, kind, priceUnit, priceKobo, maxQuantity });
    }
    if (patch.photoAssetId && patch.photoAssetId !== c.photoAssetId && !(await assetOwnedBy(patch.photoAssetId, providerId))) throw new Error('ASSET_NOT_FOUND');
    // Re-listing (or turning a service into a product) counts against the tier's listing cap.
    if (kind === 'product' && (patch.active ?? c.active) && (!c.active || c.kind !== 'product')) await this.checkListingCap(providerId, id);
    const rows = await q<Record<string, unknown>>(
      `UPDATE provider.offering SET name=$3, description=$4, price_kobo=$5, price_unit=$6, duration_minutes=$7, active=$8,
              kind=$9, stock_note=$10, photo_asset_id=$11, max_quantity=$12, updated_at=now()
        WHERE id=$1 AND provider_id=$2 RETURNING *`,
      [id, providerId, (patch.name ?? c.name).slice(0, 80), patch.description ?? c.description, String(priceKobo),
       priceUnit, patch.durationMinutes ?? c.durationMinutes, patch.active ?? c.active,
       kind, patch.stockNote !== undefined ? (patch.stockNote?.slice(0, 60) ?? null) : c.stockNote, photoAssetId, maxQuantity],
    );
    const o = toOffering(rows[0]);
    return { ...(await withPhotoUrl(o)), earnings: await earningsFor(o.categoryId, BigInt(o.priceKobo), providerId) };
  },

  async get(id: string): Promise<Offering | null> {
    const r = await q<Record<string, unknown>>(`SELECT * FROM provider.offering WHERE id=$1`, [id]);
    return r[0] ? toOffering(r[0]) : null;
  },

  /**
   * Customer books a listed service (or orders a quantity of a product) with
   * that provider: a request priced at the listed amount (unit x quantity for
   * products), offered only to this provider. On accept it becomes a booking at
   * that price (request.service respondOffer, agreed path).
   */
  async book(userId: string, offeringId: string, input: { lat: number; lng: number; addressText?: string; notes?: string; scheduledDate?: string; timeWindow?: string; idempotencyKey: string; quantity?: number }) {
    const o = await this.get(offeringId);
    if (!o || !o.active) throw new Error('OFFERING_GONE');
    // Products: the customer asks for a quantity (1..max); services ignore it.
    const quantity = o.kind === 'product' ? (input.quantity ?? 1) : 1;
    const maxQ = o.maxQuantity ?? DEFAULT_MAX_QUANTITY;
    if (o.kind === 'product' && (!Number.isInteger(quantity) || quantity < 1 || quantity > maxQ)) throw new Error(`QUANTITY_RANGE:${maxQ}`);
    const unitKobo = BigInt(o.priceKobo);
    const totalKobo = unitKobo * BigInt(quantity);
    if (o.kind === 'product' && totalKobo < PRODUCT_MIN_ORDER_KOBO()) throw new Error(`BELOW_ORDER_MINIMUM:${PRODUCT_MIN_ORDER_KOBO()}`);
    const { vendorEligibilityService } = await import('./eligibility.service.js');
    // The order total must fit the vendor's per-job tier cap.
    if (!(await vendorEligibilityService.allowed(o.providerId, o.categoryId, { amountKobo: totalKobo }))) throw new Error('PROVIDER_UNAVAILABLE');
    const prior = await q<{ id: string }>(`SELECT id FROM booking.service_request WHERE user_id=$1 AND idempotency_key=$2`, [userId, input.idempotencyKey]);
    if (prior[0]) return { requestId: String(prior[0].id) };
    const rows = await q<{ id: string }>(
      `INSERT INTO booking.service_request
         (user_id, category_id, title, details, urgency, lat, lng, notes, scheduled_date, time_window, idempotency_key, preferred_provider_id, source, status, agreed_kobo, offering_id, quantity, unit_price_kobo)
       VALUES ($1,$2,$3,$4,'this_week',$5,$6,$7,$8,$9,$10,$11,'app','OFFERED',$12,$13,$14,$15) RETURNING id`,
      [userId, o.categoryId, o.name, o.description ?? '', input.lat, input.lng,
       [input.addressText, input.notes].filter(Boolean).join(' · ') || null, input.scheduledDate ?? null, input.timeWindow ?? null,
       input.idempotencyKey, o.providerId, String(totalKobo), o.id, quantity, String(unitKobo)],
    );
    const requestId = String(rows[0].id);
    const offer = await q<{ id: string }>(`INSERT INTO booking.request_offer (request_id, provider_id, eta_minutes) VALUES ($1,$2,30) RETURNING id`, [requestId, o.providerId]);
    emit('offering.booked', { offeringId, requestId, providerId: o.providerId, kind: o.kind, quantity });
    const phone = await q<{ phone: string | null }>(`SELECT u.phone FROM provider.provider p JOIN identity.users u ON u.id=p.user_id WHERE p.id=$1`, [o.providerId]).catch(() => []);
    if (phone[0]?.phone && offer[0]) {
      const { notifyProviderOfOffer } = await import('../whatsapp/whatsapp.bot.js');
      void notifyProviderOfOffer(String(phone[0].phone), String(offer[0].id), offerSummary(o, quantity), o.kind === 'product' ? 'New order' : undefined);
    }
    return { requestId, offerId: offer[0] ? String(offer[0].id) : null, quantity, unitPriceKobo: String(unitKobo), agreedKobo: String(totalKobo) };
  },
};
