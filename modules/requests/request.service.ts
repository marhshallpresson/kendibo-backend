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
  id: string; userId: string; serviceId: string | null; categoryId: string | null;
  title: string; details: string;
  urgency: string; addressId: string | null; lat: number | null; lng: number | null;
  contactName: string | null; contactPhone: string | null; contactEmail: string | null;
  notes: string | null; smsUpdates: boolean; scheduledDate: string | null; timeWindow: string | null;
  status: RequestStatus; bookingId: string | null; createdAt: string;
  preferredProviderId: string | null; source: string;
}
interface MatchCandidate { providerId: string; score: number; distanceKm: number }
const toReq = (r: Record<string, unknown>): ServiceRequest => ({
  id: String(r.id), userId: String(r.user_id), serviceId: r.service_id ? String(r.service_id) : null,
  categoryId: r.category_id ? String(r.category_id) : null,
  preferredProviderId: r.preferred_provider_id ? String(r.preferred_provider_id) : null,
  source: String(r.source ?? 'app'),
  title: String(r.title), details: String(r.details ?? ''), urgency: String(r.urgency),
  addressId: r.address_id ? String(r.address_id) : null,
  lat: r.lat as number ?? null, lng: r.lng as number ?? null,
  contactName: (r.contact_name as string) ?? null, contactPhone: (r.contact_phone as string) ?? null,
  contactEmail: (r.contact_email as string) ?? null, notes: (r.notes as string) ?? null,
  smsUpdates: Boolean(r.sms_updates), scheduledDate: r.scheduled_date ? String(r.scheduled_date) : null,
  timeWindow: (r.time_window as string) ?? null, status: r.status as RequestStatus,
  bookingId: r.booking_id ? String(r.booking_id) : null, createdAt: String(r.created_at),
});

/** Default catalog service for a category — prefers a fixed-price booking so an
 *  accepted request can mint a booking; quote-only categories fall through. */
async function defaultServiceFor(categoryId: string | null): Promise<string | null> {
  if (!categoryId) return null;
  const svcs = await q<Record<string, unknown>>(
    `SELECT id, booking_type FROM catalog.service WHERE category_id=$1 AND active`, [categoryId],
  );
  if (svcs.length === 0) return null;
  const fixed = svcs.find((s) => String(s.booking_type) !== 'quote');
  return String((fixed ?? svcs[0]).id);
}

/** Record the winning provider as an accepted assignment for the job so
 *  /v1/bookings/:id/tracking resolves a provider and the job can advance.
 *  pg-mem misses direct TEXT job_id lookups, so scan by indexed provider_id. */
async function assignAccepted(jobId: string, providerId: string): Promise<void> {
  const mine = await q<Record<string, unknown>>(
    `SELECT id, job_id, status FROM dispatch.assignment WHERE provider_id=$1`, [providerId],
  );
  const existing = mine.find((r) => String(r.job_id) === jobId);
  if (existing) {
    if (String(existing.status) !== 'accepted') {
      await q(`UPDATE dispatch.assignment SET status='accepted' WHERE id=$1`, [existing.id]);
    }
    return;
  }
  await q(`INSERT INTO dispatch.assignment (job_id, provider_id, status) VALUES ($1,$2,'accepted')`, [jobId, providerId]);
}

export const requestService = {
  async create(userId: string, input: {
    serviceId?: string; categoryId?: string; title: string; details?: string; urgency?: string;
    addressId?: string; lat?: number; lng?: number;
    contactName?: string; contactPhone?: string; contactEmail?: string; notes?: string;
    smsUpdates?: boolean; scheduledDate?: string; timeWindow?: string; idempotencyKey: string;
    /** Vendor whose storefront link the customer came through — offered first when eligible. */
    preferredProviderId?: string; source?: 'app' | 'storefront' | 'whatsapp';
  }): Promise<ServiceRequest> {
    const prior = await q<Record<string, unknown>>(
      `SELECT * FROM booking.service_request WHERE user_id=$1 AND idempotency_key=$2`, [userId, input.idempotencyKey],
    );
    if (prior[0]) return toReq(prior[0]);
    // Coordinates may arrive directly or be recovered from the selected address
    // (the customer app only sends addressId). Without them dispatch cannot rank.
    let lat = input.lat ?? null;
    let lng = input.lng ?? null;
    if ((lat == null || lng == null) && input.addressId) {
      const addr = await q<Record<string, unknown>>(`SELECT lat, lng FROM property.address WHERE id=$1 AND user_id=$2`, [input.addressId, userId]);
      if (addr[0]) {
        if (addr[0].lat != null) lat = Number(addr[0].lat);
        if (addr[0].lng != null) lng = Number(addr[0].lng);
      }
    }
    const rows = await q<Record<string, unknown>>(
      `INSERT INTO booking.service_request
        (user_id, service_id, category_id, title, details, urgency, address_id, lat, lng, contact_name, contact_phone, contact_email, notes, sms_updates, scheduled_date, time_window, idempotency_key, preferred_provider_id, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [userId, input.serviceId ?? null, input.categoryId ?? null, input.title, input.details ?? '', input.urgency ?? 'this_week',
       input.addressId ?? null, lat, lng,
       input.contactName ?? null, input.contactPhone ?? null, input.contactEmail ?? null,
       input.notes ?? null, input.smsUpdates ?? true, input.scheduledDate ?? null, input.timeWindow ?? null,
       input.idempotencyKey, input.preferredProviderId ?? null, input.source ?? 'app'],
    );
    const req = toReq(rows[0]);
    await q(`INSERT INTO outbox_event (topic, payload) VALUES ('request.submitted',$1)`, [JSON.stringify({ requestId: req.id })]);
    // Auto-match: only when we actually have coordinates AND candidates, so a
    // request with no reachable providers is not falsely marked OFFERED.
    if (req.lat != null && req.lng != null) {
      try {
        const ranked = await this.candidatesFor(req);
        if (ranked.candidates.length > 0) {
          await this.broadcast(req.id);
          const fresh = await q<Record<string, unknown>>(`SELECT * FROM booking.service_request WHERE id=$1`, [req.id]);
          return toReq(fresh[0] ?? rows[0]);
        }
      } catch (e) {
        emit('request.automatch_failed', { requestId: req.id, error: String((e as Error).message) });
      }
    }
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
  async candidatesFor(r: ServiceRequest): Promise<{ requestId: string; candidates: MatchCandidate[]; note: string }> {
    const ranked = await this.rankCandidates(r);
    if (!r.preferredProviderId) return ranked;
    // Came through a vendor's storefront link: that vendor gets first refusal,
    // but only if the category rules clear them — a link never bypasses vetting.
    const { vendorEligibilityService } = await import('../vendors/eligibility.service.js');
    if (!(await vendorEligibilityService.allowed(r.preferredProviderId, r.categoryId))) return ranked;
    const rest = ranked.candidates.filter((c) => c.providerId !== r.preferredProviderId);
    const own = ranked.candidates.find((c) => c.providerId === r.preferredProviderId) ?? { providerId: r.preferredProviderId, score: 100, distanceKm: 0 };
    return { ...ranked, candidates: [own, ...rest].slice(0, 10), note: `${ranked.note}+PREFERRED` };
  },

  async rankCandidates(r: ServiceRequest): Promise<{ requestId: string; candidates: MatchCandidate[]; note: string }> {
    if (r.lat == null || r.lng == null) return { requestId: r.id, candidates: [], note: 'NO_LOCATION' };
    if (r.serviceId) {
      const cands = await dispatchService.findCandidates({ serviceId: r.serviceId, lat: r.lat, lng: r.lng });
      return { requestId: r.id, candidates: cands.slice(0, 10), note: 'SKILL_MATCHED' };
    }
    const { providerService } = await import('../providers/provider.service.js');
    const { vendorEligibilityService } = await import('../vendors/eligibility.service.js');
    const online = await providerService.allOnline();
    const nearby = online
      .filter((p) => p.lat !== undefined && p.lng !== undefined)
      .map((p) => {
        const d = Math.hypot(r.lat! - p.lat!, r.lng! - p.lng!) * 111;
        return { providerId: p.id, score: Math.max(0, Math.round((100 - d * 4) * 10) / 10), distanceKm: Math.round(d * 100) / 100 };
      })
      .filter((c) => c.distanceKm <= 15)
      .sort((a, b) => b.score - a.score);
    // A plumbing request must never reach a painter: only vendors cleared for
    // the request's trade (category rules) are offered it.
    const scored: MatchCandidate[] = [];
    for (const c of nearby) {
      if (scored.length >= 10) break;
      if (await vendorEligibilityService.allowed(c.providerId, r.categoryId)) scored.push(c);
    }
    return { requestId: r.id, candidates: scored, note: r.categoryId ? 'CATEGORY_MATCHED' : 'PROXIMITY_MATCHED' };
  },

  async matches(id: string) {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM booking.service_request WHERE id=$1`, [id]);
    if (!rows[0]) throw new Error('NOT_FOUND');
    const r = toReq(rows[0]);
    await q(`UPDATE booking.service_request SET status='MATCHING' WHERE id=$1 AND status='SUBMITTED'`, [id]);
    return this.candidatesFor(r);
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

  /** First qualified accept wins; losers see OFFER_TAKEN. On accept we also
   *  mint (or link) the booking so the customer app can proceed to payment and
   *  tracking without a second round-trip. */
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

    const requestId = String(o.request_id);
    const providerId = String(o.provider_id);
    const req = toReq(took[0]);
    // Resolve a catalog service: prefer the explicit one, else a category default.
    const serviceId = req.serviceId ?? await defaultServiceFor(req.categoryId);
    if (!serviceId) return { id: offerId, status: 'accepted', requestId };
    // bookingService.create only prices fixed-price services; quote-mode services
    // stay ACCEPTED (the quote flow picks up from here) instead of crashing accept.
    let booking: { id: string } | null = null;
    try {
      booking = await bookingService.create(req.userId, {
        serviceId, addressId: req.addressId ?? '',
        scheduledAt: req.scheduledDate ?? new Date().toISOString(),
        urgency: req.urgency, customerNotes: req.notes ?? undefined,
        idempotencyKey: `req_${requestId}`,
      });
    } catch (e) {
      const msg = (e as Error).message;
      if (!['QUOTE_REQUIRED', 'SERVICE_NOT_FOUND', 'AMOUNT_MUST_BE_POSITIVE'].includes(msg)) throw e;
      emit('request.accept_booking_skipped', { requestId, serviceId, reason: msg });
      void notifyWhatsappCustomer(requestId, null);
      return { id: offerId, status: 'accepted', requestId };
    }
    await assignAccepted(booking.id, providerId);
    await q(`UPDATE booking.service_request SET status='BOOKED', booking_id=$2 WHERE id=$1`, [requestId, booking.id]);
    await q(`INSERT INTO outbox_event (topic, payload) VALUES ('request.booked',$1)`,
      [JSON.stringify({ requestId, bookingId: booking.id, providerId })]);
    emit('request.booked', { requestId, bookingId: booking.id, providerId });
    void notifyWhatsappCustomer(requestId, booking.id);
    return { id: offerId, status: 'accepted', requestId, bookingId: booking.id };
  },

  /** Convert an accepted request into a booking (needs a catalog service).
   *  Idempotent: an already-booked request returns its linked booking. */
  async convert(id: string, actor: string) {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM booking.service_request WHERE id=$1`, [id]);
    const r = rows[0] ? toReq(rows[0]) : null;
    if (!r) throw new Error('REQUEST_NOT_ACCEPTED');
    if (r.userId !== actor) throw new Error('FORBIDDEN');
    if (r.status === 'BOOKED' && r.bookingId) {
      const existing = await bookingService.get(r.bookingId, actor);
      if (existing) return { request: r, booking: existing };
    }
    if (r.status !== 'ACCEPTED') throw new Error('REQUEST_NOT_ACCEPTED');
    if (!r.serviceId && !r.categoryId) throw new Error('NEEDS_SERVICE_QUOTE');
    const serviceId = r.serviceId ?? await defaultServiceFor(r.categoryId);
    if (!serviceId) throw new Error('NEEDS_SERVICE_QUOTE');
    const booking = await bookingService.create(r.userId, {
      serviceId, addressId: r.addressId ?? '',
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

/** Tell a WhatsApp-sourced customer their vendor accepted (with the Bachs pay
 *  link when the job has a fixed price). Never throws into the accept path. */
async function notifyWhatsappCustomer(requestId: string, bookingId: string | null): Promise<void> {
  try {
    const { notifyRequestAccepted } = await import('../whatsapp/whatsapp.bot.js');
    await notifyRequestAccepted(requestId, bookingId);
  } catch { /* notification is best-effort */ }
}
