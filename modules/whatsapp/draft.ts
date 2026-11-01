// The job a WhatsApp customer is describing, one row per request in progress
// (messaging.whatsapp_job_draft). Both the step-by-step flow and the AI
// fallback read and write it here, so whichever answered last, the next turn
// picks up from the same server-side state.
import { q } from '../../packages/database/db.js';
import { emit } from '../../packages/observability/emit.js';
import { wa } from './whatsapp.client.js';
import { vendorsLink } from './links.js';
import { WINDOW_HOURS, type TimeWindow } from './nlu/entities.js';

export interface Draft {
  id: string; need: string | null; category_id: string | null; service_id: string | null; budget_kobo: string | null;
  photo_asset_ids: string[]; lat: number | null; lng: number | null; address_text: string | null; landmark: string | null;
  scheduled_date: string | null; time_window: TimeWindow | null; request_id: string | null;
  /** Set when the client came from a vendor's storefront (KB-<slug>): that vendor gets the job first. */
  preferred_provider_id?: string | null;
}

/**
 * A DATE column as YYYY-MM-DD. node-pg returns it as a Date at local midnight,
 * pg-mem as a Date at UTC midnight, and String(date) would give "Sun Nov 01".
 */
export function isoDay(v: unknown): string | null {
  if (v == null || v === '') return null;
  if (!(v instanceof Date)) return String(v).slice(0, 10);
  if (Number.isNaN(v.getTime())) return null;
  const local = v.getHours() === 0 && v.getMinutes() === 0;
  const y = local ? v.getFullYear() : v.getUTCFullYear();
  const m = (local ? v.getMonth() : v.getUTCMonth()) + 1;
  const d = local ? v.getDate() : v.getUTCDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const toDraft = (r: Record<string, unknown>): Draft => ({
  id: String(r.id), need: (r.need as string) ?? null, category_id: (r.category_id as string) ?? null, service_id: (r.service_id as string) ?? null,
  budget_kobo: r.budget_kobo != null ? String(r.budget_kobo) : null,
  photo_asset_ids: (typeof r.photo_asset_ids === 'string' ? JSON.parse(r.photo_asset_ids) : (r.photo_asset_ids ?? [])) as string[],
  lat: r.lat != null ? Number(r.lat) : null, lng: r.lng != null ? Number(r.lng) : null,
  address_text: (r.address_text as string) ?? null, landmark: (r.landmark as string) ?? null,
  scheduled_date: isoDay(r.scheduled_date),
  time_window: (r.time_window as TimeWindow) ?? null,
  request_id: r.request_id ? String(r.request_id) : null,
  preferred_provider_id: r.preferred_provider_id ? String(r.preferred_provider_id) : null,
});

/** The open draft for this number, if any. */
export async function currentDraft(waId: string): Promise<Draft | null> {
  const rows = await q<Record<string, unknown>>(
    `SELECT * FROM messaging.whatsapp_job_draft WHERE wa_id=$1 AND status='collecting' ORDER BY created_at DESC LIMIT 1`, [waId],
  );
  return rows[0] ? toDraft(rows[0]) : null;
}

export async function openDraft(waId: string, userId: string): Promise<Draft> {
  const cur = await currentDraft(waId);
  if (cur) return cur;
  const rows = await q<Record<string, unknown>>(`INSERT INTO messaging.whatsapp_job_draft (wa_id, user_id) VALUES ($1,$2) RETURNING *`, [waId, userId]);
  return toDraft(rows[0]);
}

const COLUMNS = new Set(['need', 'category_id', 'service_id', 'budget_kobo', 'photo_asset_ids', 'lat', 'lng', 'address_text', 'landmark', 'scheduled_date', 'time_window', 'status', 'request_id', 'preferred_provider_id']);

export async function patchDraft(id: string, patch: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(patch).filter((k) => COLUMNS.has(k));
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(', ');
  await q(`UPDATE messaging.whatsapp_job_draft SET ${sets}, updated_at=now() WHERE id=$1`, [id, ...keys.map((k) => patch[k])]);
}

export const missingFields = (d: Draft) => [
  !d.need && 'need', !d.category_id && 'trade', (d.lat == null || d.lng == null) && 'location', !d.scheduled_date && 'day', !d.time_window && 'time_window',
].filter(Boolean) as string[];

export async function addPhotoToDraft(waId: string, userId: string, assetId: string): Promise<Draft> {
  const d = await openDraft(waId, userId);
  const ids = [...new Set([...d.photo_asset_ids, assetId])].slice(0, 6);
  await patchDraft(d.id, { photo_asset_ids: JSON.stringify(ids) });
  return { ...d, photo_asset_ids: ids };
}

/** Called by the map page (or a shared WhatsApp location) once a spot is chosen. */
export async function saveDraftLocation(waId: string, draftId: string, loc: { lat: number; lng: number; address: string; landmark?: string }): Promise<void> {
  const rows = await q<{ id: string }>(`SELECT id FROM messaging.whatsapp_job_draft WHERE id=$1 AND wa_id=$2 AND status='collecting'`, [draftId, waId]);
  if (!rows[0]) throw new Error('DRAFT_GONE');
  await patchDraft(draftId, { lat: loc.lat, lng: loc.lng, address_text: loc.address.slice(0, 200), landmark: (loc.landmark ?? '').slice(0, 120) || null });
}

export async function cancelDraft(id: string): Promise<void> {
  await patchDraft(id, { status: 'cancelled' });
}

/**
 * Turn the draft into a service request, rank nearby verified vendors with
 * our matching model, and send the "See vendors" button. Idempotent per draft.
 */
export async function submitDraft(waId: string, userId: string, d: Draft): Promise<{ requestId: string; vendors: number }> {
  const miss = missingFields(d).filter((m) => m === 'need' || m === 'trade' || m === 'location');
  if (miss.length) throw Object.assign(new Error('DRAFT_INCOMPLETE'), { missing: miss });
  const { requestService } = await import('../requests/request.service.js');
  const { matchingService } = await import('../matching/matching.service.js');
  const r = await requestService.create(userId, {
    categoryId: d.category_id!, serviceId: d.service_id ?? undefined,
    title: (d.need ?? 'Job request').slice(0, 120), details: d.need ?? '',
    lat: d.lat!, lng: d.lng!, notes: [d.address_text, d.landmark && `Landmark: ${d.landmark}`].filter(Boolean).join(' · ') || undefined,
    scheduledDate: d.scheduled_date ?? undefined, timeWindow: d.time_window ? WINDOW_HOURS[d.time_window] : undefined,
    contactPhone: `+${waId.replace(/\D/g, '')}`, idempotencyKey: `wa_draft_${d.id}`, source: 'whatsapp',
    preferredProviderId: d.preferred_provider_id ?? undefined,
  });
  await q(`UPDATE booking.service_request SET budget_kobo=$2, photo_asset_ids=$3 WHERE id=$1`, [r.id, d.budget_kobo, JSON.stringify(d.photo_asset_ids)]).catch(() => undefined);
  const ranked = await matchingService.rank({
    requestId: r.id, categoryId: d.category_id, lat: d.lat!, lng: d.lng!, need: d.need,
    budgetKobo: d.budget_kobo ? BigInt(d.budget_kobo) : null, serviceId: d.service_id,
  });
  await patchDraft(d.id, { status: 'submitted', request_id: r.id });
  emit('whatsapp.request_submitted', { requestId: r.id, vendors: ranked.length });
  // From a vendor's storefront: that vendor gets the job offer first.
  if (d.preferred_provider_id) {
    const v = await q<{ name: string | null; phone: string | null }>(
      `SELECT p.business_name AS name, u.phone FROM provider.provider p JOIN identity.users u ON u.id=p.user_id WHERE p.id=$1`, [d.preferred_provider_id],
    );
    const offer = await q<{ id: string }>(
      `INSERT INTO booking.request_offer (request_id, provider_id, eta_minutes) VALUES ($1,$2,30) RETURNING id`, [r.id, d.preferred_provider_id],
    ).catch(() => []);
    await q(`UPDATE booking.service_request SET preferred_provider_id=$2, status='OFFERED' WHERE id=$1`, [r.id, d.preferred_provider_id]).catch(() => undefined);
    if (offer[0] && v[0]?.phone) {
      const { notifyProviderOfOffer } = await import('./whatsapp.bot.js');
      await notifyProviderOfOffer(String(v[0].phone), String(offer[0].id), `${(d.need ?? 'New job').slice(0, 80)} (booked from your storefront)`);
    }
    await wa.text(waId, `Done, your request is with ${v[0]?.name ?? 'the vendor'}. You'll get a message here when they accept, and you can then chat with them here through Kendibo.`);
    return { requestId: r.id, vendors: 1 };
  }
  if (ranked.length) {
    await wa.ctaUrl(waId, `Done, your request is in. ${ranked.length} verified vendor${ranked.length === 1 ? '' : 's'} near you can take it. Compare them and pick one, or we'll offer it to the best match.`, 'See vendors', vendorsLink(waId, d.id));
  } else {
    await wa.text(waId, "Your request is in. No verified vendor in that trade is free near you right now. Our team has been alerted, and we'll message you here as soon as one accepts.");
  }
  return { requestId: r.id, vendors: ranked.length };
}
