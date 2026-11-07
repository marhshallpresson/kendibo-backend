// Provider price lists ("offerings"). Providers set their own prices per
// service; customers book a listed service straight with that provider.
// Commission model: the customer pays the listed price (nothing added); Kendibo
// keeps the trade's commission (category rule, default 15%); the provider gets
// the rest, credited when the customer confirms the job.
import { q } from '../../packages/database/db.js';
import { emit } from '../../packages/observability/emit.js';
import { categoryRulesService } from './category-rules.service.js';

export type PriceUnit = 'job' | 'hour' | 'visit' | 'item';
export interface Offering {
  id: string; providerId: string; categoryId: string; name: string; description: string | null;
  priceKobo: string; priceUnit: PriceUnit; durationMinutes: number | null; active: boolean;
}
export interface Earnings { priceKobo: string; commissionBps: number; commissionKobo: string; vatKobo: string; vatBps: number; providerKobo: string }

const MIN_KOBO = () => BigInt(process.env.MIN_JOB_PRICE_KOBO || '300000');
const toOffering = (r: Record<string, unknown>): Offering => ({
  id: String(r.id), providerId: String(r.provider_id), categoryId: String(r.category_id), name: String(r.name),
  description: (r.description as string) ?? null, priceKobo: String(r.price_kobo), priceUnit: String(r.price_unit) as PriceUnit,
  durationMinutes: r.duration_minutes != null ? Number(r.duration_minutes) : null, active: Boolean(r.active),
});

/** What the provider takes home from a price, under the trade's commission. */
export async function earningsFor(categoryId: string | null, priceKobo: bigint): Promise<Earnings> {
  const bps = categoryId ? (await categoryRulesService.ruleFor(categoryId)).commissionBps : 1500;
  const commission = (priceKobo * BigInt(bps)) / 10000n; // rounded down: the provider never loses a kobo
  const { vatOn, COMMISSION_VAT_BPS } = await import('./vendor-finance.service.js');
  const vat = vatOn(commission); // VAT on Kendibo's commission, from the provider's share
  return { priceKobo: String(priceKobo), commissionBps: bps, commissionKobo: String(commission), vatKobo: String(vat), vatBps: COMMISSION_VAT_BPS(), providerKobo: String(priceKobo - commission - vat) };
}

export const offeringService = {
  async listForProvider(providerId: string, includeInactive = false) {
    const rows = await q<Record<string, unknown>>(
      `SELECT * FROM provider.offering WHERE provider_id=$1 ${includeInactive ? '' : 'AND active'} ORDER BY created_at`, [providerId],
    );
    return Promise.all(rows.map(async (r) => ({ ...toOffering(r), earnings: await earningsFor(String(r.category_id), BigInt(String(r.price_kobo))) })));
  },

  async create(providerId: string, input: { categoryId: string; name: string; description?: string; priceKobo: bigint; priceUnit?: PriceUnit; durationMinutes?: number }) {
    if (input.priceKobo < MIN_KOBO()) throw new Error(`BELOW_MINIMUM:${MIN_KOBO()}`);
    const rows = await q<Record<string, unknown>>(
      `INSERT INTO provider.offering (provider_id, category_id, name, description, price_kobo, price_unit, duration_minutes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [providerId, input.categoryId, input.name.slice(0, 80), input.description?.slice(0, 500) ?? null, String(input.priceKobo), input.priceUnit ?? 'job', input.durationMinutes ?? null],
    );
    emit('offering.created', { providerId, categoryId: input.categoryId });
    const o = toOffering(rows[0]);
    return { ...o, earnings: await earningsFor(o.categoryId, input.priceKobo) };
  },

  async update(providerId: string, id: string, patch: { name?: string; description?: string; priceKobo?: bigint; priceUnit?: PriceUnit; durationMinutes?: number; active?: boolean }) {
    if (patch.priceKobo !== undefined && patch.priceKobo < MIN_KOBO()) throw new Error(`BELOW_MINIMUM:${MIN_KOBO()}`);
    const cur = await q<Record<string, unknown>>(`SELECT * FROM provider.offering WHERE id=$1 AND provider_id=$2`, [id, providerId]);
    if (!cur[0]) throw new Error('NOT_FOUND');
    const c = toOffering(cur[0]);
    const rows = await q<Record<string, unknown>>(
      `UPDATE provider.offering SET name=$3, description=$4, price_kobo=$5, price_unit=$6, duration_minutes=$7, active=$8, updated_at=now()
        WHERE id=$1 AND provider_id=$2 RETURNING *`,
      [id, providerId, (patch.name ?? c.name).slice(0, 80), patch.description ?? c.description, String(patch.priceKobo ?? BigInt(c.priceKobo)),
       patch.priceUnit ?? c.priceUnit, patch.durationMinutes ?? c.durationMinutes, patch.active ?? c.active],
    );
    const o = toOffering(rows[0]);
    return { ...o, earnings: await earningsFor(o.categoryId, BigInt(o.priceKobo)) };
  },

  async get(id: string): Promise<Offering | null> {
    const r = await q<Record<string, unknown>>(`SELECT * FROM provider.offering WHERE id=$1`, [id]);
    return r[0] ? toOffering(r[0]) : null;
  },

  /**
   * Customer books a listed service with that provider: a request priced at the
   * listed amount, offered only to this provider. On accept it becomes a
   * booking at that price (request.service respondOffer, agreed path).
   */
  async book(userId: string, offeringId: string, input: { lat: number; lng: number; addressText?: string; notes?: string; scheduledDate?: string; timeWindow?: string; idempotencyKey: string }) {
    const o = await this.get(offeringId);
    if (!o || !o.active) throw new Error('OFFERING_GONE');
    const { vendorEligibilityService } = await import('./eligibility.service.js');
    if (!(await vendorEligibilityService.allowed(o.providerId, o.categoryId))) throw new Error('PROVIDER_UNAVAILABLE');
    const prior = await q<{ id: string }>(`SELECT id FROM booking.service_request WHERE user_id=$1 AND idempotency_key=$2`, [userId, input.idempotencyKey]);
    if (prior[0]) return { requestId: String(prior[0].id) };
    const rows = await q<{ id: string }>(
      `INSERT INTO booking.service_request
         (user_id, category_id, title, details, urgency, lat, lng, notes, scheduled_date, time_window, idempotency_key, preferred_provider_id, source, status, agreed_kobo, offering_id)
       VALUES ($1,$2,$3,$4,'this_week',$5,$6,$7,$8,$9,$10,$11,'app','OFFERED',$12,$13) RETURNING id`,
      [userId, o.categoryId, o.name, o.description ?? '', input.lat, input.lng,
       [input.addressText, input.notes].filter(Boolean).join(' · ') || null, input.scheduledDate ?? null, input.timeWindow ?? null,
       input.idempotencyKey, o.providerId, o.priceKobo, o.id],
    );
    const requestId = String(rows[0].id);
    const offer = await q<{ id: string }>(`INSERT INTO booking.request_offer (request_id, provider_id, eta_minutes) VALUES ($1,$2,30) RETURNING id`, [requestId, o.providerId]);
    emit('offering.booked', { offeringId, requestId, providerId: o.providerId });
    const phone = await q<{ phone: string | null }>(`SELECT u.phone FROM provider.provider p JOIN identity.users u ON u.id=p.user_id WHERE p.id=$1`, [o.providerId]).catch(() => []);
    if (phone[0]?.phone && offer[0]) {
      const naira = `₦${(Number(o.priceKobo) / 100).toLocaleString('en-NG')}`;
      const { notifyProviderOfOffer } = await import('../whatsapp/whatsapp.bot.js');
      void notifyProviderOfOffer(String(phone[0].phone), String(offer[0].id), `${o.name} at your price of ${naira}`);
    }
    return { requestId, offerId: offer[0] ? String(offer[0].id) : null };
  },
};
