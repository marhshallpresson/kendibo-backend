// Provider service — onboarding, skills, availability, storefront, office map
// pinpointing, Bolt-style AI dispatch feed, and offline command sync.
import { q } from '../../packages/database/db.js';
import { transition } from '../bookings/state-machine.js';
import type { JobStatus } from '../../packages/shared/types.js';
import { emit } from '../../packages/observability/emit.js';
import { mediaService } from '../media/media.service.js';

export interface GalleryPhoto {
  id: string;
  assetId: string;
  url: string;
  caption: string | null;
  position?: number;
  createdAt: string;
}

export interface Provider {
  id: string;
  userId: string;
  kycStatus: 'PENDING' | 'UNDER_REVIEW' | 'VERIFIED' | 'REJECTED';
  kycTier?: number;
  skills: string[];
  online: boolean;
  lat?: number;
  lng?: number;
  serviceRadiusKm?: number;
  rating: number;
  businessName?: string | null;
  headline?: string | null;
  bio?: string | null;
  officeAddress?: string | null;
  officeStreet?: string | null;
  officeLandmark?: string | null;
  officeCity?: string | null;
  cacNumber?: string | null;
  cacCompanyName?: string | null;
  cacVerified?: boolean;
  verifiedLegalName?: string | null;
  faceVerified?: boolean;
  nameAligned?: boolean;
  nameAlignmentScore?: number;
  storefrontCompleted?: boolean;
  onboardingStep?: string;
  operatingHours?: Record<string, unknown>;
  bankName?: string | null;
  accountName?: string | null;
  accountNumber?: string | null;
  bankCode?: string | null;
  displayName?: string | null;
}

export interface BoltDispatchItem {
  id: string;
  feedType: 'job_offer' | 'request_offer' | 'open_field_request';
  offerId?: string;
  jobId?: string;
  bookingId?: string;
  requestId?: string;
  serviceId?: string | null;
  categoryId?: string | null;
  serviceTitle: string;
  details?: string;
  customerName: string;
  customerVerified: boolean;
  address: string;
  urgency: string;
  scheduledAt?: string | null;
  totalKobo: string;
  distanceKm: number;
  etaMinutes: number;
  aiMatchScore: number;
  aiMatchReason: string;
  slaSecondsRemaining: number;
  createdAt: string;
}

async function skillsOf(providerId: string): Promise<string[]> {
  // COALESCE: rows written before migration 028 only carry service_id.
  const rows = await q<{ skill: string }>(`SELECT COALESCE(k.skill_tag, k.service_id) AS skill FROM provider.skill k WHERE k.provider_id=$1`, [providerId]);
  return rows.map((r) => r.skill);
}

async function toProv(r: Record<string, unknown>): Promise<Provider> {
  const id = String(r.id);
  let opHours: Record<string, unknown> = {};
  if (r.operating_hours && typeof r.operating_hours === 'object') {
    opHours = r.operating_hours as Record<string, unknown>;
  } else if (typeof r.operating_hours === 'string') {
    try { opHours = JSON.parse(r.operating_hours); } catch { opHours = {}; }
  }
  return {
    id,
    userId: String(r.user_id),
    kycStatus: (String(r.kyc_status ?? 'PENDING')) as Provider['kycStatus'],
    kycTier: Number(r.kyc_tier ?? 0),
    skills: await skillsOf(id),
    online: Boolean(r.online),
    lat: r.lat !== null && r.lat !== undefined ? Number(r.lat) : undefined,
    lng: r.lng !== null && r.lng !== undefined ? Number(r.lng) : undefined,
    serviceRadiusKm: r.service_radius_km != null ? Number(r.service_radius_km) : 10,
    rating: Number(r.rating ?? 5),
    businessName: r.business_name ? String(r.business_name) : null,
    headline: r.headline ? String(r.headline) : null,
    bio: r.bio ? String(r.bio) : null,
    officeAddress: r.office_address ? String(r.office_address) : null,
    officeStreet: r.office_street ? String(r.office_street) : null,
    officeLandmark: r.office_landmark ? String(r.office_landmark) : null,
    officeCity: r.office_city ? String(r.office_city) : null,
    cacNumber: r.cac_number ? String(r.cac_number) : null,
    cacCompanyName: r.cac_company_name ? String(r.cac_company_name) : null,
    cacVerified: Boolean(r.cac_verified),
    verifiedLegalName: r.verified_legal_name ? String(r.verified_legal_name) : null,
    faceVerified: Boolean(r.face_verified),
    nameAligned: Boolean(r.name_aligned),
    nameAlignmentScore: r.name_alignment_score != null ? Number(r.name_alignment_score) : 0,
    storefrontCompleted: Boolean(r.storefront_completed),
    onboardingStep: r.onboarding_step ? String(r.onboarding_step) : 'basic_info',
    operatingHours: opHours,
    bankName: r.bank_name ? String(r.bank_name) : null,
    accountName: r.account_name ? String(r.account_name) : null,
    accountNumber: r.account_number ? String(r.account_number) : null,
    bankCode: r.bank_code ? String(r.bank_code) : null,
    displayName: r.business_name
      ? String(r.business_name)
      : r.verified_legal_name
        ? String(r.verified_legal_name)
        : r.user_name
          ? String(r.user_name)
          : null,
  };
}

export const providerService = {
  /** Idempotent per user: returns the existing provider row on repeat calls. */
  async onboard(userId: string): Promise<Provider> {
    const existing = await this.byUserId(userId);
    if (existing) return existing;
    const rows = await q<Record<string, unknown>>(
      `INSERT INTO provider.provider (user_id, kyc_status, rating) VALUES ($1,'PENDING',5.0) RETURNING *`,
      [userId],
    );
    return toProv(rows[0]);
  },

  async byUserId(userId: string): Promise<Provider | null> {
    const rows = await q<Record<string, unknown>>(
      `SELECT p.*, u.name AS user_name
         FROM provider.provider p
         LEFT JOIN identity.users u ON u.id = p.user_id
        WHERE p.user_id=$1
        ORDER BY p.created_at DESC LIMIT 1`,
      [userId],
    );
    return rows[0] ? toProv(rows[0]) : null;
  },

  async byId(id: string): Promise<Provider | null> {
    const rows = await q<Record<string, unknown>>(
      `SELECT p.*, u.name AS user_name
         FROM provider.provider p
         LEFT JOIN identity.users u ON u.id = p.user_id
        WHERE p.id=$1`,
      [id],
    );
    return rows[0] ? toProv(rows[0]) : null;
  },

  async verifyKyc(id: string): Promise<Provider> {
    const rows = await q<Record<string, unknown>>(
      `UPDATE provider.provider
          SET kyc_status='VERIFIED', status='active', verify_level='verified'
        WHERE id=$1 RETURNING *`,
      [id],
    );
    if (!rows[0]) throw new Error('PROVIDER_NOT_FOUND');
    return toProv(rows[0]);
  },

  async addSkill(id: string, skill: string): Promise<Provider> {
    await q(`INSERT INTO provider.skill (provider_id, service_id, skill_tag) VALUES ($1,$2,$2) ON CONFLICT DO NOTHING`, [id, skill]);
    return (await this.byId(id))!;
  },

  async setSkills(id: string, skills: string[]): Promise<Provider> {
    const clean = Array.from(new Set(skills.map((s) => s.trim()).filter(Boolean)));
    if (clean.length > 0) {
      await q(`DELETE FROM provider.skill WHERE provider_id=$1`, [id]);
      for (const s of clean) {
        await q(`INSERT INTO provider.skill (provider_id, service_id, skill_tag) VALUES ($1,$2,$2) ON CONFLICT DO NOTHING`, [id, s]);
      }
    }
    return (await this.byId(id))!;
  },

  /** Update vendor Storefront, Office Address + Map Pinpoint, and Operating Hours. */
  async updateStorefront(
    providerId: string,
    patch: {
      businessName?: string;
      headline?: string;
      bio?: string;
      officeAddress?: string;
      officeStreet?: string;
      officeLandmark?: string;
      officeCity?: string;
      lat?: number;
      lng?: number;
      serviceRadiusKm?: number;
      operatingHours?: Record<string, unknown>;
      skills?: string[];
      storefrontCompleted?: boolean;
      onboardingStep?: string;
    },
  ): Promise<Provider> {
    const sets: string[] = [];
    const vals: unknown[] = [];

    const push = (col: string, val: unknown) => {
      vals.push(val);
      sets.push(`${col}=$${vals.length}`);
    };

    if (patch.businessName !== undefined) push('business_name', patch.businessName.trim());
    if (patch.headline !== undefined) push('headline', patch.headline.trim());
    if (patch.bio !== undefined) push('bio', patch.bio.trim());
    if (patch.officeAddress !== undefined) push('office_address', patch.officeAddress.trim());
    if (patch.officeStreet !== undefined) push('office_street', patch.officeStreet.trim());
    if (patch.officeLandmark !== undefined) push('office_landmark', patch.officeLandmark.trim());
    if (patch.officeCity !== undefined) push('office_city', patch.officeCity.trim());
    if (typeof patch.lat === 'number' && Number.isFinite(patch.lat)) push('lat', patch.lat);
    if (typeof patch.lng === 'number' && Number.isFinite(patch.lng)) push('lng', patch.lng);
    if (typeof patch.serviceRadiusKm === 'number' && Number.isFinite(patch.serviceRadiusKm)) {
      push('service_radius_km', Math.max(1, Math.min(50, Math.round(patch.serviceRadiusKm))));
    }
    if (patch.operatingHours !== undefined) push('operating_hours', JSON.stringify(patch.operatingHours));
    if (patch.storefrontCompleted !== undefined) push('storefront_completed', patch.storefrontCompleted);
    if (patch.onboardingStep !== undefined) push('onboarding_step', patch.onboardingStep);

    if (sets.length > 0) {
      vals.push(providerId);
      await q(`UPDATE provider.provider SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals);
    }

    if (Array.isArray(patch.skills) && patch.skills.length > 0) {
      await this.setSkills(providerId, patch.skills);
    }

    const updated = await this.byId(providerId);
    if (!updated) throw new Error('PROVIDER_NOT_FOUND');
    emit('provider.storefront_updated', {
      providerId,
      businessName: updated.businessName,
      officeCity: updated.officeCity,
      storefrontCompleted: updated.storefrontCompleted,
    });
    return updated;
  },

  async setOnline(id: string, online: boolean, lat?: number, lng?: number): Promise<Provider> {
    const rows = await q<Record<string, unknown>>(
      `UPDATE provider.provider SET online=$2, lat=COALESCE($3,lat), lng=COALESCE($4,lng) WHERE id=$1 RETURNING *`,
      [id, online, lat ?? null, lng ?? null],
    );
    if (!rows[0]) throw new Error('PROVIDER_NOT_FOUND');
    emit('provider.availability', { providerId: id, online });
    return toProv(rows[0]);
  },

  async updateLocation(id: string, lat: number, lng: number): Promise<void> {
    await q(`UPDATE provider.provider SET lat=$2, lng=$3 WHERE id=$1`, [id, lat, lng]);
  },

  async allOnline(): Promise<Provider[]> {
    const rows = await q<Record<string, unknown>>(
      `SELECT p.*, u.name AS user_name
         FROM provider.provider p
         LEFT JOIN identity.users u ON u.id = p.user_id
        WHERE p.online=TRUE AND p.kyc_status='VERIFIED' AND p.status='active'`,
    );
    return Promise.all(rows.map(toProv));
  },

  async offer(jobId: string, providerId: string, slaSec = 60) {
    // Expiry computed here (not with interval arithmetic) so it is identical on
    // Postgres and pg-mem, and returned so callers can show the SLA countdown.
    const expiresAt = new Date(Date.now() + slaSec * 1000).toISOString();
    const rows = await q<Record<string, unknown>>(
      `INSERT INTO dispatch.assignment (job_id, provider_id, status, expires_at)
       VALUES ($1,$2,'offered',$3) RETURNING *`,
      [jobId, providerId, expiresAt],
    );
    emit('dispatch.offered', { jobId, providerId, offerId: rows[0].id, slaSec });
    return { id: String(rows[0].id), jobId, providerId, status: 'offered' as const, expiresAt };
  },

  async offersFor(providerId: string) {
    const rows = await q<Record<string, unknown>>(
      `SELECT * FROM dispatch.assignment WHERE provider_id=$1 ORDER BY offered_at DESC`,
      [providerId],
    );
    return rows.map((r) => ({ ...r, id: String(r.id) }));
  },

  /**
   * Bolt-Style AI Dispatch & Request Feed:
   * Returns a unified list of:
   *  1. Direct job offers (`dispatch.assignment` where status = 'offered')
   *  2. Broadcasted service-request offers (`booking.request_offer` where status = 'offered')
   *  3. Open field-matched service requests (`booking.service_request` in the vendor's skill/category & radius)
   */
  async dispatchFeedFor(providerId: string): Promise<{
    provider: Provider | null;
    telemetry: {
      acceptanceRate: number;
      completionRate: number;
      qualityScore: number;
      activeOffersCount: number;
      fieldRequestsCount: number;
    };
    items: BoltDispatchItem[];
  }> {
    const prov = await this.byId(providerId);
    if (!prov) {
      return {
        provider: null,
        telemetry: { acceptanceRate: 100, completionRate: 100, qualityScore: 98, activeOffersCount: 0, fieldRequestsCount: 0 },
        items: [],
      };
    }

    const pLat = prov.lat ?? 6.5244;
    const pLng = prov.lng ?? 3.3792;
    const maxRadius = prov.serviceRadiusKm ?? 15;
    const provSkills = new Set(prov.skills.map((s) => s.toLowerCase()));

    const items: BoltDispatchItem[] = [];
    const seenRequestIds = new Set<string>();
    const seenJobIds = new Set<string>();

    // Helper for distance & ETA
    const calcDist = (lat?: number | null, lng?: number | null) => {
      if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
        return { distanceKm: 2.4, etaMinutes: 12 };
      }
      const d = Math.round(Math.hypot(pLat - lat, pLng - lng) * 111 * 10) / 10;
      return { distanceKm: d, etaMinutes: Math.max(5, Math.round(8 + d * 2.5)) };
    };

    // 1) Direct Job Offers (`dispatch.assignment` where status = 'offered')
    const directOffers = await q<Record<string, unknown>>(
      `SELECT * FROM dispatch.assignment WHERE provider_id=$1 AND status='offered' ORDER BY offered_at DESC LIMIT 20`,
      [providerId],
    );
    for (const o of directOffers) {
      const jobId = String(o.job_id);
      seenJobIds.add(jobId);
      const bRows = await q<Record<string, unknown>>(`SELECT * FROM booking.booking WHERE id=$1`, [jobId]).catch(() => []);
      const b = bRows[0] ?? {};
      const serviceId = b.service_id ? String(b.service_id) : 'home_service';
      const svcRows = await q<Record<string, unknown>>(`SELECT name, base_price_kobo FROM catalog.service WHERE id=$1`, [serviceId]).catch(() => []);
      const svcName = svcRows[0]?.name ? String(svcRows[0].name) : serviceId.replace(/^svc_/, '').replace(/_/g, ' ').toUpperCase();
      const totalKobo = String(b.total_kobo ?? svcRows[0]?.base_price_kobo ?? '1500000');

      let addrText = 'Customer Service Location';
      let addrLat: number | null = null;
      let addrLng: number | null = null;
      if (b.address_id) {
        const aRows = await q<Record<string, unknown>>(`SELECT street, city, lat, lng FROM property.address WHERE id=$1`, [b.address_id]).catch(() => []);
        if (aRows[0]) {
          addrText = [aRows[0].street, aRows[0].city].filter(Boolean).join(', ') || addrText;
          addrLat = aRows[0].lat != null ? Number(aRows[0].lat) : null;
          addrLng = aRows[0].lng != null ? Number(aRows[0].lng) : null;
        }
      }
      let customerName = 'Verified Customer';
      if (b.user_id) {
        const uRows = await q<Record<string, unknown>>(`SELECT name FROM identity.users WHERE id=$1`, [b.user_id]).catch(() => []);
        if (uRows[0]?.name) customerName = String(uRows[0].name);
      }

      const { distanceKm, etaMinutes } = calcDist(addrLat, addrLng);
      const aiScore = Math.max(82, Math.min(99, Math.round(98 - distanceKm * 1.2)));
      const expiresAt = o.expires_at ? new Date(String(o.expires_at)).getTime() : Date.now() + 90_000;
      const slaSecondsRemaining = Math.max(15, Math.min(180, Math.round((expiresAt - Date.now()) / 1000)));

      items.push({
        id: `offer_${o.id}`,
        feedType: 'job_offer',
        offerId: String(o.id),
        jobId,
        bookingId: jobId,
        serviceId,
        serviceTitle: svcName,
        customerName,
        customerVerified: true,
        address: addrText,
        urgency: 'today',
        scheduledAt: b.scheduled_at ? String(b.scheduled_at) : null,
        totalKobo,
        distanceKm,
        etaMinutes,
        aiMatchScore: aiScore,
        aiMatchReason: `Priority Dispatch • ${distanceKm} km away`,
        slaSecondsRemaining,
        createdAt: String(o.offered_at ?? new Date().toISOString()),
      });
    }

    // 2) Broadcasted Request Offers (`booking.request_offer` where status = 'offered')
    const reqOffers = await q<Record<string, unknown>>(
      `SELECT o.*, r.id AS req_id, r.service_id, r.category_id, r.title, r.details,
              r.urgency, r.lat, r.lng, r.contact_name, r.scheduled_date, r.time_window
         FROM booking.request_offer o
         JOIN booking.service_request r ON r.id = o.request_id
        WHERE o.provider_id=$1 AND o.status='offered'
        ORDER BY o.created_at DESC LIMIT 20`,
      [providerId],
    ).catch(() => []);

    for (const ro of reqOffers) {
      const requestId = String(ro.req_id ?? ro.request_id);
      seenRequestIds.add(requestId);
      const { distanceKm, etaMinutes } = calcDist(
        ro.lat != null ? Number(ro.lat) : null,
        ro.lng != null ? Number(ro.lng) : null,
      );
      const aiScore = Math.max(80, Math.min(99, Math.round(96 - distanceKm * 1.5)));
      items.push({
        id: `req_offer_${ro.id}`,
        feedType: 'request_offer',
        offerId: String(ro.id),
        requestId,
        serviceId: ro.service_id ? String(ro.service_id) : null,
        categoryId: ro.category_id ? String(ro.category_id) : null,
        serviceTitle: String(ro.title ?? 'On-Demand Service Request'),
        details: ro.details ? String(ro.details) : undefined,
        customerName: ro.contact_name ? String(ro.contact_name) : 'Verified Customer',
        customerVerified: true,
        address: prov.officeCity ? `Near ${prov.officeCity} (${distanceKm} km)` : `${distanceKm} km from your office`,
        urgency: String(ro.urgency ?? 'today'),
        scheduledAt: ro.scheduled_date ? String(ro.scheduled_date) : null,
        totalKobo: '1850000',
        distanceKm,
        etaMinutes: ro.eta_minutes ? Number(ro.eta_minutes) : etaMinutes,
        aiMatchScore: aiScore,
        aiMatchReason: `Nearby Request • ${distanceKm} km away`,
        slaSecondsRemaining: 120,
        createdAt: String(ro.created_at ?? new Date().toISOString()),
      });
    }

    // 3) Open Field-Matched Service Requests (`booking.service_request` in the vendor's field)
    const openReqs = await q<Record<string, unknown>>(
      `SELECT * FROM booking.service_request
        WHERE status IN ('SUBMITTED', 'MATCHING', 'OFFERED')
        ORDER BY created_at DESC LIMIT 25`,
    ).catch(() => []);

    for (const r of openReqs) {
      const requestId = String(r.id);
      if (seenRequestIds.has(requestId)) continue;

      const catId = r.category_id ? String(r.category_id).toLowerCase() : '';
      const svcId = r.service_id ? String(r.service_id).toLowerCase() : '';
      const titleLower = String(r.title ?? '').toLowerCase();

      // Match if vendor has no skills filter yet OR matches category/service/title keywords
      const skillMatched =
        provSkills.size === 0 ||
        (catId && provSkills.has(catId)) ||
        (svcId && provSkills.has(svcId)) ||
        Array.from(provSkills).some((sk) => titleLower.includes(sk) || catId.includes(sk) || svcId.includes(sk));

      if (!skillMatched && provSkills.size > 0) continue;

      const { distanceKm, etaMinutes } = calcDist(
        r.lat != null ? Number(r.lat) : null,
        r.lng != null ? Number(r.lng) : null,
      );
      if (distanceKm > maxRadius * 2.5) continue;

      const aiScore = Math.max(75, Math.min(98, Math.round((skillMatched ? 95 : 85) - distanceKm * 1.3)));
      items.push({
        id: `open_req_${requestId}`,
        feedType: 'open_field_request',
        requestId,
        serviceId: r.service_id ? String(r.service_id) : null,
        categoryId: r.category_id ? String(r.category_id) : null,
        serviceTitle: String(r.title ?? 'Service Request in Your Field'),
        details: r.details ? String(r.details) : undefined,
        customerName: r.contact_name ? String(r.contact_name) : 'Kendibo Customer',
        customerVerified: true,
        address: prov.officeCity ? `${prov.officeCity} Area • ${distanceKm} km` : `${distanceKm} km away`,
        urgency: String(r.urgency ?? 'this_week'),
        scheduledAt: r.scheduled_date ? String(r.scheduled_date) : null,
        totalKobo: '1650000',
        distanceKm,
        etaMinutes,
        aiMatchScore: aiScore,
        aiMatchReason: `Matches your service category • ${distanceKm} km away`,
        slaSecondsRemaining: 150,
        createdAt: String(r.created_at ?? new Date().toISOString()),
      });
    }

    // Compute Bolt-style driver/vendor telemetry
    const allAssignments = await q<{ status: string }>(
      `SELECT status FROM dispatch.assignment WHERE provider_id=$1`,
      [providerId],
    ).catch(() => []);
    const totalOffers = allAssignments.length;
    const acceptedCount = allAssignments.filter((a) => a.status === 'accepted').length;
    const declinedCount = allAssignments.filter((a) => a.status === 'declined').length;
    const acceptanceRate = totalOffers > 0
      ? Math.round(((totalOffers - declinedCount) / totalOffers) * 100)
      : 100;

    return {
      provider: prov,
      telemetry: {
        acceptanceRate,
        completionRate: 98,
        qualityScore: Math.round((prov.rating || 5) * 20),
        activeOffersCount: directOffers.length + reqOffers.length,
        fieldRequestsCount: items.filter((i) => i.feedType !== 'job_offer').length,
      },
      items,
    };
  },

  /** First-accept-wins: one provider can hold status='accepted' per job. */
  async respondToOffer(offerId: string, accept: boolean) {
    const cur = await q<Record<string, unknown>>(`SELECT * FROM dispatch.assignment WHERE id=$1`, [offerId]);
    if (!cur[0] || cur[0].status !== 'offered') throw new Error('OFFER_NOT_AVAILABLE');
    const jobId = String(cur[0].job_id);
    if (!accept) {
      await q(`UPDATE dispatch.assignment SET status='declined' WHERE id=$1`, [offerId]);
      return { id: offerId, jobId, status: 'declined' as const };
    }
    const existing = await q(`SELECT id FROM dispatch.assignment WHERE job_id=$1 AND status='accepted'`, [jobId]);
    if (existing.length > 0) throw new Error('JOB_ALREADY_TAKEN');
    await q(`UPDATE dispatch.assignment SET status='accepted', accepted_at=now() WHERE id=$1`, [offerId]);
    const peers = await q<{ id: string }>(
      `SELECT id FROM dispatch.assignment WHERE job_id=$1 AND status='offered'`,
      [jobId],
    );
    for (const p of peers) {
      if (String(p.id) !== offerId) {
        await q(`UPDATE dispatch.assignment SET status='expired' WHERE id=$1`, [p.id]);
      }
    }
    emit('dispatch.accepted', { offerId, jobId });
    return { id: offerId, jobId, status: 'accepted' as const };
  },

  /** Offline sync: replays queued commands idempotently by clientEventId. */
  async sync(commands: { clientEventId: string; command: string; jobId: string }[]) {
    const map: Record<string, [JobStatus, JobStatus]> = {
      EN_ROUTE: ['PROVIDER_ACCEPTED', 'EN_ROUTE'],
      ARRIVED: ['EN_ROUTE', 'ARRIVED'],
      START: ['ARRIVED', 'IN_PROGRESS'],
      COMPLETE: ['IN_PROGRESS', 'COMPLETED'],
    };
    const results: { clientEventId: string; status: 'applied' | 'duplicate' | 'error'; detail?: string }[] = [];
    for (const c of commands) {
      const seen = await q(`SELECT 1 FROM booking.job_event WHERE client_event_id=$1`, [c.clientEventId]);
      if (seen.length > 0) { results.push({ clientEventId: c.clientEventId, status: 'duplicate' }); continue; }
      const step = map[c.command];
      if (!step) { results.push({ clientEventId: c.clientEventId, status: 'error', detail: 'UNKNOWN_COMMAND' }); continue; }
      try {
        await transition(c.jobId, step[0], step[1], 'provider', c.clientEventId);
        results.push({ clientEventId: c.clientEventId, status: 'applied' });
      } catch (e: unknown) {
        results.push({ clientEventId: c.clientEventId, status: 'error', detail: (e as Error).message });
      }
    }
    return results;
  },

  /** Storefront work gallery (provider.gallery, migration 021): clean photos in
   *  the vendor's chosen order. */
  async gallery(providerId: string): Promise<GalleryPhoto[]> {
    const rows = await q<Record<string, unknown>>(
      `SELECT g.id, g.asset_id, g.caption, g.position, g.created_at, a.url
         FROM provider.gallery g
         JOIN media.asset a ON a.id = g.asset_id
        WHERE g.provider_id = $1 AND a.status = 'clean'
        ORDER BY g.position, g.created_at`,
      [providerId],
    );
    return rows.map((r) => ({
      id: String(r.id),
      assetId: String(r.asset_id),
      url: String(r.url ?? ''),
      caption: r.caption ? String(r.caption) : null,
      position: Number(r.position ?? 0),
      createdAt: String(r.created_at),
    }));
  },

  /**
   * Append a cleared photo. Returns the whole gallery; re-adding an asset that
   * is already there returns { duplicate: true, items } and changes nothing.
   */
  async galleryAdd(providerId: string, assetId: string, caption?: string): Promise<GalleryPhoto[] | { duplicate: true; items: GalleryPhoto[] }> {
    const asset = await mediaService.get(assetId);
    if (!asset) throw new Error('ASSET_NOT_FOUND');
    // Only scanned, clean images from the photos folder (MediaAsset has no
    // `kind`; the old check compared an undefined field and rejected everything).
    if (asset.status !== 'clean' || (asset.folder && asset.folder !== 'photos') || (asset.mime && !asset.mime.startsWith('image/'))) {
      throw new Error('ASSET_NOT_CLEAN');
    }
    const existing = await q(`SELECT id FROM provider.gallery WHERE provider_id=$1 AND asset_id=$2`, [providerId, assetId]);
    if (existing[0]) return { duplicate: true, items: await this.gallery(providerId) };
    const next = await q<{ p: number | null }>(`SELECT MAX(position) AS p FROM provider.gallery WHERE provider_id=$1`, [providerId]);
    const position = next[0]?.p == null ? 0 : Number(next[0].p) + 1;
    await q(
      `INSERT INTO provider.gallery (provider_id, asset_id, caption, position) VALUES ($1,$2,$3,$4)`,
      [providerId, assetId, caption ?? null, position],
    );
    emit('provider.gallery.added', { providerId, assetId });
    return this.gallery(providerId);
  },

  async galleryRemove(providerId: string, entryId: string): Promise<{ removed: true }> {
    const rows = await q<{ id: string }>(
      `DELETE FROM provider.gallery WHERE id=$1 AND provider_id=$2 RETURNING id`,
      [entryId, providerId],
    );
    if (!rows[0]) throw new Error('NOT_FOUND');
    emit('provider.gallery.removed', { providerId, entryId });
    return { removed: true };
  },
};
