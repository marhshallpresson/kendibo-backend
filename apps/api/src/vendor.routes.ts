// Vendor platform routes: category rules + AI-assisted trade proposals,
// credentials, vendor finance, storefronts + share links, KYC spend, and the
// WhatsApp booking assistant webhook.
//
// Access: these routes share the root deny-by-default gate in main.ts.
// VENDOR_ROUTE_POLICY below is merged into ROUTE_POLICY, so anything not listed
// there as public needs a session, and admin routes need the named permission.
// Handlers still enforce ownership (providerActor / storefront owner).
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Permission } from '../../../modules/authorization/rbac.js';
import { categoryRulesService, ruleUpdateSchema } from '../../../modules/vendors/category-rules.service.js';
import { vendorEligibilityService } from '../../../modules/vendors/eligibility.service.js';
import { vendorFinanceService } from '../../../modules/vendors/vendor-finance.service.js';
import { storefrontService, brandingSchema, renderStorefrontPage } from '../../../modules/storefront/storefront.service.js';
import { kycSpendReport } from '../../../modules/kyc/kyc-cost.guard.js';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { verifySubscription, verifySignature, whatsappConfigured } from '../../../modules/whatsapp/whatsapp.client.js';
import { verifyLink } from '../../../modules/whatsapp/links.js';
import { renderLocationPage, renderVendorsPage, renderMessagePage, pageCsp } from '../../../modules/whatsapp/web-pages.js';
import { enqueueInbound, continueAfterLocation, startInboundSweeper, payLinkTarget, type InboundMessage } from '../../../modules/whatsapp/whatsapp.bot.js';
import { applyTemplateWebhook, startTemplateStatusSync } from '../../../modules/whatsapp/templates.js';
import { saveDraftLocation } from '../../../modules/whatsapp/draft.js';
import { notifyCustomer } from '../../../modules/whatsapp/policy.js';
import { requestService } from '../../../modules/requests/request.service.js';
import { auditService } from '../../../modules/audit/audit.service.js';
import { integrationStatus } from '../../../packages/config/integrations.js';
import { observability } from '../../../packages/observability/watchup.adapter.js';
import { q } from '../../../packages/database/db.js';
import { emit } from '../../../packages/observability/emit.js';

export const VENDOR_ROUTE_POLICY: Record<string, 'public' | Permission> = {
  'GET /v1/categories/:id/rules': 'public',
  'GET /v1/storefronts/:slug': 'public',
  'GET /s/:slug': 'public',
  'GET /webhooks/whatsapp': 'public', // verify-token handshake checked in the handler
  'GET /v1/kendibot': 'public',
  'POST /webhooks/whatsapp': 'public', // X-Hub-Signature-256 checked in the handler
  // In-WhatsApp pages: the signed link token (HMAC, per user + draft + purpose,
  // expiring) is the credential, checked in every handler.
  'GET /w/location': 'public',
  'POST /w/location': 'public',
  'GET /w/vendors': 'public',
  'POST /w/vendors/choose': 'public',
  'GET /w/pay': 'public',
  'GET /w/geocode': 'public',
  'GET /v1/admin/category-rules': 'provider:verify',
  'PUT /v1/admin/category-rules/:id': 'configuration:edit',
  'GET /v1/admin/category-proposals': 'provider:verify',
  'POST /v1/admin/category-proposals/:id/decide': 'configuration:edit',
  'GET /v1/admin/credentials': 'provider:verify',
  'POST /v1/admin/credentials/:id/review': 'provider:verify',
  'GET /v1/admin/kyc/spend': 'ledger:view',
  'GET /v1/admin/providers/:id/finance': 'ledger:view',
  'POST /v1/admin/fees/:id/waive': 'payout:approve',
  'GET /v1/admin/integrations': 'configuration:edit',
};

interface Helpers {
  authed: (req: never) => { sub: string } | null;
  fail: (reply: FastifyReply, code: string, message: string, status?: number, retryable?: boolean) => unknown;
  providerActor: (req: never, reply: FastifyReply) => Promise<{ id: string } | null>;
}

// Maps service errors to user-facing messages (never leaks internals).
const MESSAGES: Record<string, [number, string]> = {
  SLUG_FORMAT: [400, 'Use 3–32 lowercase letters, numbers or hyphens.'],
  SLUG_RESERVED: [400, 'That link name is reserved. Try your business name.'],
  SLUG_TAKEN: [409, 'That link is taken. Try adding your area, e.g. ada-cleaning-uyo.'],
  NOT_READY: [409, 'Finish your storefront before publishing.'],
  NO_LINK: [409, 'Choose your storefront link first.'],
  ASSET_NOT_FOUND: [404, 'Upload the image again and retry.'],
  NAME_REQUIRED: [400, 'Tell us the name of the trade.'],
  TOO_MANY_OPEN_PROPOSALS: [429, 'You already have 5 trades waiting for review.'],
  PROPOSAL_GONE: [409, 'This proposal was already decided.'],
  CATEGORY_EXISTS_USE_MERGE: [409, 'A category with that id exists — merge into it instead.'],
  MERGE_TARGET_NOT_FOUND: [404, 'Merge target category not found.'],
  CATEGORY_NOT_FOUND: [404, 'Category not found.'],
  CREDENTIAL_GONE: [409, 'This credential was already reviewed.'],
  FEE_GONE: [409, 'This fee is no longer outstanding.'],
};

export function registerVendorRoutes(app: FastifyInstance, h: Helpers) {
  // Retries WhatsApp turns a crash cut short (never in tests: they drive the router directly).
  if (process.env.NODE_ENV !== 'test') { startInboundSweeper(); startTemplateStatusSync(); }
  const err = (reply: FastifyReply, e: unknown) => {
    const code = (e as Error)?.message ?? 'ERROR';
    const known = MESSAGES[code];
    if (!known) { observability.captureException(e); return h.fail(reply, 'ERROR', 'Something went wrong', 500, true); }
    const extra = (e as { missing?: string[] }).missing;
    return h.fail(reply, code, extra ? `${known[1]} Missing: ${extra.join(', ')}` : known[1], known[0]);
  };

  // Enable the app entry point only after the deployed bot has passed live QA.
  app.get('/v1/kendibot', async () => {
    const number = (process.env.WHATSAPP_BUSINESS_NUMBER ?? '').replace(/\D/g, '');
    const enabled = process.env.KENDIBOT_PROMOTION_ENABLED === 'true' && whatsappConfigured() && /^[1-9]\d{7,14}$/.test(number);
    return { data: { enabled, url: enabled ? `https://wa.me/${number}?text=${encodeURIComponent('Hello')}` : null } };
  });

  // ── Category rules & trade proposals ─────────────────────────────────────
  app.get('/v1/categories/:id/rules', async (req) => {
    const r = await categoryRulesService.ruleFor((req.params as { id: string }).id);
    // Commission and fees are shown so vendors know the deal before joining.
    return { data: r };
  });

  app.get('/v1/provider/categories/eligibility', async (req, reply) => {
    const me = await h.providerActor(req as never, reply); if (!me) return reply;
    return { data: await vendorEligibilityService.enrollments(me.id) };
  });
  app.post('/v1/provider/categories/:categoryId/enroll', async (req, reply) => {
    const me = await h.providerActor(req as never, reply); if (!me) return reply;
    const categoryId = (req.params as { categoryId: string }).categoryId;
    const exists = await q(`SELECT 1 FROM catalog.category WHERE id=$1 AND active`, [categoryId]);
    if (!exists[0]) return h.fail(reply, 'CATEGORY_NOT_FOUND', 'Category not found', 404);
    return { data: await vendorEligibilityService.enroll(me.id, categoryId) };
  });
  app.post('/v1/provider/categories/propose', async (req, reply) => {
    const me = await h.providerActor(req as never, reply); if (!me) return reply;
    const { name, description } = z.object({ name: z.string().min(2).max(60), description: z.string().max(1000).optional() }).parse(req.body ?? {});
    try { return { data: await categoryRulesService.propose(me.id, name, description ?? '') }; } catch (e) { return err(reply, e); }
  });
  app.get('/v1/provider/categories/proposals', async (req, reply) => {
    const me = await h.providerActor(req as never, reply); if (!me) return reply;
    return { data: await categoryRulesService.proposalsBy(me.id) };
  });

  app.get('/v1/admin/category-rules', async () => ({ data: await categoryRulesService.listRules() }));
  app.put('/v1/admin/category-rules/:id', async (req, reply) => {
    const a = h.authed(req as never)!;
    const patch = ruleUpdateSchema.parse(req.body ?? {});
    try {
      const rule = await categoryRulesService.updateRule((req.params as { id: string }).id, patch, a.sub);
      await auditService.log(a.sub, 'category.rule_update', rule.categoryId);
      return { data: rule };
    } catch (e) { return err(reply, e); }
  });
  app.get('/v1/admin/category-proposals', async (req) => {
    const status = z.enum(['pending', 'approved', 'merged', 'rejected']).catch('pending').parse((req.query as { status?: string }).status);
    return { data: await categoryRulesService.proposals(status) };
  });
  app.post('/v1/admin/category-proposals/:id/decide', async (req, reply) => {
    const a = h.authed(req as never)!;
    const body = z.object({
      decision: z.enum(['approve', 'merge', 'reject']),
      mergeInto: z.string().max(40).optional(),
      note: z.string().max(500).optional(),
      overrides: z.object({ name: z.string().min(2).max(60).optional(), slug: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/).optional(), description: z.string().max(240).optional(), rule: ruleUpdateSchema.optional() }).optional(),
    }).parse(req.body ?? {});
    try {
      const out = await categoryRulesService.decide((req.params as { id: string }).id, body.decision, a.sub, { mergeInto: body.mergeInto, note: body.note, overrides: body.overrides as never });
      await auditService.log(a.sub, `category.proposal_${body.decision}`, out.id);
      return { data: out };
    } catch (e) { return err(reply, e); }
  });

  // ── Credentials (licence / insurance / certificate) ─────────────────────
  app.get('/v1/provider/credentials', async (req, reply) => {
    const me = await h.providerActor(req as never, reply); if (!me) return reply;
    return { data: await vendorEligibilityService.credentials(me.id) };
  });
  app.post('/v1/provider/credentials', async (req, reply) => {
    const me = await h.providerActor(req as never, reply); if (!me) return reply;
    const body = z.object({
      kind: z.enum(['licence', 'insurance', 'certificate']), assetId: z.string().max(64),
      categoryId: z.string().max(40).optional(), label: z.string().max(120).optional(),
      number: z.string().max(60).optional(), expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }).parse(req.body ?? {});
    try { return { data: await vendorEligibilityService.submitCredential(me.id, body) }; } catch (e) { return err(reply, e); }
  });
  app.get('/v1/admin/credentials', async () => ({ data: await vendorEligibilityService.pendingCredentials() }));
  app.post('/v1/admin/credentials/:id/review', async (req, reply) => {
    const a = h.authed(req as never)!;
    const { approve } = z.object({ approve: z.boolean() }).parse(req.body ?? {});
    try {
      const out = await vendorEligibilityService.reviewCredential((req.params as { id: string }).id, approve, a.sub);
      await auditService.log(a.sub, `credential.${approve ? 'approve' : 'reject'}`, out.id);
      return { data: out };
    } catch (e) { return err(reply, e); }
  });

  // ── Vendor finance ───────────────────────────────────────────────────────
  app.get('/v1/provider/finance', async (req, reply) => {
    const me = await h.providerActor(req as never, reply); if (!me) return reply;
    return { data: { balance: await vendorFinanceService.balance(me.id), fees: await vendorFinanceService.fees(me.id) } };
  });
  app.get('/v1/admin/providers/:id/finance', async (req) => {
    const id = (req.params as { id: string }).id;
    return { data: { balance: await vendorFinanceService.balance(id), fees: await vendorFinanceService.fees(id) } };
  });
  app.post('/v1/admin/fees/:id/waive', async (req, reply) => {
    const a = h.authed(req as never)!;
    try {
      const out = await vendorFinanceService.waiveFee((req.params as { id: string }).id);
      await auditService.log(a.sub, 'fee.waive', out.id);
      return { data: out };
    } catch (e) { return err(reply, e); }
  });
  app.get('/v1/admin/kyc/spend', async (req) => {
    const days = Number((req.query as { days?: string }).days ?? 30) || 30;
    return { data: await kycSpendReport(days) };
  });
  app.get('/v1/admin/integrations', async () => ({ data: integrationStatus() }));

  // ── Storefront (owner) ───────────────────────────────────────────────────
  app.get('/v1/provider/storefront/me', async (req, reply) => {
    const me = await h.providerActor(req as never, reply); if (!me) return reply;
    return { data: await storefrontService.ownerView(me.id) };
  });
  app.put('/v1/provider/storefront/slug', async (req, reply) => {
    const me = await h.providerActor(req as never, reply); if (!me) return reply;
    const { slug } = z.object({ slug: z.string().min(3).max(32) }).parse(req.body ?? {});
    try { return { data: await storefrontService.claimSlug(me.id, slug) }; } catch (e) { return err(reply, e); }
  });
  app.patch('/v1/provider/storefront/branding', async (req, reply) => {
    const me = await h.providerActor(req as never, reply); if (!me) return reply;
    const a = h.authed(req as never)!;
    try { return { data: await storefrontService.updateBranding(me.id, a.sub, brandingSchema.parse(req.body ?? {})) }; } catch (e) { return err(reply, e); }
  });
  app.post('/v1/provider/storefront/publish', async (req, reply) => {
    const me = await h.providerActor(req as never, reply); if (!me) return reply;
    const { publish } = z.object({ publish: z.boolean() }).parse(req.body ?? {});
    try { return { data: await storefrontService.setPublished(me.id, publish) }; } catch (e) { return err(reply, e); }
  });
  app.get('/v1/provider/storefront/share', async (req, reply) => {
    const me = await h.providerActor(req as never, reply); if (!me) return reply;
    try {
      const kit = await storefrontService.shareKit(me.id);
      await storefrontService.track(me.id, 'share', 'kit');
      return { data: kit };
    } catch (e) { return err(reply, e); }
  });
  app.get('/v1/provider/storefront/insights', async (req, reply) => {
    const me = await h.providerActor(req as never, reply); if (!me) return reply;
    return { data: await storefrontService.insights(me.id, Number((req.query as { days?: string }).days ?? 30) || 30) };
  });

  // ── Storefront (public) ──────────────────────────────────────────────────
  const src = (req: { query: unknown }) => String((req.query as { src?: string }).src ?? 'link').replace(/[^a-z]/g, '').slice(0, 12) || 'link';
  app.get('/v1/storefronts/:slug', async (req, reply) => {
    const sf = await storefrontService.bySlug((req.params as { slug: string }).slug);
    if (!sf) return h.fail(reply, 'NOT_FOUND', 'Storefront not found', 404);
    await storefrontService.track(sf.id, 'view', src(req));
    return { data: sf };
  });
  app.get('/s/:slug', async (req, reply) => {
    const sf = await storefrontService.bySlug((req.params as { slug: string }).slug);
    void reply.header('Cache-Control', 'public, max-age=300');
    if (!sf) return reply.code(404).type('text/html; charset=utf-8').send('<!doctype html><title>Not found</title><p style="font-family:system-ui;padding:24px">This Kendibo storefront is not available.</p>');
    await storefrontService.track(sf.id, 'view', src(req));
    return reply.type('text/html; charset=utf-8').send(renderStorefrontPage(sf));
  });
  // Customer books the vendor straight from their storefront. The vendor gets
  // first refusal (still gated by category rules) via preferredProviderId.
  app.post('/v1/storefronts/:slug/requests', async (req, reply) => {
    const a = h.authed(req as never)!;
    const sf = await storefrontService.bySlug((req.params as { slug: string }).slug);
    if (!sf) return h.fail(reply, 'NOT_FOUND', 'Storefront not found', 404);
    const idem = req.headers['idempotency-key'];
    if (typeof idem !== 'string' || !idem.trim()) return h.fail(reply, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key header required');
    const body = z.object({
      categoryId: z.string().max(40), title: z.string().min(3).max(120), details: z.string().max(2000).optional(),
      addressId: z.string(), scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), timeWindow: z.string().max(20).optional(),
    }).parse(req.body ?? {});
    if (!sf.categories.some((c) => c.id === body.categoryId)) return h.fail(reply, 'CATEGORY_NOT_OFFERED', 'This vendor does not offer that service', 400);
    const r = await requestService.create(a.sub, { ...body, idempotencyKey: `sf_${idem.slice(0, 40)}`, preferredProviderId: sf.id, source: 'storefront' });
    await storefrontService.track(sf.id, 'request', 'storefront');
    return { data: r };
  });

  // ── In-WhatsApp pages: location picker + matched vendors ─────────────────
  // HTML forms post urlencoded bodies; Fastify only parses JSON by default.
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 4096 }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    });
  }
  const waNumber = () => process.env.WHATSAPP_BUSINESS_NUMBER || undefined;
  const html = (reply: FastifyReply, nonce: string, withMaps: boolean, page: string, status = 200) => reply
    .code(status)
    .header('Content-Security-Policy', pageCsp(nonce, withMaps))
    .header('Cache-Control', 'no-store')
    .header('Referrer-Policy', 'no-referrer')
    .type('text/html; charset=utf-8')
    .send(page);
  const newNonce = () => crypto.randomBytes(16).toString('base64');
  const expired = (reply: FastifyReply, nonce: string) => html(reply, nonce, false, renderMessagePage({ title: 'This link has expired', message: 'Go back to WhatsApp and ask for a new one — just reply "location" or "vendors".', nonce, waNumber: waNumber() }), 410);

  app.get('/w/location', async (req, reply) => {
    const nonce = newNonce();
    const t = String((req.query as { t?: string }).t ?? '');
    if (!verifyLink(t, 'loc')) return expired(reply, nonce);
    const [lat, lng] = String(process.env.WHATSAPP_MAP_DEFAULT_CENTER || '5.0377,7.9128').split(',').map(Number); // Uyo
    const key = process.env.GOOGLE_MAPS_BROWSER_KEY || '';
    return html(reply, nonce, !!key, renderLocationPage({ token: t, nonce, mapsKey: key || undefined, centre: { lat, lng }, waNumber: waNumber() }));
  });

  app.post('/w/location', async (req, reply) => {
    const body = z.object({
      t: z.string().max(600), lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180),
      address: z.string().max(200).default(''), landmark: z.string().max(120).default(''),
    }).safeParse(req.body ?? {});
    if (!body.success) return h.fail(reply, 'BAD_LOCATION', 'Pick a point on the map or use your current location.');
    const claims = verifyLink(body.data.t, 'loc');
    if (!claims) return h.fail(reply, 'LINK_EXPIRED', 'This link has expired. Ask for a new one on WhatsApp.', 410);
    const { geoService } = await import('../../../modules/geo/geo.service.js');
    const zone = await geoService.checkZone(body.data.lat, body.data.lng);
    if (!zone.serviceable) return h.fail(reply, 'OUTSIDE_COVERAGE', "We don't cover that spot yet. We're live in Uyo first, then Lagos and Abuja.", 422);
    try {
      await saveDraftLocation(claims.w, claims.d, { lat: body.data.lat, lng: body.data.lng, address: body.data.address || 'Pinned on map', landmark: body.data.landmark });
    } catch { return h.fail(reply, 'LINK_EXPIRED', 'This job was already sent. Start a new one on WhatsApp.', 410); }
    // Continue the conversation in WhatsApp (next step of the flow) without waiting for the customer.
    void continueAfterLocation(claims.w).catch((e) => observability.captureException(e));
    return { ok: true, message: "We'll continue in WhatsApp." };
  });

  const draftFor = async (claims: { w: string; d: string }) =>
    (await q<{ request_id: string | null; need: string | null; category_id: string | null; lat: number | null; lng: number | null; budget_kobo: string | null; service_id: string | null }>(
      `SELECT request_id, need, category_id, lat, lng, budget_kobo, service_id FROM messaging.whatsapp_job_draft WHERE id=$1 AND wa_id=$2`, [claims.d, claims.w],
    ))[0];

  app.get('/w/vendors', async (req, reply) => {
    const nonce = newNonce();
    const t = String((req.query as { t?: string }).t ?? '');
    const claims = verifyLink(t, 'vendors');
    if (!claims) return expired(reply, nonce);
    const d = await draftFor(claims);
    if (!d?.request_id || d.lat == null || d.lng == null) return expired(reply, nonce);
    const sr = await q<{ preferred_provider_id: string | null }>(`SELECT preferred_provider_id FROM booking.service_request WHERE id=$1`, [d.request_id]);
    const { matchingService } = await import('../../../modules/matching/matching.service.js');
    // Ranking is logged once at submit; re-ranking for display does not log again.
    const vendors = await matchingService.rank({ categoryId: d.category_id, lat: Number(d.lat), lng: Number(d.lng), need: d.need, budgetKobo: d.budget_kobo ? BigInt(d.budget_kobo) : null, serviceId: d.service_id });
    const { publicBaseUrl } = await import('../../../modules/storefront/storefront.service.js');
    return html(reply, nonce, false, renderVendorsPage({ token: t, nonce, vendors, need: d.need, storefrontBase: publicBaseUrl(), waNumber: waNumber(), alreadyChosen: sr[0]?.preferred_provider_id ?? null }));
  });

  app.post('/w/vendors/choose', async (req, reply) => {
    const nonce = newNonce();
    const body = (req.body ?? {}) as { t?: string; providerId?: string };
    const claims = verifyLink(String(body.t ?? ''), 'vendors');
    if (!claims) return expired(reply, nonce);
    const d = await draftFor(claims);
    if (!d?.request_id || d.lat == null || d.lng == null) return expired(reply, nonce);
    const requestId = d.request_id;
    const sr = await q<{ preferred_provider_id: string | null; title: string }>(`SELECT preferred_provider_id, title FROM booking.service_request WHERE id=$1`, [requestId]);
    if (sr[0]?.preferred_provider_id) {
      return html(reply, nonce, false, renderMessagePage({ title: 'Already sent', message: "You've already chosen a vendor for this job. We'll update you on WhatsApp.", nonce, waNumber: waNumber() }));
    }
    if (body.providerId === 'auto') {
      const out = await requestService.broadcast(requestId, 3);
      await notifyCustomer(claims.w, `We've sent your job to the ${out.offersSent} best-matched vendor${out.offersSent === 1 ? '' : 's'}. The first to accept gets it — we'll message you here.`).catch(() => undefined);
      return html(reply, nonce, false, renderMessagePage({ title: 'Sent to the best matches', message: "We'll message you on WhatsApp as soon as a vendor accepts.", nonce, waNumber: waNumber() }));
    }
    // The pick must still be in the eligible, in-range list (no picking arbitrary ids).
    const { matchingService } = await import('../../../modules/matching/matching.service.js');
    const ranked = await matchingService.rank({ categoryId: d.category_id, lat: Number(d.lat), lng: Number(d.lng), need: d.need, budgetKobo: d.budget_kobo ? BigInt(d.budget_kobo) : null, serviceId: d.service_id }, 25);
    const pick = ranked.find((v) => v.providerId === String(body.providerId ?? ''));
    if (!pick) return html(reply, nonce, false, renderMessagePage({ title: 'That vendor is not available', message: 'Go back and choose another vendor, or let Kendibo pick the best match.', nonce, waNumber: waNumber() }), 409);
    const existing = await q<{ id: string }>(`SELECT id FROM booking.request_offer WHERE request_id=$1 AND provider_id=$2`, [requestId, pick.providerId]);
    const offerId = existing[0]?.id ?? (await q<{ id: string }>(
      `INSERT INTO booking.request_offer (request_id, provider_id, eta_minutes) VALUES ($1,$2,$3) RETURNING id`, [requestId, pick.providerId, 15 + Math.round(pick.distanceKm * 3)],
    ))[0].id;
    await q(`UPDATE booking.service_request SET preferred_provider_id=$2, status='OFFERED' WHERE id=$1 AND status IN ('SUBMITTED','MATCHING','OFFERED')`, [requestId, pick.providerId]);
    await matchingService.markChosen(requestId, pick.providerId);
    const phone = await q<{ phone: string | null }>(`SELECT u.phone FROM provider.provider p JOIN identity.users u ON u.id=p.user_id WHERE p.id=$1`, [pick.providerId]);
    if (phone[0]?.phone) {
      const { notifyProviderOfOffer } = await import('../../../modules/whatsapp/whatsapp.bot.js');
      await notifyProviderOfOffer(String(phone[0].phone), String(offerId), `${String(sr[0]?.title ?? 'New job').slice(0, 80)} — ${pick.distanceKm.toFixed(1)} km away`);
    }
    await notifyCustomer(claims.w, `We've asked ${pick.name}. You'll get a message here when they accept — if they can't, we'll offer your job to the next best match.`).catch(() => undefined);
    return html(reply, nonce, false, renderMessagePage({ title: `Request sent to ${pick.name}`, message: "We'll message you on WhatsApp when they accept.", nonce, waNumber: waNumber() }));
  });

  // Address lookup for the location page (works without the Google map key):
  // signed link required, Mapbox/Google geocoder behind the maps port, Uyo bias.
  app.get('/w/geocode', async (req, reply) => {
    const qs = req.query as { t?: string; q?: string };
    if (!verifyLink(String(qs.t ?? ''), 'loc')) return h.fail(reply, 'LINK_EXPIRED', 'This link has expired. Ask for a new one on WhatsApp.', 410);
    const text = String(qs.q ?? '').trim().slice(0, 200);
    if (text.length < 4) return h.fail(reply, 'BAD_QUERY', 'Type the street and area first.');
    const { maps } = await import('../../../modules/geo/maps.port.js');
    const city = (process.env.GEOLOCK_CITY ?? 'uyo').split(',')[0].trim() || 'uyo';
    const g = await maps.geocode(text, city).catch(() => null);
    if (!g) return h.fail(reply, 'NOT_FOUND', 'We could not find that address. Add the area or a landmark.', 404);
    const { geoService } = await import('../../../modules/geo/geo.service.js');
    const zone = await geoService.checkZone(g.lat, g.lng).catch(() => ({ serviceable: false }));
    return { data: { lat: g.lat, lng: g.lng, formatted: g.formatted, serviceable: Boolean(zone.serviceable) } };
  });

  // "Pay securely" button of the vendor-accepted template: signed link → a
  // fresh, idempotent Bachs checkout for this customer's own booking.
  app.get('/w/pay', async (req, reply) => {
    const nonce = newNonce();
    const claims = verifyLink(String((req.query as { t?: string }).t ?? ''), 'pay');
    if (!claims) return expired(reply, nonce);
    const target = await payLinkTarget(claims.w, claims.d).catch(() => ({ done: 'Payment is unavailable right now. Try again in a minute.' }));
    if ('url' in target) return reply.redirect(target.url, 302);
    return html(reply, nonce, false, renderMessagePage({ title: 'Payment', message: target.done, nonce, waNumber: waNumber() }));
  });

  // ── WhatsApp assistant ───────────────────────────────────────────────────
  app.get('/webhooks/whatsapp', async (req, reply) => {
    const challenge = verifySubscription(req.query as Record<string, string | undefined>);
    if (challenge === null) return reply.code(403).send('Forbidden');
    return reply.type('text/plain').send(challenge);
  });
  // Meta signs the exact request bytes, so capture them before JSON parsing
  // (route-level, independent of the global raw-body plugin's load order).
  app.post('/webhooks/whatsapp', {
    preParsing: async (req, _reply, payload) => {
      const chunks: Buffer[] = [];
      for await (const c of payload) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      const buf = Buffer.concat(chunks);
      (req as unknown as { rawBodyStr: string }).rawBodyStr = buf.toString('utf8');
      return Readable.from(buf);
    },
  }, async (req, reply) => {
    const raw = (req as unknown as { rawBodyStr?: string }).rawBodyStr ?? '';
    if (!verifySignature(raw, req.headers['x-hub-signature-256'] as string | undefined)) {
      return h.fail(reply, 'BAD_SIGNATURE', 'Invalid webhook signature', 401);
    }
    // Acknowledge fast (Meta retries slow webhooks); process after replying.
    const body = (req.body ?? {}) as { entry?: { changes?: { field?: string; value?: {
      messages?: InboundMessage[]; contacts?: { wa_id: string; profile?: { name?: string } }[];
      statuses?: { status?: string; errors?: { code?: number; title?: string }[] }[];
    } }[] }[] };
    const jobs: Promise<void>[] = [];
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        // Template review / category / quality changes (WhatsApp Business Account fields).
        if (change.field && change.field.startsWith('message_template_') || change.field === 'template_category_update') {
          jobs.push(applyTemplateWebhook(String(change.field), (change.value ?? {}) as Record<string, unknown>).catch((e) => observability.captureException(e)));
          continue;
        }
        // Delivery receipts: surface failures (e.g. 131047, outside the 24h window) to observability.
        for (const st of change.value?.statuses ?? []) {
          if (st.status === 'failed') emit('whatsapp.delivery_failed', { code: st.errors?.[0]?.code ?? null, title: String(st.errors?.[0]?.title ?? '').slice(0, 80) });
        }
        const contacts = change.value?.contacts ?? [];
        for (const m of change.value?.messages ?? []) {
          const name = contacts.find((c) => c.wa_id === m.from)?.profile?.name;
          try {
            await enqueueInbound(m, name);
          } catch (e) {
            observability.captureException(e);
            req.log.error('[whatsapp] unable to persist inbound message');
            return h.fail(reply, 'WHATSAPP_INBOUND_UNAVAILABLE', 'Unable to accept webhook', 503, true);
          }
        }
      }
    }
    void Promise.all(jobs);
    return { ok: true };
  });
}
