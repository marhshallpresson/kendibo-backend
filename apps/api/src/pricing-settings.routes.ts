// Admin-editable pricing and cancellation numbers (modules/pricing/pricing.config.ts).
//   GET /v1/admin/settings/pricing -> { config, defaults, updatedAt, updatedBy }   (configuration:edit)
//   PUT /v1/admin/settings/pricing    full config (without version) -> { config }; audit-logged
// All rates are basis points (750 = 7.5%); perKmKobo is kobo per km.
// A VAT / platform fee / per-km change inserts a new catalog.pricebook version;
// existing bookings keep the version frozen in their price snapshot.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { adminCan } from '../../../modules/authorization/rbac.js';
import { q } from '../../../packages/database/db.js';
import { auditService } from '../../../modules/audit/audit.service.js';
import {
  DEFAULT_PRICING_CONFIG, pricingConfig, pricingConfigSchema, resetPricingConfigCache, savePricingConfig,
} from '../../../modules/pricing/pricing.config.js';

interface Helpers {
  fail: (reply: FastifyReply, code: string, message: string, status?: number, retryable?: boolean) => unknown;
  adminActor: (req: never) => Promise<{ sub: string; role: string } | { denied: true } | null>;
}

export function registerPricingSettingsRoutes(app: FastifyInstance, h: Helpers) {
  const settingsAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    const a = await h.adminActor(req as never);
    if (!a) { void h.fail(reply, 'UNAUTHENTICATED', 'Login required', 401); return null; }
    if ('denied' in a || !adminCan(a.role, 'configuration:edit')) { void h.fail(reply, 'FORBIDDEN', 'Configuration access required', 403); return null; }
    return a;
  };

  app.get('/v1/admin/settings/pricing', async (req, reply) => {
    if (!(await settingsAdmin(req, reply))) return reply;
    resetPricingConfigCache();
    const row = await q<{ updated_at: unknown; updated_by: unknown }>(
      `SELECT updated_at, updated_by FROM configuration.platform_setting WHERE key='pricing.config'`,
    ).catch(() => []);
    return {
      data: {
        config: await pricingConfig(),
        defaults: DEFAULT_PRICING_CONFIG,
        updatedAt: row[0]?.updated_at ? new Date(String(row[0].updated_at)).toISOString() : null,
        updatedBy: row[0]?.updated_by ? String(row[0].updated_by) : null,
      },
    };
  });

  app.put('/v1/admin/settings/pricing', async (req, reply) => {
    const a = await settingsAdmin(req, reply); if (!a) return reply;
    const body = { ...((req.body ?? {}) as Record<string, unknown>) };
    delete body.version; // read-only: assigned by the server
    const parsed = pricingConfigSchema.safeParse(body);
    if (!parsed.success) {
      const fields: Record<string, string> = {};
      for (const i of parsed.error.issues) { const k = i.path.join('.') || '(body)'; if (!fields[k]) fields[k] = i.message; }
      const first = Object.entries(fields)[0];
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: first ? `${first[0]}: ${first[1]}` : 'Invalid pricing config', retryable: false, fields } });
    }
    resetPricingConfigCache();
    const before = await pricingConfig();
    const after = await savePricingConfig(parsed.data, a.sub);
    await auditService.log(a.sub, 'settings.pricing.update', 'pricing.config', { entityType: 'setting', meta: { before, after } } as never).catch(() => {});
    return { data: { config: after } };
  });
}
