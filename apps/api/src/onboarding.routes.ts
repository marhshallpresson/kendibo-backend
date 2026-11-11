// Provider onboarding progress: save after every step, resume anywhere.
// GET  /v1/provider/onboarding/progress  -> where the pro is and what they entered
// PUT  /v1/provider/onboarding/progress  -> save one step (creates the provider
//                                           profile on the first save)
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { q } from '../../../packages/database/db.js';
import { providerService } from '../../../modules/providers/provider.service.js';

interface Helpers {
  authed: (req: never) => { sub: string } | null;
  fail: (reply: FastifyReply, code: string, message: string, status?: number, retryable?: boolean) => unknown;
}

/** The wizard's steps, in order (short: each fits one screen). */
export const ONBOARDING_STEPS = ['account', 'details', 'services', 'identity', 'payout', 'review'] as const;
type Step = (typeof ONBOARDING_STEPS)[number];

// Never stored in the draft: identity numbers, secrets and raw images go
// straight to their own endpoints (identity check, media upload).
const SENSITIVE = /^(nin|bvn|vnin|password|pin|otp|secret|token|selfie|image|photo|base64)/i;
const MAX_DRAFT_BYTES = 16_384;

const saveSchema = z.object({
  step: z.enum(ONBOARDING_STEPS),
  accountType: z.enum(['individual', 'business']).optional(),
  data: z.record(z.string(), z.unknown()).default({}),
});

function clean(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (SENSITIVE.test(k)) continue;
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = typeof v === 'string' ? v.slice(0, 500) : v;
    else if (Array.isArray(v)) out[k] = v.slice(0, 50).filter((x) => ['string', 'number'].includes(typeof x));
    else if (typeof v === 'object') out[k] = clean(v as Record<string, unknown>);
  }
  return out;
}

async function progressFor(userId: string) {
  const r = await q<Record<string, unknown>>(
    `SELECT id, kyc_status, account_type, onboarding_step, onboarding_draft, onboarding_updated_at FROM provider.provider WHERE user_id=$1`, [userId],
  );
  const p = r[0];
  if (!p) return { started: false, step: 'account' as Step, accountType: null, draft: {}, kycStatus: null, steps: ONBOARDING_STEPS, updatedAt: null };
  const draft = typeof p.onboarding_draft === 'string' ? JSON.parse(p.onboarding_draft) : (p.onboarding_draft ?? {});
  return {
    started: true,
    providerId: String(p.id),
    step: (p.onboarding_step as Step) ?? 'account',
    accountType: (p.account_type as string) ?? null,
    draft,
    kycStatus: (p.kyc_status as string) ?? 'PENDING',
    steps: ONBOARDING_STEPS,
    updatedAt: p.onboarding_updated_at ? String(p.onboarding_updated_at) : null,
  };
}

export function registerOnboardingRoutes(app: FastifyInstance, h: Helpers) {
  app.get('/v1/provider/onboarding/progress', async (req, reply) => {
    const a = h.authed(req as never); if (!a) return h.fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
    return { data: await progressFor(a.sub) };
  });

  app.put('/v1/provider/onboarding/progress', async (req, reply) => {
    const a = h.authed(req as never); if (!a) return h.fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
    const parsed = saveSchema.safeParse(req.body ?? {});
    if (!parsed.success) return h.fail(reply, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Check the details and try again.', 400);
    const { step, accountType, data } = parsed.data;
    await providerService.onboard(a.sub); // idempotent: first save creates the profile
    const current = await progressFor(a.sub);
    const draft = { ...(current.draft as Record<string, unknown>), [step]: clean(data) };
    const json = JSON.stringify(draft);
    if (Buffer.byteLength(json) > MAX_DRAFT_BYTES) return h.fail(reply, 'TOO_LARGE', 'That is more than we can save for one application.', 413);
    // Remember the furthest step reached, so "back" never loses progress.
    const reached = ONBOARDING_STEPS.indexOf((current.step as Step) ?? 'account');
    const next = ONBOARDING_STEPS[Math.min(ONBOARDING_STEPS.indexOf(step) + 1, ONBOARDING_STEPS.length - 1)];
    const stepToKeep = ONBOARDING_STEPS.indexOf(next) > reached ? next : ONBOARDING_STEPS[reached];
    await q(
      `UPDATE provider.provider
          SET onboarding_draft=$2::jsonb, onboarding_step=$3, account_type=COALESCE($4, account_type), onboarding_updated_at=now()
        WHERE user_id=$1`,
      [a.sub, json, stepToKeep, accountType ?? null],
    );
    return { data: await progressFor(a.sub) };
  });
}
