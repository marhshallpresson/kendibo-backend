// The rest of the job journey's guard rails:
// - reminders 24h and 1h before a scheduled job (customer and pro, once each);
// - check-in only near the job address when a fresh provider location is known;
// - the pro's check-in selfie (liveness via the KYC provider; evidence either way);
// - two-way ratings, hidden until both sides rate (or 14 days pass).
import { q } from '../../packages/database/db.js';
import { emit } from '../../packages/observability/emit.js';
import { observability } from '../../packages/observability/watchup.adapter.js';

const LIVE_STATUSES = `('REQUESTED','PAYMENT_PENDING','CONFIRMED','MATCHING','PROVIDER_ASSIGNED','PROVIDER_ACCEPTED')`;
export const CHECKIN_RADIUS_M = () => Number(process.env.CHECKIN_RADIUS_M || 250);
const LOCATION_FRESH_MS = 30 * 60_000;
export const RATING_REVEAL_MS = 14 * 86_400_000;

async function send(phone: string | null | undefined, text: string): Promise<void> {
  if (!phone) return;
  try {
    const { notifyCustomer } = await import('../whatsapp/policy.js');
    await notifyCustomer(String(phone).replace(/\D/g, ''), text);
  } catch (e) { observability.captureException(e); }
}

async function parties(bookingId: string): Promise<{ customer: string | null; provider: string | null }> {
  const c = await q<{ phone: string | null }>(`SELECT u.phone FROM booking.booking b JOIN identity.users u ON u.id=b.user_id WHERE b.id=$1`, [bookingId]).catch(() => []);
  const p = await q<{ phone: string | null }>(
    `SELECT u.phone FROM dispatch.assignment da JOIN provider.provider pr ON pr.id=da.provider_id JOIN identity.users u ON u.id=pr.user_id
      WHERE da.job_id=$1 AND da.status='accepted' LIMIT 1`, [bookingId],
  ).catch(() => []);
  return { customer: c[0]?.phone ?? null, provider: p[0]?.phone ?? null };
}

/** "Tue 12 Nov, 8am–12pm" (Lagos), using the booking's time window when it has one. */
async function whenFor(bookingId: string, iso: string): Promise<string> {
  const { bookingFacts, formatWhen } = await import('../invoices/when.js');
  const f = await bookingFacts(bookingId).catch(() => null);
  return f?.when ?? formatWhen(iso);
}

// ── Reminders ───────────────────────────────────────────────────────────────
export async function reminderSweep(now = Date.now()): Promise<{ day: number; hour: number }> {
  const in24 = new Date(now + 24 * 3600_000).toISOString();
  const in1 = new Date(now + 3600_000).toISOString();
  const nowIso = new Date(now).toISOString();
  const day = await q<{ id: string; scheduled_at: string }>(
    `SELECT id, scheduled_at FROM booking.booking WHERE reminder_24h_at IS NULL AND scheduled_at <= $1 AND scheduled_at > $2 AND upper(status) IN ${LIVE_STATUSES} LIMIT 100`,
    [in24, in1],
  ).catch(() => []);
  for (const b of day) {
    const claimed = await q(`UPDATE booking.booking SET reminder_24h_at=now() WHERE id=$1 AND reminder_24h_at IS NULL RETURNING id`, [b.id]);
    if (!claimed[0]) continue;
    const p = await parties(String(b.id));
    const when = await whenFor(String(b.id), String(b.scheduled_at));
    const { dayBeforeSummary } = await import('./schedule-updates.js');
    await send(p.customer, (await dayBeforeSummary(String(b.id)).catch(() => null)) ?? `Reminder: your Kendibo job is booked for ${when}. Reply AGENT if you need to change anything.`);
    await send(p.provider, `Reminder: you have a Kendibo job on ${when}. Open the app for the address and details.`);
  }
  const hour = await q<{ id: string; scheduled_at: string }>(
    `SELECT id, scheduled_at FROM booking.booking WHERE reminder_1h_at IS NULL AND scheduled_at <= $1 AND scheduled_at > $2 AND upper(status) IN ${LIVE_STATUSES} LIMIT 100`,
    [in1, nowIso],
  ).catch(() => []);
  for (const b of hour) {
    const claimed = await q(`UPDATE booking.booking SET reminder_1h_at=now(), reminder_24h_at=COALESCE(reminder_24h_at, now()) WHERE id=$1 AND reminder_1h_at IS NULL RETURNING id`, [b.id]);
    if (!claimed[0]) continue;
    const p = await parties(String(b.id));
    const when = await whenFor(String(b.id), String(b.scheduled_at));
    await send(p.customer, `Your Kendibo pro is due soon (${when}). You will get your start code when they set off.`);
    await send(p.provider, `Your Kendibo job starts soon (${when}). Tap "On my way" in the app when you leave.`);
  }
  if (day.length || hour.length) emit('job.reminders_sent', { day: day.length, hour: hour.length });
  return { day: day.length, hour: hour.length };
}

let reminderTimer: NodeJS.Timeout | null = null;
export function startReminderSweeper(everyMs = 5 * 60_000) {
  if (reminderTimer) return;
  reminderTimer = setInterval(() => {
    void reminderSweep().catch((e) => observability.captureException(e));
    void import('./schedule-updates.js').then((m) => m.providerEveningSweep()).catch((e) => observability.captureException(e));
  }, everyMs);
  reminderTimer.unref?.();
}

// ── Check-in distance ───────────────────────────────────────────────────────
export function metresBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000, rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function jobPoint(bookingId: string): Promise<{ lat: number; lng: number } | null> {
  const b = await q<{ job_lat: number | null; job_lng: number | null; address_id: string | null }>(`SELECT job_lat, job_lng, address_id FROM booking.booking WHERE id=$1`, [bookingId]).catch(() => []);
  if (b[0]?.job_lat != null && b[0]?.job_lng != null) return { lat: Number(b[0].job_lat), lng: Number(b[0].job_lng) };
  const r = await q<{ lat: number | null; lng: number | null }>(`SELECT lat, lng FROM booking.service_request WHERE booking_id=$1 LIMIT 1`, [bookingId]).catch(() => []);
  if (r[0]?.lat != null && r[0]?.lng != null) return { lat: Number(r[0].lat), lng: Number(r[0].lng) };
  if (b[0]?.address_id) {
    const a = await q<{ lat: number | null; lng: number | null }>(`SELECT lat, lng FROM property.address WHERE id=$1`, [b[0].address_id]).catch(() => []);
    if (a[0]?.lat != null && a[0]?.lng != null) return { lat: Number(a[0].lat), lng: Number(a[0].lng) };
  }
  return null;
}

/** 'far' blocks check-in; 'unknown' (no fresh fix or no job pin) lets it through but is logged. */
export async function checkInDistance(bookingId: string, providerId: string): Promise<{ result: 'ok' | 'far' | 'unknown'; metres?: number }> {
  const job = await jobPoint(bookingId);
  const p = await q<{ lat: number | null; lng: number | null; location_at: string | null }>(`SELECT lat, lng, location_at FROM provider.provider WHERE id=$1`, [providerId]).catch(() => []);
  const fresh = p[0]?.location_at && Date.now() - new Date(String(p[0].location_at)).getTime() < LOCATION_FRESH_MS;
  if (!job || !fresh || p[0]?.lat == null || p[0]?.lng == null) {
    emit('job.checkin_location_unknown', { bookingId });
    return { result: 'unknown' };
  }
  const metres = Math.round(metresBetween(job, { lat: Number(p[0].lat), lng: Number(p[0].lng) }));
  return { result: metres <= CHECKIN_RADIUS_M() ? 'ok' : 'far', metres };
}

// ── Check-in selfie ─────────────────────────────────────────────────────────
export const selfieRequired = () => process.env.CHECKIN_SELFIE_REQUIRED === 'true';

/** Store the pro's selfie for this job and run the KYC provider's liveness check. */
export async function recordCheckinSelfie(bookingId: string, selfieBase64: string): Promise<{ ok: boolean; reason?: string }> {
  const { mediaService } = await import('../media/media.service.js');
  const { assetId } = await mediaService.presign('photo');
  const done = await mediaService.ingest(assetId, Buffer.from(selfieBase64, 'base64'), 'image/jpeg');
  if (done.status !== 'clean') return { ok: false, reason: 'PHOTO_REJECTED' };
  let ok = false; let reason: string | undefined;
  try {
    const { selectKycAdapter } = await import('../kyc/kyc.service.js');
    const adapter = selectKycAdapter();
    const r = adapter.verifyFaceLiveness ? await adapter.verifyFaceLiveness(selfieBase64) : { passed: false, reason: 'LIVENESS_UNAVAILABLE' };
    ok = Boolean(r.passed); reason = r.passed ? undefined : String(r.reason ?? 'LIVENESS_FAILED');
  } catch (e) { observability.captureException(e); reason = 'LIVENESS_ERROR'; }
  await q(`UPDATE booking.booking SET checkin_selfie_asset=$2, checkin_selfie_ok=$3 WHERE id=$1`, [bookingId, assetId, ok]);
  emit('job.checkin_selfie', { bookingId, ok });
  return { ok, reason };
}

export async function selfiePassed(bookingId: string): Promise<boolean> {
  const r = await q<{ ok: boolean | null }>(`SELECT checkin_selfie_ok AS ok FROM booking.booking WHERE id=$1`, [bookingId]).catch(() => []);
  return r[0]?.ok === true;
}

// ── Two-way ratings ─────────────────────────────────────────────────────────
export async function rateParty(bookingId: string, role: 'customer' | 'provider', raterId: string, rating: number, comment?: string): Promise<void> {
  await q(
    `INSERT INTO review.party_rating (booking_id, rater_role, rater_id, rating, comment) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (booking_id, rater_role) DO NOTHING`, [bookingId, role, raterId, rating, comment ?? null],
  );
  // A low score from the customer goes to a person straight away.
  if (role === 'customer' && rating <= 3) {
    try {
      const { supportService } = await import('../warranties/warranty.service.js');
      await supportService.open(raterId, `Low rating (${rating}/5) on booking ${bookingId.slice(0, 8)}: ${(comment ?? '').slice(0, 300)}`, bookingId, 'high');
      emit('review.low_rating', { bookingId, rating });
    } catch (e) { observability.captureException(e); }
  }
}

/**
 * What each side can see: always its own rating; the other side's only once
 * both have rated or 14 days have passed since the first (no tit-for-tat).
 */
export async function ratingsFor(bookingId: string, viewer: 'customer' | 'provider', now = Date.now()) {
  const rows = await q<{ rater_role: string; rating: number; comment: string | null; created_at: string }>(
    `SELECT rater_role, rating, comment, created_at FROM review.party_rating WHERE booking_id=$1`, [bookingId],
  ).catch(() => []);
  const mine = rows.find((r) => r.rater_role === viewer);
  const theirs = rows.find((r) => r.rater_role !== viewer);
  const first = rows.reduce((min, r) => Math.min(min, new Date(String(r.created_at)).getTime()), Infinity);
  const revealed = rows.length === 2 || (rows.length === 1 && now - first >= RATING_REVEAL_MS);
  return {
    mine: mine ? { rating: Number(mine.rating), comment: mine.comment } : null,
    theirs: theirs && revealed ? { rating: Number(theirs.rating), comment: theirs.comment } : null,
    theirsSubmitted: Boolean(theirs),
  };
}
