// Customer and provider updates around the booked time:
// - pro assigned (name + rating);
// - booking moved by the customer or the team (old -> new time);
// - new time proposed by the pro, which the customer must accept;
// - the day-before summary (address, window, what to prepare, start code);
// - the provider's reminder the evening before.
// Every update is logged in booking.update_log so sweeps and retries never
// send it twice. The sweep runs on the reminder timer (off in tests) and is
// callable directly with a fake clock.
import { q } from '../../packages/database/db.js';
import { emit } from '../../packages/observability/emit.js';
import { observability } from '../../packages/observability/watchup.adapter.js';
import { bookingFacts, formatWhen, lagosClock, WINDOW_HOURS, type BookingFacts } from '../invoices/when.js';

const LIVE = ['REQUESTED', 'PAYMENT_PENDING', 'CONFIRMED', 'MATCHING', 'PROVIDER_ASSIGNED', 'PROVIDER_ACCEPTED'];
const firstName = (n: string | null | undefined) => String(n ?? '').trim().split(/\s+/)[0] || '';

async function tell(phone: string | null | undefined, text: string): Promise<boolean> {
  if (!phone) return false;
  try {
    const { notifyCustomer } = await import('../whatsapp/policy.js');
    await notifyCustomer(String(phone).replace(/\D/g, ''), text);
    return true;
  } catch (e) { observability.captureException(e); return false; }
}

/** Claim an update for a booking; false when it was already sent. */
export async function claimUpdate(bookingId: string, kind: string): Promise<boolean> {
  const seen = await q(`SELECT 1 FROM booking.update_log WHERE booking_id=$1 AND kind=$2`, [bookingId, kind]).catch(() => []);
  if (seen[0]) return false;
  try {
    await q(`INSERT INTO booking.update_log (booking_id, kind) VALUES ($1,$2)`, [bookingId, kind]);
    return true;
  } catch { return false; } // the other sender won
}

async function forgetUpdate(bookingId: string, kind: string): Promise<void> {
  await q(`DELETE FROM booking.update_log WHERE booking_id=$1 AND kind=$2`, [bookingId, kind]).catch(() => undefined);
}

function proLine(f: BookingFacts): string {
  const p = f.pro!;
  const record = p.jobsDone > 0 && p.rating != null ? `★${p.rating.toFixed(1)}, ${p.jobsDone} job${p.jobsDone === 1 ? '' : 's'} on Kendibo` : 'new on Kendibo, ID-checked';
  return `${p.name ?? 'A verified pro'} (${record})`;
}

/** "Your pro is …" once per booking, when a pro takes the job. */
export async function proAssignedUpdate(bookingId: string): Promise<string | null> {
  const f = await bookingFacts(bookingId);
  if (!f?.pro || !f.customer.phone) return null;
  if (!(await claimUpdate(bookingId, 'pro_assigned'))) return null;
  const text = `Your pro is ${proLine(f)}.${f.when ? ` Booked for ${f.when}.` : ''} You'll get updates here.`;
  await tell(f.customer.phone, text);
  emit('job.update_sent', { bookingId, kind: 'pro_assigned' });
  return text;
}

const PREPARE: Record<string, string> = {
  ac: 'Clear the space around your AC units and have the remote ready.',
  hvac: 'Clear the space around your AC units and have the remote ready.',
  cleaning: 'Put away valuables and anything fragile, and tell us about pets.',
  plumbing: 'Know where your main water tap is, and clear the area under the sink.',
  electrical: 'Show the pro to your meter and fuse box, and keep children away from the work area.',
  appliance: 'Empty and unplug the appliance if you can.',
  pest: 'Cover food and move pets out of the rooms being treated.',
};
async function prepareTip(bookingId: string): Promise<string> {
  const r = await q<{ category_id: string | null }>(`SELECT category_id FROM booking.service_request WHERE booking_id=$1 LIMIT 1`, [bookingId]).catch(() => []);
  return PREPARE[String(r[0]?.category_id ?? '')] ?? 'Make sure someone is home and the work area is clear.';
}

/** The customer's day-before message (used by the 24h reminder). */
export async function dayBeforeSummary(bookingId: string): Promise<string | null> {
  const f = await bookingFacts(bookingId);
  if (!f?.when) return null;
  const lines = [
    `Reminder: your Kendibo ${f.service} is booked for ${f.when}.`,
    f.address ? `Address: ${f.address}` : null,
    f.pro ? `Pro: ${proLine(f)}` : null,
    `To prepare: ${await prepareTip(bookingId)}`,
    "When your pro sets off, we'll send you a 4-digit start code. Only give it to them once they arrive.",
    'Reply AGENT if you need to change anything.',
  ];
  return lines.filter(Boolean).join('\n');
}

/** Pro's reminder from 6pm (Lagos) the evening before the job. */
export async function providerEveningSweep(now = Date.now()): Promise<number> {
  const clock = lagosClock(new Date(now));
  if (clock.h < 18) return 0;
  const tomorrow = lagosClock(new Date(now + 86_400_000)).date;
  const rows = await q<{ id: string; status: string; scheduled_at: string }>(
    `SELECT id, status, scheduled_at FROM booking.booking WHERE scheduled_at > $1 AND scheduled_at <= $2 LIMIT 200`,
    [new Date(now).toISOString(), new Date(now + 36 * 3600_000).toISOString()],
  ).catch(() => []);
  let sent = 0;
  for (const b of rows) {
    if (!LIVE.includes(String(b.status).toUpperCase())) continue;
    if (lagosClock(String(b.scheduled_at)).date !== tomorrow) continue;
    const f = await bookingFacts(String(b.id));
    if (!f?.pro?.phone || !f.when) continue;
    if (!(await claimUpdate(f.id, 'provider_evening'))) continue;
    const who = firstName(f.customer.name);
    await tell(f.pro.phone, `Tomorrow: ${f.service}, ${f.when}.${f.address ? ` Address: ${f.address}.` : ''}${who ? ` Customer: ${who}.` : ''} Tap "On my way" in the app when you leave. The customer gives you the start code when you arrive.`);
    sent++;
  }
  if (sent) emit('job.update_sent', { kind: 'provider_evening', count: sent });
  return sent;
}

/** Reset the time-based reminders after a move, so they fire for the new time. */
async function resetReminders(bookingId: string): Promise<void> {
  await q(`UPDATE booking.booking SET reminder_24h_at=NULL, reminder_1h_at=NULL WHERE id=$1`, [bookingId]);
  await forgetUpdate(bookingId, 'provider_evening');
}

function checkTime(toIso: string, window?: string | null): Date {
  const to = new Date(toIso);
  if (!Number.isFinite(to.getTime())) throw new Error('BAD_TIME');
  if (to.getTime() < Date.now() - 5 * 60_000) throw new Error('TIME_IN_PAST');
  if (window && !(window in WINDOW_HOURS)) throw new Error('BAD_WINDOW');
  return to;
}

/**
 * Move a booking (customer, team, or a pro's proposal the customer accepted).
 * Records the move, resets the reminders and tells both sides old -> new.
 */
export async function changeBookingTime(bookingId: string, toIso: string, window: string | null, actor: { as: 'customer' | 'admin' | 'provider'; id: string }): Promise<{ from: string | null; to: string }> {
  const to = checkTime(toIso, window);
  const f = await bookingFacts(bookingId);
  if (!f) throw new Error('NOT_FOUND');
  if (!LIVE.includes(f.status)) throw new Error('TOO_LATE_TO_MOVE');
  const fromText = f.when;
  await q(`UPDATE booking.booking SET scheduled_at=$2, time_window=$3 WHERE id=$1`, [bookingId, to.toISOString(), window]);
  await resetReminders(bookingId);
  const toText = formatWhen(to, window);
  await q(`INSERT INTO booking.reschedule (job_id, from_slot, to_slot, actor) VALUES ($1,$2,$3,$4)`, [bookingId, f.scheduledAt ?? '', to.toISOString(), `${actor.as}:${actor.id}`]).catch(() => undefined);
  const moved = fromText ? `from ${fromText} to ${toText}` : `to ${toText}`;
  const byPro = actor.as === 'provider';
  await tell(f.customer.phone, byPro
    ? `Done: your booking is now ${toText} (was ${fromText ?? 'not set'}). Your pro has been told.`
    : `Your Kendibo booking has moved ${moved}. Your pro has been told.`);
  if (f.pro?.phone) await tell(f.pro.phone, byPro
    ? `The customer accepted the new time: ${toText}.`
    : `Booking moved ${moved}. Please plan for the new time.`);
  emit('job.rescheduled', { bookingId, by: actor.as });
  return { from: fromText, to: toText };
}

/** The pro asks for a new time. Nothing changes until the customer accepts. */
export async function proposeNewTime(bookingId: string, providerId: string, toIso: string, window: string | null): Promise<{ id: string; text: string }> {
  const to = checkTime(toIso, window);
  const f = await bookingFacts(bookingId);
  if (!f || f.pro?.providerId !== providerId) throw new Error('NOT_YOUR_JOB');
  if (!LIVE.includes(f.status)) throw new Error('TOO_LATE_TO_MOVE');
  await q(`UPDATE booking.schedule_change SET status='superseded' WHERE booking_id=$1 AND status='pending'`, [bookingId]);
  const r = await q<{ id: string }>(
    `INSERT INTO booking.schedule_change (booking_id, from_at, to_at, to_window, proposed_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [bookingId, f.scheduledAt, to.toISOString(), window, `provider:${providerId}`],
  );
  const id = String(r[0].id);
  const toText = formatWhen(to, window);
  const text = `${f.pro?.name ?? 'Your pro'} asked to change your booking from ${f.when ?? 'the agreed time'} to ${toText}. Is the new time OK?`;
  if (f.customer.phone) {
    const waId = f.customer.phone.replace(/\D/g, '');
    try {
      const { sendBusinessInitiated } = await import('../whatsapp/policy.js');
      const { wa } = await import('../whatsapp/whatsapp.client.js');
      await sendBusinessInitiated({
        waId,
        whatsapp: () => wa.buttons(waId, text, [{ id: `sched:accept:${id}`, title: 'Accept new time' }, { id: `sched:decline:${id}`, title: 'Keep old time' }]),
        template: { key: 'request_update', params: [`${text} Reply in the Kendibo app or on WhatsApp`] },
        sms: `${text} Open the Kendibo app or WhatsApp to accept or keep the old time.`,
      });
    } catch (e) { observability.captureException(e); }
  }
  emit('job.time_proposed', { bookingId });
  return { id, text };
}

/** Customer answers the pro's proposal (app button or WhatsApp `sched:accept:<id>` / `sched:decline:<id>`). */
export async function answerScheduleChange(changeId: string, userId: string, accept: boolean): Promise<'accepted' | 'declined' | 'gone'> {
  if (!/^[0-9a-f-]{36}$/i.test(changeId)) return 'gone';
  const r = await q<{ booking_id: string; to_at: string; to_window: string | null; status: string; user_id: string }>(
    `SELECT c.booking_id, c.to_at, c.to_window, c.status, b.user_id FROM booking.schedule_change c JOIN booking.booking b ON b.id=c.booking_id WHERE c.id=$1`, [changeId],
  ).catch(() => []);
  const c = r[0];
  if (!c || String(c.user_id) !== userId || c.status !== 'pending') return 'gone';
  const claimed = await q(`UPDATE booking.schedule_change SET status=$2, responded_at=now() WHERE id=$1 AND status='pending' RETURNING id`, [changeId, accept ? 'accepted' : 'declined']);
  if (!claimed[0]) return 'gone';
  const bookingId = String(c.booking_id);
  if (accept) {
    await changeBookingTime(bookingId, new Date(String(c.to_at)).toISOString(), c.to_window, { as: 'provider', id: userId });
    return 'accepted';
  }
  const f = await bookingFacts(bookingId);
  await tell(f?.customer.phone, `OK, your booking stays at ${f?.when ?? 'the agreed time'}.`);
  if (f?.pro?.phone) await tell(f.pro.phone, `The customer kept the original time: ${f.when ?? 'as agreed'}. Reply AGENT if you can't make it.`);
  return 'declined';
}
