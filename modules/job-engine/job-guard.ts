// Who may move a job, the start code read out at the door, and two-sided
// completion. Patterns from Urban Company (start code), Uber (4-digit PIN,
// 5 tries) and Upwork/Airtasker (customer confirms; auto-release after a quiet
// period unless disputed).
import { randomInt } from 'node:crypto';
import { q } from '../../packages/database/db.js';
import { emit } from '../../packages/observability/emit.js';
import { observability } from '../../packages/observability/watchup.adapter.js';
import { transition, flagsOf, type JobStatus } from './job.machine.js';

export type Party = 'customer' | 'provider' | 'admin' | 'system';

const PROVIDER_STEPS = new Set<JobStatus>(['PROVIDER_ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'CHECK_IN', 'INSPECTION', 'PRE_SERVICE', 'AWAITING_APPROVAL', 'COMPLETED', 'QUOTE_PENDING']);
const MAX_CODE_TRIES = 5;
export const AUTO_CONFIRM_MS = 48 * 3600_000;

/** null when allowed, otherwise a plain reason. Admin and system may do anything legal. */
export function whyNot(as: Party, from: JobStatus, to: JobStatus): string | null {
  if (as === 'admin' || as === 'system') return null;
  if (to === 'CANCELLED') return null; // fees and rules live in the cancellation flow
  if (to === 'CUSTOMER_CONFIRMATION') return as === 'customer' ? null : 'Only the customer can confirm the job is done.';
  if (to === 'IN_PROGRESS') {
    if (from === 'AWAITING_APPROVAL') return as === 'customer' ? null : 'The customer must approve this first.';
    return as === 'provider' ? null : 'Only the provider can start the work.';
  }
  if (PROVIDER_STEPS.has(to)) return as === 'provider' ? null : 'Only the provider can do this.';
  return 'Kendibo does this step automatically.';
}

/** The customer's 4-digit start code (created on first use, never shown to the provider). */
export async function ensureStartCode(bookingId: string): Promise<string> {
  const r = await q<{ start_code: string | null }>(`SELECT start_code FROM booking.booking WHERE id=$1`, [bookingId]);
  if (r[0]?.start_code) return String(r[0].start_code);
  const code = String(randomInt(0, 10000)).padStart(4, '0');
  await q(`UPDATE booking.booking SET start_code=$2, start_code_attempts=0 WHERE id=$1 AND start_code IS NULL`, [bookingId, code]);
  const again = await q<{ start_code: string }>(`SELECT start_code FROM booking.booking WHERE id=$1`, [bookingId]);
  return String(again[0]?.start_code ?? code);
}

/** Provider typed the code the customer read out. Five wrong tries locks it until support resets it. */
export async function checkStartCode(bookingId: string, code: string | undefined): Promise<'ok' | 'wrong' | 'locked' | 'missing'> {
  const r = await q<{ start_code: string | null; start_code_attempts: number }>(`SELECT start_code, start_code_attempts FROM booking.booking WHERE id=$1`, [bookingId]);
  const row = r[0];
  if (!row?.start_code) return 'missing';
  if (Number(row.start_code_attempts) >= MAX_CODE_TRIES) return 'locked';
  if (String(code ?? '').trim() === String(row.start_code)) return 'ok';
  await q(`UPDATE booking.booking SET start_code_attempts=start_code_attempts+1 WHERE id=$1`, [bookingId]);
  emit('job.start_code_wrong', { bookingId });
  return Number(row.start_code_attempts) + 1 >= MAX_CODE_TRIES ? 'locked' : 'wrong';
}

async function customerPhone(bookingId: string): Promise<{ phone: string | null; name: string | null }> {
  const r = await q<{ phone: string | null; name: string | null }>(
    `SELECT u.phone, u.name FROM booking.booking b JOIN identity.users u ON u.id=b.user_id WHERE b.id=$1`, [bookingId],
  ).catch(() => []);
  return { phone: r[0]?.phone ?? null, name: r[0]?.name ?? null };
}

async function tellCustomer(bookingId: string, text: string): Promise<void> {
  const { phone } = await customerPhone(bookingId);
  if (!phone) return;
  try {
    const { notifyCustomer } = await import('../whatsapp/policy.js');
    await notifyCustomer(phone.replace(/\D/g, ''), text);
  } catch (e) { observability.captureException(e); }
}

/** Messages and timestamps that go with a move (best effort; never blocks the move). */
export async function afterTransition(bookingId: string, to: JobStatus): Promise<void> {
  if (to === 'EN_ROUTE') {
    const code = await ensureStartCode(bookingId);
    await tellCustomer(bookingId, `Your Kendibo pro is on the way. When they arrive, check it is the person in the app, then give them this start code: ${code}. Don't share it before they arrive.`);
  } else if (to === 'COMPLETED') {
    await q(`UPDATE booking.booking SET provider_completed_at=now() WHERE id=$1`, [bookingId]);
    await tellCustomer(bookingId, "Your pro says the job is done. Reply DONE to confirm, or PROBLEM if something isn't right. If we don't hear from you within 48 hours, we'll mark it as done.");
  } else if (to === 'CUSTOMER_CONFIRMATION') {
    await q(`UPDATE booking.booking SET customer_confirmed_at=now() WHERE id=$1`, [bookingId]);
  }
}

async function latestStatus(jobId: string): Promise<JobStatus | null> {
  const r = await q<{ to_status: string }>(`SELECT to_status FROM booking.job_event WHERE job_id=$1 ORDER BY created_at DESC LIMIT 1`, [jobId]).catch(() => []);
  return (r[0]?.to_status as JobStatus) ?? null;
}

/** Customer confirms the job is done (app, WhatsApp DONE, or the auto-confirm timer). */
export async function confirmCompletion(bookingId: string, actor: Party): Promise<'confirmed' | 'not_ready' | 'disputed'> {
  const status = await latestStatus(bookingId);
  if (status !== 'COMPLETED') return 'not_ready';
  if ((await flagsOf(bookingId)).includes('DISPUTED')) return 'disputed';
  await transition(bookingId, 'COMPLETED', 'CUSTOMER_CONFIRMATION', actor);
  await afterTransition(bookingId, 'CUSTOMER_CONFIRMATION');
  emit('job.customer_confirmed', { bookingId, actor });
  return 'confirmed';
}

/** Jobs marked done by the pro with no answer from the customer for 48h, and no dispute. */
export async function autoConfirmSweep(now = Date.now()): Promise<number> {
  const due = await q<{ id: string }>(
    `SELECT id FROM booking.booking WHERE provider_completed_at IS NOT NULL AND customer_confirmed_at IS NULL AND provider_completed_at < $1 LIMIT 50`,
    [new Date(now - AUTO_CONFIRM_MS).toISOString()],
  ).catch(() => []);
  let n = 0;
  for (const b of due) {
    const out = await confirmCompletion(String(b.id), 'system').catch(() => 'not_ready');
    if (out === 'confirmed') {
      n++;
      await tellCustomer(String(b.id), "We've marked your job as done, as we didn't hear back in 48 hours. If something isn't right, reply PROBLEM and our team will look into it.");
    }
  }
  return n;
}

let sweeper: NodeJS.Timeout | null = null;
export function startCompletionSweeper(everyMs = 15 * 60_000) {
  if (sweeper) return;
  sweeper = setInterval(() => { void autoConfirmSweep().catch((e) => observability.captureException(e)); }, everyMs);
  sweeper.unref?.();
}

/** Latest booking of this customer that the pro has marked done and is waiting on them. */
export async function awaitingConfirmationFor(userId: string): Promise<string | null> {
  const r = await q<{ id: string }>(
    `SELECT id FROM booking.booking WHERE user_id=$1 AND provider_completed_at IS NOT NULL AND customer_confirmed_at IS NULL ORDER BY provider_completed_at DESC LIMIT 1`, [userId],
  ).catch(() => []);
  return r[0] ? String(r[0].id) : null;
}
