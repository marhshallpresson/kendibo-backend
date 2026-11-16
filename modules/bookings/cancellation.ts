// Cancellation policy — PRD §26 matrix (configurable) + failed-service reason codes §27.
import type { JobStatus } from '../job-engine/job.machine.js';

// Refund percentages and callout flags per stage are admin-editable
// (pricing.config.ts, 'pricing.config' setting); the stage mapping stays here.
import { DEFAULT_PRICING_CONFIG, pricingConfig, type CancelStage, type PricingConfig } from '../pricing/pricing.config.js';

export interface CancelOutcome { refundBps: number; calloutApplies: boolean; note: string; }
const STAGES: { when: CancelStage; statuses: string[]; note: string }[] = [
  { when: 'before_assignment', statuses: ['DRAFT', 'REQUESTED', 'PAYMENT_PENDING', 'QUOTE_PENDING'], note: 'Before assignment' },
  { when: 'assigned_no_travel', statuses: ['CONFIRMED', 'MATCHING', 'PROVIDER_ASSIGNED', 'PROVIDER_ACCEPTED'], note: 'Assigned, not yet travelling' },
  { when: 'en_route', statuses: ['EN_ROUTE'], note: 'Provider on the way' },
  { when: 'arrived', statuses: ['ARRIVED', 'CHECK_IN'], note: 'Provider arrived; callout fee may apply' },
  { when: 'work_started', statuses: ['INSPECTION', 'PRE_SERVICE', 'IN_PROGRESS', 'AWAITING_APPROVAL'], note: 'Work started; refund based on work done' },
];
/** Pure evaluation against a given policy (defaults when none is passed). */
export function evaluateCancellation(
  status: JobStatus,
  ctx: { providerFault?: boolean; kendiboFault?: boolean } = {},
  policy: PricingConfig['cancellation'] = DEFAULT_PRICING_CONFIG.cancellation,
): CancelOutcome {
  if (ctx.providerFault || ctx.kendiboFault) return { refundBps: 10000, calloutApplies: false, note: 'Full refund: provider/Kendibo fault' };
  const row = STAGES.find((r) => r.statuses.includes(status));
  if (row) return { ...policy[row.when], note: `${row.note} — ${policy[row.when].refundBps / 100}% refund` };
  return { refundBps: 0, calloutApplies: false, note: 'Post-completion: use dispute flow' };
}
/** Same, with the live admin-set policy from the database. */
export async function evaluateCancellationLive(status: JobStatus, ctx: { providerFault?: boolean; kendiboFault?: boolean } = {}): Promise<CancelOutcome> {
  const cfg = await pricingConfig().catch(() => DEFAULT_PRICING_CONFIG);
  return evaluateCancellation(status, ctx, cfg.cancellation);
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
