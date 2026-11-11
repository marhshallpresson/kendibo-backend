// Shared booking facts for customer documents and schedule updates: the time
// in Lagos ("Tue 12 Nov, 8am–12pm"), the address, the trade and the pro.
import { q } from '../../packages/database/db.js';

export type TimeWindow = 'morning' | 'afternoon' | 'evening';
/** Same windows the WhatsApp flow offers (Morning 8–12, Afternoon 12–4, Evening 4–7). */
export const WINDOW_HOURS: Record<TimeWindow, [number, number]> = { morning: [8, 12], afternoon: [12, 16], evening: [16, 19] };

const TZ = 'Africa/Lagos';
const hourText = (h: number, m = 0) => {
  const suffix = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, '0')}${suffix}` : `${h12}${suffix}`;
};

/** "Tue 12 Nov" in Lagos. */
export function dayText(iso: string | Date): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('weekday')} ${get('day')} ${get('month')}`;
}

/** Lagos wall-clock hour and minute of an instant. */
export function lagosClock(iso: string | Date): { h: number; m: number; date: string } {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TZ }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  return { h: Number(get('hour')), m: Number(get('minute')), date: `${get('year')}-${get('month')}-${get('day')}` };
}

/** "Tue 12 Nov, 8am–12pm" with a window, else "Tue 12 Nov, 9:30am". */
export function formatWhen(iso: string | Date, window?: string | null): string {
  // Named window ("morning") or the request's "08:00-12:00" form.
  const range = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(window ?? '').trim());
  if (range) return `${dayText(iso)}, ${hourText(Number(range[1]), Number(range[2]))}–${hourText(Number(range[3]), Number(range[4]))}`;
  const w = window && window in WINDOW_HOURS ? WINDOW_HOURS[window as TimeWindow] : null;
  if (w) return `${dayText(iso)}, ${hourText(w[0])}–${hourText(w[1])}`;
  const { h, m } = lagosClock(iso);
  return `${dayText(iso)}, ${hourText(h, m)}`;
}

export interface BookingFacts {
  id: string; userId: string; status: string; scheduledAt: string | null; window: string | null; when: string | null;
  service: string; address: string | null;
  customer: { name: string | null; phone: string | null };
  pro: { providerId: string; name: string | null; phone: string | null; rating: number | null; jobsDone: number } | null;
}

export async function bookingFacts(bookingId: string): Promise<BookingFacts | null> {
  const b = await q<Record<string, unknown>>(
    `SELECT b.id, b.user_id, b.status, b.service_id, b.scheduled_at, b.time_window, b.address_id, u.name, u.phone
       FROM booking.booking b JOIN identity.users u ON u.id=b.user_id WHERE b.id=$1`, [bookingId],
  ).catch(() => []);
  const row = b[0];
  if (!row) return null;
  const req = await q<{ id: string; title: string | null; time_window: string | null; address_id: string | null; category_id: string | null }>(
    `SELECT id, title, time_window, address_id, category_id FROM booking.service_request WHERE booking_id=$1 LIMIT 1`, [bookingId],
  ).catch(() => []);
  const svc = await q<{ name: string }>(`SELECT name FROM catalog.service WHERE id=$1`, [row.service_id]).catch(() => []);
  let address: string | null = null;
  let draftWindow: string | null = null;
  if (req[0]) {
    const d = await q<{ address_text: string | null; landmark: string | null; time_window: string | null }>(
      `SELECT address_text, landmark, time_window FROM messaging.whatsapp_job_draft WHERE request_id=$1 LIMIT 1`, [req[0].id],
    ).catch(() => []);
    if (d[0]?.address_text) address = [d[0].address_text, d[0].landmark].filter(Boolean).join(', ');
    draftWindow = d[0]?.time_window ? String(d[0].time_window) : null;
  }
  const addrId = row.address_id ?? req[0]?.address_id;
  if (!address && addrId) {
    const a = await q<Record<string, string | null>>(`SELECT house_number, street, estate, landmark FROM property.address WHERE id=$1`, [addrId]).catch(() => []);
    if (a[0]) address = [a[0].house_number, a[0].street, a[0].estate, a[0].landmark].filter(Boolean).join(', ') || null;
  }
  const pro = await q<{ id: string; business_name: string | null; name: string | null; phone: string | null; rating: number | null }>(
    `SELECT pr.id, pr.business_name, u.name, u.phone, pr.rating FROM dispatch.assignment da JOIN provider.provider pr ON pr.id=da.provider_id
       JOIN identity.users u ON u.id=pr.user_id WHERE da.job_id=$1 AND da.status='accepted' LIMIT 1`, [bookingId],
  ).catch(() => []);
  let jobsDone = 0;
  if (pro[0]) {
    const n = await q<{ n: string }>(`SELECT COUNT(*) AS n FROM provider.earning WHERE provider_id=$1`, [pro[0].id]).catch(() => []);
    jobsDone = Number(n[0]?.n ?? 0);
  }
  const scheduledAt = row.scheduled_at ? new Date(String(row.scheduled_at)).toISOString() : null;
  const window = (row.time_window ?? req[0]?.time_window ?? draftWindow ?? null) as string | null;
  return {
    id: String(row.id), userId: String(row.user_id), status: String(row.status).toUpperCase(),
    scheduledAt, window, when: scheduledAt ? formatWhen(scheduledAt, window) : null,
    service: String(svc[0]?.name ?? req[0]?.title ?? 'home service'),
    address,
    customer: { name: row.name ? String(row.name) : null, phone: row.phone ? String(row.phone) : null },
    pro: pro[0] ? {
      providerId: String(pro[0].id), name: String(pro[0].business_name ?? pro[0].name ?? '') || null,
      phone: pro[0].phone ? String(pro[0].phone) : null, rating: pro[0].rating == null ? null : Number(pro[0].rating), jobsDone,
    } : null,
  };
}
