// Session mode: every service request is a "session" with a short human tag
// (AC-4821). A customer with several open requests picks the one we're talking
// about with /switch AC-4821 (or just sends the tag); status, pay, reschedule,
// cancel and invoice act on that active session.
import { randomInt } from 'node:crypto';
import { q } from '../../packages/database/db.js';

const PREFIX: Record<string, string> = {
  ac: 'AC', cleaning: 'CLN', plumbing: 'PLB', electrical: 'ELC', generator: 'GEN',
  handyman: 'HDY', appliance: 'APL', pest: 'PST',
};
const CLOSED = ['CANCELLED', 'EXPIRED', 'CLOSED', 'COMPLETED'];
const BOOKING_CLOSED = ['COMPLETED', 'CANCELLED', 'REFUNDED', 'CLOSED'];

/** A tag looks like AC-4821: 2 to 5 letters, a dash, 4 digits. */
export const TAG_RE = /^([A-Za-z]{2,5})-(\d{4})$/;

/**
 * Tag letters for a category. The 8 original trades keep their familiar
 * prefixes (AC, CLN, PLB, …); any other id is derived from its words:
 * 'borehole' -> BOR, 'solar-inverter' -> SOI, 'water-tank-cleaning' -> WATC.
 */
export function tagPrefix(categoryId: string | null): string {
  if (!categoryId) return 'JOB';
  if (PREFIX[categoryId]) return PREFIX[categoryId];
  const words = categoryId.toUpperCase().replace(/^PROD[-_]/, '').split(/[^A-Z]+/).filter(Boolean);
  if (!words.length) return 'JOB';
  const out = words.length === 1 ? words[0].slice(0, 3) : (words[0].slice(0, 2) + words.slice(1).map((w) => w[0]).join('')).slice(0, 5);
  return out.length >= 2 ? out : 'JOB';
}

export interface OpenSession {
  id: string; tag: string; title: string; status: string; categoryId: string | null; categoryName: string | null;
  bookingId: string | null; bookingStatus: string | null; scheduledDate: string | null; createdAt: string; pro: string | null;
}

/** Give a new request its tag and make it the user's active session. */
export async function assignSessionTag(requestId: string, userId: string, categoryId: string | null): Promise<string | null> {
  const prefix = tagPrefix(categoryId);
  for (let i = 0; i < 8; i++) {
    const tag = `${prefix}-${randomInt(1000, 10000)}`;
    const taken = await q(`SELECT 1 FROM booking.service_request WHERE session_tag=$1`, [tag]);
    if (taken[0]) continue;
    try {
      await q(`UPDATE booking.service_request SET session_tag=$2 WHERE id=$1`, [requestId, tag]);
    } catch { continue; } // lost a race on the unique index: try another number
    await setActiveTag(userId, tag);
    return tag;
  }
  return null;
}

export async function setActiveTag(userId: string, tag: string): Promise<void> {
  await q(`DELETE FROM messaging.whatsapp_active_session WHERE user_id=$1`, [userId]);
  await q(`INSERT INTO messaging.whatsapp_active_session (user_id, session_tag) VALUES ($1,$2)`, [userId, tag.toUpperCase()]);
}

/** Open requests (not cancelled, and not finished), newest first. */
export async function openSessions(userId: string): Promise<OpenSession[]> {
  const rows = await q<Record<string, unknown>>(
    `SELECT r.id, r.session_tag, r.title, r.status, r.category_id, COALESCE(c.short_name, c.name) AS category_name, r.booking_id, b.status AS booking_status,
            r.scheduled_date, r.created_at, p.business_name AS pro
       FROM booking.service_request r
       LEFT JOIN catalog.category c ON c.id = r.category_id
       LEFT JOIN booking.booking b ON b.id = r.booking_id
       LEFT JOIN booking.request_offer o ON o.request_id = r.id AND o.status = 'accepted'
       LEFT JOIN provider.provider p ON p.id = o.provider_id
      WHERE r.user_id=$1
      ORDER BY r.created_at DESC LIMIT 30`, [userId],
  );
  const seen = new Set<string>();
  const out: OpenSession[] = [];
  for (const r of rows) {
    const id = String(r.id);
    if (seen.has(id) || !r.session_tag) continue; // (filtered here: pg-mem mishandles IS NOT NULL next to an index)
    seen.add(id);
    const status = String(r.status ?? '').toUpperCase();
    const bStatus = r.booking_status ? String(r.booking_status).toUpperCase() : null;
    if (CLOSED.includes(status) || (bStatus && BOOKING_CLOSED.includes(bStatus))) continue;
    const day = r.scheduled_date instanceof Date ? r.scheduled_date.toISOString().slice(0, 10) : r.scheduled_date ? String(r.scheduled_date).slice(0, 10) : null;
    out.push({
      id, tag: String(r.session_tag), title: String(r.title ?? ''), status, categoryId: r.category_id ? String(r.category_id) : null,
      categoryName: r.category_name ? String(r.category_name) : null, bookingId: r.booking_id ? String(r.booking_id) : null,
      bookingStatus: bStatus, scheduledDate: day, createdAt: String(r.created_at), pro: r.pro ? String(r.pro) : null,
    });
  }
  return out;
}

/** The request the customer is talking about: the chosen tag if still open, else the newest open one. */
export async function activeRequestFor(userId: string): Promise<OpenSession | null> {
  const open = await openSessions(userId);
  if (!open.length) return null;
  const a = await q<{ session_tag: string }>(`SELECT session_tag FROM messaging.whatsapp_active_session WHERE user_id=$1`, [userId]).catch(() => []);
  const tag = a[0]?.session_tag ? String(a[0].session_tag) : null;
  return open.find((s) => s.tag === tag) ?? open[0];
}

/** Make the session with this tag active. Returns it, or null if it isn't one of the user's open sessions. */
export async function switchSession(userId: string, tag: string): Promise<OpenSession | null> {
  const want = tag.trim().toUpperCase();
  const hit = (await openSessions(userId)).find((s) => s.tag === want) ?? null;
  if (hit) await setActiveTag(userId, hit.tag);
  return hit;
}

/** "[AC-4821] " when the user has more than one open session, so replies are never ambiguous. */
export async function sessionPrefix(userId: string, s: OpenSession | null): Promise<string> {
  if (!s) return '';
  return (await openSessions(userId)).length > 1 ? `[${s.tag}] ` : '';
}

// Plain words for the customer, never the internal status codes.
const FRIENDLY: Record<string, string> = {
  SUBMITTED: 'finding you a pro', MATCHING: 'finding you a pro', OFFERED: 'waiting for a pro to accept',
  ACCEPTED: 'a pro accepted', BOOKED: 'booked', REQUESTED: 'waiting for payment', PAYMENT_PENDING: 'waiting for payment',
  CONFIRMED: 'paid and booked', EN_ROUTE: 'pro is on the way', ARRIVED: 'pro has arrived', IN_PROGRESS: 'job in progress',
  AWAITING_CONFIRMATION: 'waiting for you to confirm', DISPUTED: 'our team is looking into it',
};
const pretty = (v: string) => FRIENDLY[v] ?? v.replace(/_/g, ' ').toLowerCase();
const prettyDay = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Africa/Lagos' });
const createdDay = (raw: string) => {
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : `asked ${d.toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Africa/Lagos' })}`;
};

/** One line per session: tag, service, status, date (booked day, else the day it was asked), pro. */
export function describeSession(s: OpenSession): string {
  return [
    s.tag,
    s.categoryName ?? s.title.slice(0, 40),
    pretty(s.bookingStatus ?? s.status),
    s.scheduledDate ? prettyDay(s.scheduledDate) : createdDay(s.createdAt),
    s.pro ? `pro: ${s.pro}` : null,
  ].filter(Boolean).join(' · ');
}
