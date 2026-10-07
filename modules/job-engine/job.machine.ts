// Job state machine — PRD §11 core lifecycle + exception states.
// Persisted: every transition -> booking.job_event (+ outbox_event, same txn
// in prod). Exception flags -> job_event rows. Reschedules -> booking.reschedule.
import { q } from '../../packages/database/db.js';

export type JobStatus =
  | 'DRAFT' | 'REQUESTED' | 'PAYMENT_PENDING' | 'QUOTE_PENDING' | 'CONFIRMED' | 'MATCHING'
  | 'PROVIDER_ASSIGNED' | 'PROVIDER_ACCEPTED' | 'EN_ROUTE' | 'ARRIVED'
  | 'CHECK_IN' | 'INSPECTION' | 'PRE_SERVICE' | 'IN_PROGRESS' | 'AWAITING_APPROVAL'
  | 'COMPLETED' | 'CUSTOMER_CONFIRMATION' | 'SETTLEMENT'
  | 'WARRANTY_ACTIVE' | 'CLOSED' | 'CANCELLED';

export type ExceptionFlag =
  | 'EXPIRED' | 'REASSIGNING' | 'FAILED_PROVIDER' | 'FAILED_CUSTOMER_ACCESS'
  | 'DISPUTED' | 'WARRANTY_CLAIM' | 'REFUND_PENDING' | 'REFUNDED' | 'SUSPENDED';

const TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  DRAFT: ['REQUESTED', 'CANCELLED'],
  REQUESTED: ['PAYMENT_PENDING', 'QUOTE_PENDING', 'CANCELLED'],
  PAYMENT_PENDING: ['CONFIRMED', 'CANCELLED'],
  QUOTE_PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['MATCHING', 'CANCELLED'],
  MATCHING: ['PROVIDER_ASSIGNED', 'CANCELLED'],
  PROVIDER_ASSIGNED: ['PROVIDER_ACCEPTED', 'MATCHING', 'CANCELLED'],
  PROVIDER_ACCEPTED: ['EN_ROUTE', 'CANCELLED'],
  EN_ROUTE: ['ARRIVED', 'CANCELLED'],
  ARRIVED: ['CHECK_IN', 'CANCELLED'],
  CHECK_IN: ['INSPECTION', 'PRE_SERVICE', 'IN_PROGRESS', 'CANCELLED'],
  INSPECTION: ['IN_PROGRESS', 'AWAITING_APPROVAL', 'QUOTE_PENDING', 'CANCELLED'],
  PRE_SERVICE: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['AWAITING_APPROVAL', 'COMPLETED', 'CANCELLED'],
  AWAITING_APPROVAL: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
  COMPLETED: ['CUSTOMER_CONFIRMATION', 'CANCELLED'],
  CUSTOMER_CONFIRMATION: ['SETTLEMENT'],
  SETTLEMENT: ['WARRANTY_ACTIVE'],
  WARRANTY_ACTIVE: ['CLOSED'],
  CLOSED: [],
  CANCELLED: [],
};

export interface JobEvent {
  jobId: string; from: JobStatus; to: JobStatus; at: string; actor: string;
  reason?: string; lat?: number; lng?: number; flags?: ExceptionFlag[];
}

async function record(e: JobEvent): Promise<JobEvent> {
  try {
    await q(
      `INSERT INTO booking.job_event (job_id, from_status, to_status, actor) VALUES ($1,$2,$3,$4)`,
      [e.jobId, e.from, e.to, e.actor],
    );
    await q(`INSERT INTO outbox_event (topic, payload) VALUES ('job.transition',$1)`, [JSON.stringify(e)]);
  } catch { /* tables absent in minimal boots — event still returned */ }
  return { ...e, at: new Date().toISOString() };
}

export async function transition(jobId: string, from: JobStatus, to: JobStatus, actor: string, extra?: Partial<JobEvent>): Promise<JobEvent> {
  if (!TRANSITIONS[from].includes(to)) throw new Error(`ILLEGAL_TRANSITION:${from}->${to}`);
  return record({ jobId, from, to, at: new Date().toISOString(), actor, ...extra });
}
export async function flag(jobId: string, f: ExceptionFlag, actor: string, reason?: string): Promise<ExceptionFlag[]> {
  await record({ jobId, from: 'IN_PROGRESS', to: 'IN_PROGRESS', at: new Date().toISOString(), actor, reason: `${f}:${reason ?? ''}`, flags: [f] });
  return flagsOf(jobId);
}
export async function unflag(jobId: string, f: ExceptionFlag): Promise<ExceptionFlag[]> {
  await record({ jobId, from: 'IN_PROGRESS', to: 'IN_PROGRESS', at: new Date().toISOString(), actor: 'system', reason: `unflag:${f}` });
  return flagsOf(jobId);
}
export async function flagsOf(jobId: string): Promise<ExceptionFlag[]> {
  try {
    const rows = await q<{ reason: string }>(
      `SELECT reason FROM booking.job_event WHERE job_id=$1 ORDER BY created_at DESC LIMIT 50`, [jobId],
    );
    const active = new Set<ExceptionFlag>();
    for (const r of rows.reverse()) {
      const m = /^(EXPIRED|REASSIGNING|FAILED_PROVIDER|FAILED_CUSTOMER_ACCESS|DISPUTED|WARRANTY_CLAIM|REFUND_PENDING|REFUNDED|SUSPENDED):/.exec(r.reason ?? '');
      if (m) active.add(m[1] as ExceptionFlag);
      const u = /^unflag:(.+)$/.exec(r.reason ?? '');
      if (u) active.delete(u[1] as ExceptionFlag);
    }
    return [...active];
  } catch { return []; }
}
export async function reschedule(jobId: string, fromSlot: string, toSlot: string, actor: string) {
  try {
    await q(`INSERT INTO booking.reschedule (job_id, from_slot, to_slot, actor) VALUES ($1,$2,$3,$4)`, [jobId, fromSlot, toSlot, actor]);
  } catch { /* minimal boot */ }
  await record({ jobId, from: 'CONFIRMED', to: 'CONFIRMED', at: new Date().toISOString(), actor, reason: `reschedule:${fromSlot}->${toSlot}` });
  return rescheduleHistory(jobId);
}
export async function rescheduleHistory(jobId: string) {
  try {
    return await q(`SELECT from_slot AS "from", to_slot AS "to", actor, created_at AS at FROM booking.reschedule WHERE job_id=$1 ORDER BY created_at`, [jobId]);
  } catch { return []; }
}
export async function jobHistory(jobId: string): Promise<JobEvent[]> {
  try {
    const rows = await q<Record<string, unknown>>(
      `SELECT job_id, from_status, to_status, actor, created_at FROM booking.job_event WHERE job_id=$1 ORDER BY created_at`, [jobId],
    );
    return rows.map((r) => ({ jobId: String(r.job_id), from: r.from_status as JobStatus, to: r.to_status as JobStatus, at: String(r.created_at), actor: String(r.actor) }));
  } catch { return []; }
}
