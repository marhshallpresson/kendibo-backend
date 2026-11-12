// Admin KYC review queue: every UNDER_REVIEW customer and provider in one list,
// including applications saved for manual verification because the identity
// provider (Prembly) was unconfigured, unfunded, over quota or down.
//   GET /v1/admin/kyc/queue?pendingReason=manual_verification&limit=100
// Approve / reject stay on the existing routes:
//   POST /v1/admin/users/kyc/:userId/approve|reject
//   POST /v1/admin/providers/:id/approve|reject
// (approve clears pending_reason and records the admin as reviewer; reject
// requires a reason.) /v1/admin/* is already behind the admin gate in main.ts;
// the handler checks the same permission as the other admin KYC routes.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { adminCan } from '../../../modules/authorization/rbac.js';
import { kycService, type KycDocument } from '../../../modules/kyc/kyc.service.js';
import { objectStore } from '../../../packages/storage/object.store.js';

interface Helpers {
  fail: (reply: FastifyReply, code: string, message: string, status?: number, retryable?: boolean) => unknown;
  adminActor: (req: never) => Promise<{ sub: string; role: string } | { denied: true } | null>;
}

const DOC_LINK_TTL_SEC = 15 * 60;

const querySchema = z.object({
  pendingReason: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const parseJson = (v: unknown): Record<string, unknown> | null => {
  if (v == null) return null;
  if (typeof v === 'object') return v as Record<string, unknown>;
  try { return JSON.parse(String(v)) as Record<string, unknown>; } catch { return null; }
};

async function signedDocs(docs: KycDocument[]) {
  return Promise.all(docs.map(async (d) => ({
    ...d,
    url: await objectStore.signedUrl(d.assetId, DOC_LINK_TTL_SEC).catch(() => null),
  })));
}

/** Latest masked input per check kind (e.g. nin -> 123****8901). */
function maskedFromChecks(checks: { kind: string; maskedInput: string | null }[]) {
  const out: Record<string, string> = {};
  for (const c of checks) if (c.maskedInput && !out[c.kind]) out[c.kind] = c.maskedInput; // checks are newest first
  return out;
}

export function registerKycAdminRoutes(app: FastifyInstance, h: Helpers) {
  app.get('/v1/admin/kyc/queue', async (req, reply) => {
    const a = await h.adminActor(req as never);
    if (!a) return h.fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
    if ('denied' in a || !adminCan(a.role, 'provider:verify')) return h.fail(reply, 'FORBIDDEN', 'Trust & Safety access required', 403);
    const { pendingReason, limit } = querySchema.parse(req.query ?? {});
    const { users, providers } = await kycService.reviewQueue({ pendingReason, limit });

    const items = [
      ...(await Promise.all(users.map(async (r) => {
        const userId = String(r.user_id);
        const checks = await kycService.checksFor('user', userId);
        const submitted = parseJson(r.submitted_masked);
        return {
          subjectType: 'user' as const,
          subjectId: userId,
          name: String(r.name ?? 'Customer'),
          phone: r.phone ? String(r.phone) : null,
          email: r.email ? String(r.email) : null,
          status: String(r.status),
          tier: Number(r.tier ?? 0),
          kycProvider: r.provider ? String(r.provider) : null,
          pendingReason: r.pending_reason ? String(r.pending_reason) : null,
          submittedAt: r.submitted_at ? String(r.submitted_at) : null,
          masked: {
            nin: (submitted?.nin as string | null | undefined) ?? (r.nin_masked ? String(r.nin_masked) : null),
            bvn: (submitted?.bvn as string | null | undefined) ?? (r.bvn_masked ? String(r.bvn_masked) : null),
            rcNumber: (submitted?.rcNumber as string | null | undefined) ?? null,
            businessName: (submitted?.businessName as string | null | undefined) ?? null,
            fromChecks: maskedFromChecks(checks),
          },
          documents: await signedDocs(await kycService.userDocumentsFor(userId)),
          checks,
        };
      }))),
      ...(await Promise.all(providers.map(async (r) => {
        const providerId = String(r.id);
        const checks = await kycService.checksFor('provider', providerId);
        const fromChecks = maskedFromChecks(checks);
        return {
          subjectType: 'provider' as const,
          subjectId: providerId,
          userId: String(r.user_id),
          name: String(r.name ?? 'Provider'),
          businessName: r.business_name ? String(r.business_name) : null,
          phone: r.phone ? String(r.phone) : null,
          email: r.email ? String(r.email) : null,
          status: String(r.kyc_status),
          tier: Number(r.kyc_tier ?? 0),
          kycProvider: r.kyc_provider ? String(r.kyc_provider) : null,
          pendingReason: r.kyc_pending_reason ? String(r.kyc_pending_reason) : null,
          submittedAt: r.kyc_submitted_at ? String(r.kyc_submitted_at) : null,
          masked: {
            nin: r.nin_masked ? String(r.nin_masked) : (fromChecks.nin ?? fromChecks.nin_w_face ?? null),
            bvn: r.bvn_masked ? String(r.bvn_masked) : (fromChecks.bvn ?? fromChecks.bvn_w_face ?? null),
            rcNumber: r.cac_number ? String(r.cac_number) : (fromChecks.cac ?? null),
            businessName: r.business_name ? String(r.business_name) : null,
            fromChecks,
          },
          documents: await signedDocs(await kycService.documentsFor(providerId)),
          checks,
        };
      }))),
    ];
    // Oldest first: a queue.
    items.sort((x, y) => (x.submittedAt ? Date.parse(x.submittedAt) : 0) - (y.submittedAt ? Date.parse(y.submittedAt) : 0));
    return { data: items, meta: { count: items.length, pendingReason: pendingReason ?? null } };
  });
}
