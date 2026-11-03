// Cancellation policy — PRD §26 matrix (configurable) + failed-service reason codes §27.
import type { JobStatus } from '../job-engine/job.machine.js';

export interface CancelOutcome { refundBps: number; calloutApplies: boolean; note: string; }
const MATRIX: { when: string; match: (s: JobStatus, ctx: { providerFault?: boolean; kendiboFault?: boolean }) => CancelOutcome | null }[] = [
  { when: 'before_assignment', match: (s) => ['DRAFT', 'REQUESTED', 'PAYMENT_PENDING', 'QUOTE_PENDING'].includes(s) ? { refundBps: 10000, calloutApplies: false, note: '100% before assignment' } : null },
  { when: 'assigned_no_travel', match: (s) => ['CONFIRMED', 'MATCHING', 'PROVIDER_ASSIGNED', 'PROVIDER_ACCEPTED'].includes(s) ? { refundBps: 10000, calloutApplies: false, note: '100% or policy-based' } : null },
  { when: 'en_route', match: (s) => s === 'EN_ROUTE' ? { refundBps: 8500, calloutApplies: false, note: 'Partial / policy' } : null },
  { when: 'arrived', match: (s) => ['ARRIVED', 'CHECK_IN'].includes(s) ? { refundBps: 8000, calloutApplies: true, note: 'Callout fee may apply' } : null },
  { when: 'work_started', match: (s) => ['INSPECTION', 'PRE_SERVICE', 'IN_PROGRESS', 'AWAITING_APPROVAL'].includes(s) ? { refundBps: 5000, calloutApplies: true, note: 'Refund based on performed work' } : null },
];
export function evaluateCancellation(status: JobStatus, ctx: { providerFault?: boolean; kendiboFault?: boolean } = {}): CancelOutcome {
  if (ctx.providerFault || ctx.kendiboFault) return { refundBps: 10000, calloutApplies: false, note: 'Full refund: provider/Kendibo fault' };
  for (const row of MATRIX) { const o = row.match(status, ctx); if (o) return o; }
  return { refundBps: 0, calloutApplies: false, note: 'Post-completion: use dispute flow' };
}

export const FAILED_CODES = [
  'CUSTOMER_UNAVAILABLE', 'PROPERTY_INACCESSIBLE', 'WRONG_ADDRESS', 'PROVIDER_UNAVAILABLE',
  'PROVIDER_NO_SHOW', 'UNSAFE_CONDITIONS', 'MISSING_PARTS', 'INACCURATE_DESCRIPTION', 'SCOPE_MISMATCH',
] as const;
export type FailedCode = (typeof FAILED_CODES)[number];

import { q } from '../../packages/database/db.js';

export async function markFailed(jobId: string, code: FailedCode, actor: string) {
  if (!FAILED_CODES.includes(code)) throw new Error('BAD_FAILED_CODE');
  const rows = await q<any>(`
    INSERT INTO booking.failed_job (job_id, code, actor)
    VALUES ($1, $2, $3)
    RETURNING job_id as jobId, code, actor, created_at as at
  `, [jobId, code, actor]);
  return rows[0];
}
