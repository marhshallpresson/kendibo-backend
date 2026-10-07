// On-demand service requests — user states a need (5-step wizard), system
// analyzes + matches, providers accept Bolt-style. Statuses:
// SUBMITTED -> MATCHING -> OFFERED -> ACCEPTED -> BOOKED (+CANCELLED/EXPIRED).
// Broadcast = request_offer rows for top-N candidates; first qualified accept
// wins (guarded by request-row status transition). Convert mints a booking
// when a catalog service is attached, else hands off to the quote flow.
import { q } from '../../packages/database/db.js';
import { dispatchService } from '../dispatch/dispatch.service.js';
import { bookingService } from '../bookings/booking.service.js';
import { notificationService } from '../notifications/notification.service.js';
import { deviceService } from '../devices/device.service.js';
import { emit } from '../../packages/observability/emit.js';

export type RequestStatus = 'SUBMITTED' | 'MATCHING' | 'OFFERED' | 'ACCEPTED' | 'BOOKED' | 'CANCELLED' | 'EXPIRED';
export interface ServiceRequest {
  id: string; userId: string; serviceId: string | null; title: string; details: string;
  urgency: string; addressId: string | null; lat: number | null; lng: number | null;
  contactName: string | null; contactPhone: string | null; contactEmail: string | null;
  notes: string | null; smsUpdates: boolean; scheduledDate: string | null; timeWindow: string | null;
  status: RequestStatus; bookingId: string | null; createdAt: string;
}
const toReq = (r: Record<string, unknown>): ServiceRequest => ({
  id: String(r.id), userId: String(r.user_id), serviceId: r.service_id ? String(r.service_id) : null,
  title: String(r.title), details: String(r.details ?? ''), urgency: String(r.urgency),
  addressId: r.address_id ? String(r.address_id) : null,
  lat: r.lat as number ?? null, lng: r.lng as number ?? null,
  contactName: (r.contact_name as string) ?? null, contactPhone: (r.contact_phone as string) ?? null,
  contactEmail: (r.contact_email as string) ?? null, notes: (r.notes as string) ?? null,
  smsUpdates: Boolean(r.sms_updates), scheduledDate: r.scheduled_date ? String(r.scheduled_date) : null,
  timeWindow: (r.time_window as string) ?? null, status: r.status as RequestStatus,
  bookingId: r.booking_id ? String(r.booking_id) : null, createdAt: String(r.created_at),
});

export const requestService = {
  async create(userId: string, input: {
    serviceId?: string; title: string; details?: string; urgency?: string;
    addressId?: string; lat?: number; lng?: number;
    contactName?: string; contactPhone?: string; contactEmail?: string; notes?: string;
    smsUpdates?: boolean; scheduledDate?: string; timeWindow?: string; idempotencyKey: string;
  }): Promise<ServiceRequest> {
    const prior = await q<Record<string, unknown>>(
      `SELECT * FROM booking.service_request WHERE user_id=$1 AND idempotency_key=$2`, [userId, input.idempotencyKey],
    );
    if (prior[0]) return toReq(prior[0]);
    const rows = await q<Record<string, unknown>>(
      `INSERT INTO booking.service_request
        (user_id, service_id, title, details, urgency, address_id, lat, lng, contact_name, contact_phone, contact_email, notes, sms_updates, scheduled_date, time_window, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [userId, input.serviceId ?? null, input.title, input.details ?? '', input.urgency ?? 'this_week',
       input.addressId ?? null, input.lat ?? null, input.lng ?? null,
       input.contactName ?? null, input.contactPhone ?? null, input.contactEmail ?? null,
       input.notes ?? null, input.smsUpdates ?? true, input.scheduledDate ?? null, input.timeWindow ?? null,
       input.idempotencyKey],
    );
    const req = toReq(rows[0]);
    await q(`INSERT INTO outbox_event (topic, payload) VALUES ('request.submitted',$1)`, [JSON.stringify({ requestId: req.id })]);
    return req;
  },

  async get(id: string, userId?: string): Promise<ServiceRequest | null> {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM booking.service_request WHERE id=$1`, [id]);
    const r = rows[0];
    if (!r) return null;
    if (userId && String(r.user_id) !== userId) throw new Error('FORBIDDEN');
    return toReq(r);
  },

  async list(userId: string) {
    const rows = await q<Record<string, unknown>>(
      `SELECT * FROM booking.service_request WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`, [userId],
    );
    return { items: rows.map(toReq), nextCursor: null as string | null };
  },

  /** Analyze + rank: catalog skill filter when a service is attached, else zone/online/KYC + distance. */
  async matches(id: string) {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM booking.service_request WHERE id=$1`, [id]);
    if (!rows[0]) throw new Error('NOT_FOUND');
    const r = toReq(rows[0]);
    await q(`UPDATE booking.service_request SET status='MATCHING' WHERE id=$1 AND status='SUBMITTED'`, [id]);
    if (r.lat == null || r.lng == null) return { requestId: id, candidates: [], note: 'NO_LOCATION' };
    if (r.serviceId) {
      const cands = await dispatchService.findCandidates({ serviceId: r.serviceId, lat: r.lat, lng: r.lng });
      return { requestId: id, candidates: cands.slice(0, 10), note: 'SKILL_MATCHED' };
    }
    const { providerService } = await import('../providers/provider.service.js');
    const online = await providerService.allOnline();
    const scored = online
      .filter((p) => p.lat !== undefined && p.lng !== undefined)
      .map((p) => {
        const d = Math.hypot(r.lat! - p.lat!, r.lng! - p.lng!) * 111;
        return { providerId: p.id, score: Math.max(0, Math.round((100 - d * 4) * 10) / 10), distanceKm: Math.round(d * 100) / 100 };
      })
      .filter((c) => c.distanceKm <= 15)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
    return { requestId: id, candidates: scored, note: 'PROXIMITY_MATCHED' };
  },

  /** Broadcast to top-N candidates: offer rows + push each provider. */
  async broadcast(id: string, limit = 5) {
    const m = await this.matches(id);
    const picks = m.candidates.slice(0, limit);
    const { providerService } = await import('../providers/provider.service.js');
    const offers = [];
    for (const c of picks) {
      const existing = await q(`SELECT id FROM booking.request_offer WHERE request_id=$1 AND provider_id=$2`, [id, c.providerId]);
      if (existing.length > 0) continue;
      const ins = await q<Record<string, unknown>>(
        `INSERT INTO booking.request_offer (request_id, provider_id, eta_minutes) VALUES ($1,$2,$3) RETURNING *`,
        [id, c.providerId, 15 + Math.round(c.distanceKm * 3)],
      );
      offers.push(ins[0]);
      const prov = await providerService.byId(c.providerId);
      if (prov) {
        const tokens = await deviceService.tokensFor(prov.userId);
        await notificationService.dispatch('provider.assigned', { userId: prov.userId, push: tokens[0] }, { requestId: id });
      }
    }
    await q(`UPDATE booking.service_request SET status='OFFERED' WHERE id=$1 AND status IN ('SUBMITTED','MATCHING')`, [id]);
    emit('request.broadcast', { requestId: id, offersSent: offers.length });
    return { requestId: id, offersSent: offers.length };
  },

  async incoming(providerId: string) {
    const rows = await q<Record<string, unknown>>(
      `SELECT o.*, r.title, r.urgency, r.lat, r.lng, r.scheduled_date, r.time_window
       FROM booking.request_offer o JOIN booking.service_request r ON r.id=o.request_id
       WHERE o.provider_id=$1 AND o.status='offered' ORDER BY o.created_at DESC`, [providerId],
    );
    return rows;
  },

  /** First qualified accept wins; losers see OFFER_TAKEN. */
  async respondOffer(offerId: string, accept: boolean) {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM booking.request_offer WHERE id=$1`, [offerId]);
    const o = rows[0];
    if (!o || String(o.status) !== 'offered') throw new Error('OFFER_GONE');
    if (!accept) {
      await q(`UPDATE booking.request_offer SET status='declined' WHERE id=$1`, [offerId]);
      return { id: offerId, status: 'declined' };
    }
    const took = await q<Record<string, unknown>>(
      `UPDATE booking.service_request SET status='ACCEPTED' WHERE id=$1 AND status IN ('SUBMITTED','MATCHING','OFFERED') RETURNING *`,
      [String(o.request_id)],
    );
    if (took.length === 0) throw new Error('OFFER_TAKEN');
    await q(`UPDATE booking.request_offer SET status='accepted' WHERE id=$1`, [offerId]);
    await q(`UPDATE booking.request_offer SET status='declined' WHERE request_id=$1 AND id!=$2 AND status='offered'`,
      [String(o.request_id), offerId]);
    await q(`INSERT INTO outbox_event (topic, payload) VALUES ('request.accepted',$1)`,
      [JSON.stringify({ requestId: String(o.request_id), providerId: String(o.provider_id) })]);
    emit('request.accepted', { requestId: String(o.request_id), providerId: String(o.provider_id) });
    return { id: offerId, status: 'accepted', requestId: String(o.request_id) };
  },

  /** Convert an accepted request into a booking (needs a catalog service). */
  async convert(id: string, actor: string) {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM booking.service_request WHERE id=$1`, [id]);
    const r = rows[0] ? toReq(rows[0]) : null;
    if (!r || r.status !== 'ACCEPTED') throw new Error('REQUEST_NOT_ACCEPTED');
    if (!r.serviceId) throw new Error('NEEDS_SERVICE_QUOTE');
    const booking = await bookingService.create(r.userId, {
      serviceId: r.serviceId, addressId: r.addressId ?? '',
      scheduledAt: r.scheduledDate ?? new Date().toISOString(), idempotencyKey: `req_${id}`,
    });
    await q(`UPDATE booking.service_request SET status='BOOKED', booking_id=$2 WHERE id=$1`, [id, booking.id]);
    await q(`INSERT INTO outbox_event (topic, payload) VALUES ('request.booked',$1)`,
      [JSON.stringify({ requestId: id, bookingId: booking.id, actor })]);
    return { request: { ...r, status: 'BOOKED' as RequestStatus, bookingId: booking.id }, booking };
  },

  async cancel(id: string, userId: string) {
    const upd = await q<Record<string, unknown>>(
      `UPDATE booking.service_request SET status='CANCELLED' WHERE id=$1 AND user_id=$2 AND status IN ('SUBMITTED','MATCHING','OFFERED') RETURNING *`,
      [id, userId],
    );
    if (!upd[0]) throw new Error('CANCEL_BLOCKED');
    return toReq(upd[0]);
  },
};
