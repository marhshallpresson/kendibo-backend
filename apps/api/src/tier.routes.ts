// Provider / vendor tiers (modules/tiers/tier.service.ts).
// Provider:
//   GET    /v1/provider/tier                 -> tier, limits, requirements, next step, application, subscription, locked trades
//   POST   /v1/provider/tier/apply           { targetTier: 2|3, businessKind? } -> fee from wallet, else PSP checkout; 409 + missing
//   POST   /v1/provider/tier/references      { kind?, name, phone, relationship? } -> Tier 2 reference / guarantor
//   POST   /v1/provider/subscription         { plan: 'pro_monthly' } -> same payment shape as apply
//   DELETE /v1/provider/subscription         -> cancel at period end
// Admin (/v1/admin/* gate + 'provider:verify'):
//   GET  /v1/admin/tier-applications?status=
//   POST /v1/admin/tier-applications/:id/approve
//   POST /v1/admin/tier-applications/:id/reject   { reason }
//   POST /v1/admin/providers/:id/tier             { tier, reason }
//   GET  /v1/admin/settings/tiers                 -> { config, defaults, updatedAt, updatedBy }   (configuration:edit)
//   PUT  /v1/admin/settings/tiers                 full TierConfigJSON -> { config }; audit-logged
// Amounts are never read from the client: fees and prices come from tier.config.ts.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { adminCan, type Permission } from '../../../modules/authorization/rbac.js';
import { tierService, TierError, type CheckoutPort } from '../../../modules/tiers/tier.service.js';
import { clientIp } from './admin-console.routes.js';
import { q } from '../../../packages/database/db.js';
import { setSetting } from '../../../modules/settings/settings.service.js';
import { auditService } from '../../../modules/audit/audit.service.js';
import { DEFAULT_TIER_CONFIG, tierConfig, tierConfigSchema, tierConfigToJSON, resetTierConfigCache } from '../../../modules/tiers/tier.config.js';

interface Helpers {
  fail: (reply: FastifyReply, code: string, message: string, status?: number, retryable?: boolean) => unknown;
  adminActor: (req: never) => Promise<{ sub: string; role: string } | { denied: true } | null>;
  providerActor: (req: never, reply: FastifyReply) => Promise<{ id: string } | null>;
  payments: CheckoutPort;
}

export const TIER_ROUTE_POLICY: Record<string, Permission> = {
  'GET /v1/admin/settings/tiers': 'configuration:edit',
  'PUT /v1/admin/settings/tiers': 'configuration:edit',
  'GET /v1/admin/tier-applications': 'provider:verify',
  'POST /v1/admin/tier-applications/:id/approve': 'provider:verify',
  'POST /v1/admin/tier-applications/:id/reject': 'provider:verify',
  'POST /v1/admin/providers/:id/tier': 'provider:verify',
};

const applySchema = z.object({
  targetTier: z.union([z.literal(2), z.literal(3)]),
  businessKind: z.enum(['individual', 'business']).optional(),
});
const subscribeSchema = z.object({ plan: z.literal('pro_monthly') });
const referenceSchema = z.object({
  kind: z.enum(['reference', 'guarantor']).optional(),
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().regex(/^\+?\d[\d\s-]{6,20}$/),
  relationship: z.string().trim().max(80).optional(),
});
const listSchema = z.object({
  status: z.enum(['pending_payment', 'under_review', 'approved', 'rejected']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
const rejectSchema = z.object({ reason: z.string().trim().min(3).max(500) });
const setTierSchema = z.object({ tier: z.union([z.literal(1), z.literal(2), z.literal(3)]), reason: z.string().trim().min(3).max(500) });

const ctxOf = (req: FastifyRequest) => ({
  ip: clientIp(req as never), ua: req.headers['user-agent'] ? String(req.headers['user-agent']) : null,
});

export function registerTierRoutes(app: FastifyInstance, h: Helpers) {
  const sendError = (reply: FastifyReply, e: unknown) => {
    if (e instanceof TierError) {
      return reply.code(e.status).send({ error: { code: e.code, message: e.message, retryable: e.status >= 500, ...(e.missing.length ? { missing: e.missing } : {}) } });
    }
    throw e;
  };
  const admin = async (req: FastifyRequest, reply: FastifyReply) => {
    const a = await h.adminActor(req as never);
    if (!a) { void h.fail(reply, 'UNAUTHENTICATED', 'Login required', 401); return null; }
    if ('denied' in a || !adminCan(a.role, 'provider:verify')) { void h.fail(reply, 'FORBIDDEN', 'Trust & Safety access required', 403); return null; }
    return a;
  };

  app.get('/v1/provider/tier', async (req, reply) => {
    const me = await h.providerActor(req as never, reply); if (!me) return reply;
    try { return { data: await tierService.view(me.id) }; } catch (e) { return sendError(reply, e); }
  });

  app.post('/v1/provider/tier/apply', async (req, reply) => {
    const me = await h.providerActor(req as never, reply); if (!me) return reply;
    const parsed = applySchema.safeParse(req.body ?? {});
    if (!parsed.success) return h.fail(reply, 'VALIDATION_ERROR', 'targetTier must be 2 or 3.', 400);
    try { return { data: await tierService.apply(me.id, parsed.data.targetTier, parsed.data.businessKind, h.payments) }; }
    catch (e) { return sendError(reply, e); }
  });

  app.post('/v1/provider/tier/references', async (req, reply) => {
    const me = await h.providerActor(req as never, reply); if (!me) return reply;
    const parsed = referenceSchema.safeParse(req.body ?? {});
    if (!parsed.success) return h.fail(reply, 'VALIDATION_ERROR', 'Give the name and phone number of your reference or guarantor.', 400);
    return { data: await tierService.addReference(me.id, parsed.data) };
  });

  app.post('/v1/provider/subscription', async (req, reply) => {
    const me = await h.providerActor(req as never, reply); if (!me) return reply;
    const parsed = subscribeSchema.safeParse(req.body ?? {});
    if (!parsed.success) return h.fail(reply, 'VALIDATION_ERROR', "plan must be 'pro_monthly'.", 400);
    try { return { data: await tierService.subscribe(me.id, h.payments) }; } catch (e) { return sendError(reply, e); }
  });

  app.delete('/v1/provider/subscription', async (req, reply) => {
    const me = await h.providerActor(req as never, reply); if (!me) return reply;
    try { return { data: await tierService.cancelSubscription(me.id) }; } catch (e) { return sendError(reply, e); }
  });

  app.get('/v1/admin/tier-applications', async (req, reply) => {
    if (!(await admin(req, reply))) return reply;
    const { status, limit } = listSchema.parse(req.query ?? {});
    return { data: { items: await tierService.listApplications(status, limit ?? 100) } };
  });

  app.post('/v1/admin/tier-applications/:id/approve', async (req, reply) => {
    const a = await admin(req, reply); if (!a) return reply;
    try { return { data: await tierService.approve((req.params as { id: string }).id, a.sub, ctxOf(req)) }; }
    catch (e) { return sendError(reply, e); }
  });

  app.post('/v1/admin/tier-applications/:id/reject', async (req, reply) => {
    const a = await admin(req, reply); if (!a) return reply;
    const parsed = rejectSchema.safeParse(req.body ?? {});
    if (!parsed.success) return h.fail(reply, 'REASON_REQUIRED', 'Give a reason (the pro sees it).', 400);
    try { return { data: await tierService.reject((req.params as { id: string }).id, a.sub, parsed.data.reason, ctxOf(req)) }; }
    catch (e) { return sendError(reply, e); }
  });

  app.post('/v1/admin/providers/:id/tier', async (req, reply) => {
    const a = await admin(req, reply); if (!a) return reply;
    const parsed = setTierSchema.safeParse(req.body ?? {});
    if (!parsed.success) return h.fail(reply, 'VALIDATION_ERROR', 'Send tier (1, 2 or 3) and a reason.', 400);
    try { return { data: await tierService.adminSetTier((req.params as { id: string }).id, parsed.data.tier, parsed.data.reason, a.sub, ctxOf(req)) }; }
    catch (e) { return sendError(reply, e); }
  });

  // ── Tier prices / limits, editable by admins (configuration:edit) ───────────
  const settingsAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    const a = await h.adminActor(req as never);
    if (!a) { void h.fail(reply, 'UNAUTHENTICATED', 'Login required', 401); return null; }
    if ('denied' in a || !adminCan(a.role, 'configuration:edit')) { void h.fail(reply, 'FORBIDDEN', 'Configuration access required', 403); return null; }
    return a;
  };

  app.get('/v1/admin/settings/tiers', async (req, reply) => {
    if (!(await settingsAdmin(req, reply))) return reply;
    resetTierConfigCache();
    const row = await q<{ updated_at: unknown; updated_by: unknown }>(`SELECT updated_at, updated_by FROM configuration.platform_setting WHERE key='tiers.config'`).catch(() => []);
    return {
      data: {
        config: tierConfigToJSON(await tierConfig()),
        defaults: tierConfigToJSON(DEFAULT_TIER_CONFIG),
        updatedAt: row[0]?.updated_at ? new Date(String(row[0].updated_at)).toISOString() : null,
        updatedBy: row[0]?.updated_by ? String(row[0].updated_by) : null,
      },
    };
  });

  app.put('/v1/admin/settings/tiers', async (req, reply) => {
    const a = await settingsAdmin(req, reply); if (!a) return reply;
    const parsed = tierConfigSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const fields: Record<string, string> = {};
      for (const i of parsed.error.issues) { const k = i.path.join('.') || '(body)'; if (!fields[k]) fields[k] = i.message; }
      const first = Object.entries(fields)[0];
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: first ? `${first[0]}: ${first[1]}` : 'Invalid tier config', retryable: false, fields } });
    }
    const before = tierConfigToJSON(await tierConfig());
    const after = parsed.data;
    await setSetting('tiers.config', after, a.sub);
    resetTierConfigCache();
    await auditService.log(a.sub, 'settings.tiers.update', 'tiers.config', { ...ctxOf(req), entityType: 'setting', meta: { before, after } }).catch(() => {});
    return { data: { config: tierConfigToJSON(await tierConfig()) } };
  });
}
