import 'dotenv/config'; // must stay first: loads .env (gitignored) before any env read
import { config as appConfig } from '../../../packages/config/env.js'; // validates; refuses prod boot on missing secrets
import Fastify, { FastifyReply, FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import { PaymentService, PspUnavailableError } from '../../../modules/payments/payment.service.js';
import { postCollection, postSettlement, trialBalance, openPeriod, currentPeriod } from '../../../modules/ledger/ledger.service.js';
import { transition, type JobStatus } from '../../../modules/job-engine/job.machine.js';
import { whyNot, checkStartCode, ensureStartCode, afterTransition, confirmCompletion, startCompletionSweeper } from '../../../modules/job-engine/job-guard.js';
import { checkInDistance, selfieRequired, selfiePassed, recordCheckinSelfie, ratingsFor, rateParty, startReminderSweeper } from '../../../modules/job-engine/journey.js';
import { startBackupSweeper } from '../../../modules/backup/db-backup.js';
import { offeringService, earningsFor } from '../../../modules/vendors/offering.service.js';
import { observability } from '../../../packages/observability/watchup.adapter.js';
import { identityService } from '../../../modules/identity/identity.service.js';
import { authorize, isAdminRole, adminCan, type Permission } from '../../../modules/authorization/rbac.js';
import { propertyService, addressSchema } from '../../../modules/properties/property.service.js';
import { catalogService } from '../../../modules/catalog/catalog.service.js';
import { price } from '../../../modules/pricing/pricing.engine.js';
import { bookingService } from '../../../modules/bookings/booking.service.js';
import { quoteService } from '../../../modules/quotes/quote.service.js';
import { providerService } from '../../../modules/providers/provider.service.js';
import { dispatchService } from '../../../modules/dispatch/dispatch.service.js';
import { geoService } from '../../../modules/geo/geo.service.js';
import { payoutService } from '../../../modules/payouts/payout.service.js';
import { refundService } from '../../../modules/refunds/refund.service.js';
import { walletService } from '../../../modules/wallet/wallet.service.js';
import { PaymentSettlement } from '../../../modules/payments/settlement.js';
import { startPaymentReconciler } from '../../../modules/payments/reconciler.js';
import { disputeService, reviewService } from '../../../modules/disputes/trust.service.js';
import { messagingService } from '../../../modules/messaging/messaging.service.js';
import { notificationService, TEMPLATES, type NotificationChannel } from '../../../modules/notifications/notification.service.js';
import { slingClient } from '../../../modules/notifications/sling.client.js';
import { aiCtaService, type AiCtaCampaignGoal } from '../../../modules/notifications/ai-cta.service.js';
import { slingAutomationService, type RetainerCadence } from '../../../modules/notifications/automation.service.js';
import { mediaService } from '../../../modules/media/media.service.js';
import { kycService, selectKycAdapter } from '../../../modules/kyc/kyc.service.js';
import { fraudService } from '../../../modules/fraud/fraud.service.js';
import { configurationService } from '../../../modules/configuration/config.service.js';
import { auditService } from '../../../modules/audit/audit.service.js';
import { verifyAccess } from '../../../packages/auth/auth.js';
import { verificationService, qualityService, checklistService, emergencyService } from '../../../modules/providers/quality.service.js';
import { warrantyService as fullWarranty, supportService, earningsService } from '../../../modules/warranties/warranty.service.js';
import { b2bService } from '../../../modules/b2b/b2b.service.js';
import { cityService, makerChecker, analyticProps } from '../../../modules/configuration/cities.service.js';
import { historyService, reminderService, recurringService } from '../../../modules/properties/history.service.js';
import { evaluateCancellationLive, markFailed } from '../../../modules/bookings/cancellation.js';
import { reschedule, rescheduleHistory, flag as flagJob, flagsOf } from '../../../modules/job-engine/job.machine.js';
import { deviceService } from '../../../modules/devices/device.service.js';
import { objectStore } from '../../../packages/storage/object.store.js';
import { q } from '../../../packages/database/db.js';
import { maps, getMapsConfig, setMapsConfig, MAPS_PROVIDER_NAMES, type MapsProviderName } from '../../../modules/geo/maps.port.js';
import { requestService } from '../../../modules/requests/request.service.js';
import { vendorEligibilityService } from '../../../modules/vendors/eligibility.service.js';
import { categoriesForSkills, providerSkillCategories } from '../../../modules/vendors/skill-categories.js';
import { vendorFinanceService } from '../../../modules/vendors/vendor-finance.service.js';
import { configureWhatsappBot } from '../../../modules/whatsapp/whatsapp.bot.js';
import { registerVendorRoutes, VENDOR_ROUTE_POLICY } from './vendor.routes.js';
import { registerAdminOpsRoutes, ADMIN_OPS_POLICY } from './admin-ops.routes.js';
import { registerEvidenceRoutes } from './evidence.routes.js';
import { errorBody } from './safe-error.js';
import { registerEmailRoutes, EMAIL_ROUTE_POLICY } from './email.routes.js';
import { registerOnboardingRoutes } from './onboarding.routes.js';
import { registerKycAdminRoutes } from './kyc-admin.routes.js';
import { registerVirtualAccountRoutes, VIRTUAL_ACCOUNT_ROUTE_POLICY } from './virtual-account.routes.js';
import { installVirtualAccountHooks, chargeForWalletPayment, reverseWalletCharge, VaError } from '../../../modules/payments/paga/virtual-accounts.js';
import { onEmit } from '../../../packages/observability/emit.js';
import { registerAdminPasswordRoutes, ADMIN_PASSWORD_POLICY } from './admin-password.routes.js';
import { registerTierRoutes, TIER_ROUTE_POLICY } from './tier.routes.js';
import { registerPricingSettingsRoutes } from './pricing-settings.routes.js';
import { tierService } from '../../../modules/tiers/tier.service.js';
import { registerAdminConsoleRoutes, ADMIN_CONSOLE_POLICY, accountGate, refreshGate, adminLogin, sendLocked, clientIp, auditQuerySchema } from './admin-console.routes.js';
import { installAdminAlerts } from '../../../modules/notifications/admin-alerts.service.js';
import { startLifecycleSweeper } from '../../../modules/notifications/lifecycle.service.js';
import { emit } from '../../../packages/observability/emit.js';
import { registerInvoiceRoutes, INVOICE_ROUTE_POLICY } from './invoice.routes.js';
import { storefrontService } from '../../../modules/storefront/storefront.service.js';
import { surfaceFor } from '../../../packages/shared/clients.js';
void surfaceFor;
import { Writable } from 'node:stream';
import { safeRequestLog } from '../../../packages/observability/safe-request-log.js';
import crypto from 'node:crypto';
import { watchupTracing } from '../../../packages/observability/watchup/fastify.js';
import { watchup as watchupClient } from '../../../packages/observability/watchup.adapter.js';

const PROD = appConfig.NODE_ENV === 'production';
const logStream = new Writable({
  write(chunk, enc, cb) {
    try {
      const log = JSON.parse(chunk.toString());
      const lvl = log.level >= 50 ? 'error' : log.level >= 40 ? 'warning' : 'info';
      if (log.msg) watchupClient.captureLog(lvl, log.msg, log);
    } catch {}
    process.stdout.write(chunk, enc, cb);
  }
});

const app = Fastify({
  logger: { stream: logStream, serializers: { req: safeRequestLog } },
  genReqId: () => `req_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`,
  trustProxy: PROD, // Pxxl edge terminates TLS ahead of the container
});
// Clients (the app's fetch helper among them) send `Content-Type: application/json`
// on body-less POSTs such as "start provider onboarding" and "log out everywhere".
// Fastify rejects an empty JSON body with 400, which silently blocked onboarding;
// treat a zero-length JSON request as having no body instead.
app.addHook('onRequest', async (req) => {
  if (req.headers['content-length'] === '0' && /application\/json/i.test(String(req.headers['content-type'] ?? ''))) {
    delete req.headers['content-type'];
  }
});
// Meta posts Facebook data-deletion / deauthorize callbacks as form bodies.
app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 16_384 }, (_req, body, done) => {
  try { done(null, Object.fromEntries(new URLSearchParams(String(body)))); } catch (e) { done(e as Error, undefined); }
});
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';

void app.register(helmet, {
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }, // Strict encrypted rails
  contentSecurityPolicy: PROD,
});
// Install the onRoute hook before routes are declared; a queued register()
// runs too late for the synchronously declared routes in this module.
void rateLimit(app, {
  max: 100,
  timeWindow: '1 minute',
  errorResponseBuilder: (_req, context) => ({ statusCode: context.statusCode, error: { code: 'RATE_LIMIT', message: 'Too many requests' } }),
}, () => {});

// Prod CORS: explicit allowlist only (deployed app origins + Pxxl dashboard
// CORS_ORIGINS). DEFAULT_CORS_ORIGINS is hardcoded so a missing/legacy env
// value can never block the production web app (every POST preflight fails
// closed without Access-Control-Allow-Origin).
// Dev: permissive + Expo running URLs (Metro bundler on localhost/LAN, legacy
// devtools ports). Native apps (Expo Go, EAS builds) send no Origin header
// and are always allowed; Expo web sends its https origin (must allowlist).
const DEFAULT_CORS_ORIGINS = [
  'https://kendibo-app.pxxl.click',
  'https://kendibo-page.pxxlspace.cv',
];
const allowedOrigins = new Set(
  [...DEFAULT_CORS_ORIGINS, ...appConfig.CORS_ORIGINS.split(',')].map((s) => s.trim()).filter(Boolean),
);
const EXPO_DEV_ORIGINS = [
  'http://localhost:8081', 'http://127.0.0.1:8081',
  'http://localhost:19000', 'http://localhost:19001', 'http://localhost:19002',
  'http://127.0.0.1:19000', 'http://127.0.0.1:19001', 'http://127.0.0.1:19002',
];
const EXPO_LAN_RE = /^http:\/\/(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?$/;
function expoOriginAllowed(origin: string): boolean {
  if (EXPO_DEV_ORIGINS.includes(origin)) return true;
  return EXPO_LAN_RE.test(origin); // physical device -> Metro on LAN
}
void app.register(cors, {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // native (Expo Go / EAS build): no Origin sent
    if (allowedOrigins.has(origin)) return cb(null, true);
    // Expo dev surfaces (Metro localhost/LAN, devtools ports) are loopback-only
    // and safe in every environment — demos run Expo web dev against prod.
    if (expoOriginAllowed(origin)) return cb(null, true);
    // Deny without throwing: an error here turns every preflight into a 500
    // with no CORS headers (identical client outcome, noisy misleading logs).
    return cb(null, false);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  // Browsers only let pages read these response headers when listed: the admin
  // console shows the sign-in lockout countdown from Retry-After.
  exposedHeaders: ['Retry-After'],
});
void app.register(multipart, {
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  attachFieldsToBody: false,
});
// Kobo amounts travel as bigint internally — JSON has no bigint, so convert
// globally at the HTTP boundary (strings preserve precision; clients coerce).
const ser = (v: unknown): unknown =>
  typeof v === 'bigint'
    ? v.toString()
    : Array.isArray(v)
      ? v.map(ser)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, ser(x)]))
        : v;
void app.addHook('preSerialization', async (_req, _reply, payload) => ser(payload));
const payments = new PaymentService((globalThis as Record<string, unknown>).__PSP__ as never);
void app.register(watchupTracing);
process.on('unhandledRejection', (err) => observability.captureException(err, { source: 'unhandledRejection' }));
process.on('uncaughtException', (err) => observability.captureException(err, { source: 'uncaughtException' }));
// Graceful stop for restarts and deploys: finish in-flight requests, flush
// error reporting, then exit. A hung close never keeps the old process (and its
// port) alive: a 10s timer forces the exit.
let stopping = false;
const shutdown = (signal: string) => {
  if (stopping) return;
  stopping = true;
  app.log.info(`${signal} received: shutting down`);
  setTimeout(() => process.exit(0), 10_000).unref();
  void Promise.allSettled([app.close(), (watchupClient as unknown as { shutdown?: () => Promise<void> }).shutdown?.()]).then(() => process.exit(0));
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
void openPeriod(currentPeriod());
// Local DB (pg-mem) when no DATABASE_URL — same SQL, same constraints as Pxxl Postgres.
if (!process.env.DATABASE_URL) {
  void import('../../../packages/database/local.js').then((m) => m.localDb());
}

function fail(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, code: string, message: string, status = 400, retryable = false) {
  return reply.code(status).send({ error: { code, message, retryable } });
}

// Routes validate with schema.parse(); a rejected body used to surface as a
// 500 "server error". Answer it as what it is: a 400 naming the bad field.
// Every other error keeps Fastify's normal handling.
app.setErrorHandler((err, req, reply) => {
  if (err instanceof z.ZodError) {
    const first = err.issues[0];
    const field = first?.path?.length ? `${first.path.join('.')}: ` : '';
    return fail(reply, 'BAD_REQUEST', `${field}${first?.message ?? 'Invalid request'}`.slice(0, 200), 400);
  }
  const status = (err as { statusCode?: number }).statusCode ?? 500;
  if (status >= 500) req.log.error({ err }, 'request failed');
  return reply.code(status).send(errorBody(status, err, process.env.NODE_ENV === 'production'));
});
function authed(req: { headers: Record<string, string | undefined> }): { sub: string; permissions: string[]; sid?: string; iat?: number } | null {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return null;
  return verifyAccess(h.slice(7));
}

/**
 * Resolve the caller for an admin route. The JWT carries permissions but not
 * the role, so the role is read from identity.users — the DB is the source of
 * truth for "who is an admin". Returns null when the token is missing/invalid
 * or the identity no longer exists; returns a permission-denied sentinel when
 * the identity exists but holds no admin role, so callers can 401 vs 403.
 */
async function adminActor(req: { headers: Record<string, string | undefined> }):
  Promise<{ sub: string; role: string } | { denied: true } | null> {
  const a = authed(req);
  if (!a) return null;
  const rows = await q<{ role: string }>(`SELECT role FROM identity.users WHERE id=$1`, [a.sub]);
  const role = String(rows[0]?.role ?? '').toUpperCase();
  return isAdminRole(role) ? { sub: a.sub, role } : { denied: true };
}

// ---------- route access policy (deny by default) ----------
// Every route needs a valid Bearer token unless it is listed as public here.
// Routes listed with a permission additionally need an admin-console role that
// holds it (role read from identity.users, never from the token). Handlers still
// enforce resource ownership; this gate only guarantees nothing ships open by
// accident when a new route is added.
type RoutePolicy = 'public' | Permission;
const ROUTE_POLICY: Record<string, RoutePolicy> = {
  'GET /': 'public',
  'GET /favicon.ico': 'public',
  'GET /health/live': 'public',
  'GET /health/ready': 'public',
  'POST /v1/auth/otp/request': 'public',
  'POST /v1/auth/otp/verify': 'public',
  'POST /v1/auth/account-exists': 'public',
  'POST /v1/auth/google': 'public',
  'POST /v1/auth/facebook': 'public',
  // Meta callbacks: authenticated by the HMAC on signed_request, checked in the handler.
  'POST /v1/auth/facebook/data-deletion': 'public',
  'POST /v1/auth/facebook/deauthorize': 'public',
  'GET /w/facebook-deletion': 'public',
  'POST /v1/auth/refresh': 'public',
  'GET /v1/config': 'public',
  'GET /v1/config/flags': 'public',
  'GET /v1/mobile/config': 'public',
  'GET /v1/cities': 'public',
  'GET /v1/geo/zones/check': 'public',
  'GET /v1/geo/coverage': 'public',
  'GET /v1/geo/geocode': 'public',
  'GET /v1/geo/reverse-geocode': 'public',
  'GET /v1/categories': 'public',
  'GET /v1/categories/grouped': 'public',
  'GET /v1/services': 'public',
  'GET /v1/services/:id': 'public',
  'GET /v1/services/:id/availability': 'public',
  'POST /v1/pricing/quote': 'public',
  'GET /v1/checklists/:category': 'public',
  // Members-only marketplace: the vendor list and full profiles need an account.
  // Storefronts and their galleries are public portfolios with booking CTAs.
  'GET /v1/providers/:id/storefront': 'public',
  'GET /v1/provider/:id/gallery': 'public',
  'GET /v1/banks': 'public',
  'GET /v1/media/:id/file': 'public', // HMAC-signed URL checked in the handler
  'POST /webhooks/payments/paga': 'public', // Paga body hash checked in the handler
  'POST /webhooks/paga/transfer': 'public', // x-paga-hash checked in the handler
  'GET /w/paga/pay': 'public', // signed link (purpose 'paga'); shows pay instructions only
  'GET /w/payment-return': 'public', // shows status only; reference is unguessable
  'GET /w/delete-account': 'public', // Google Play account-deletion instructions
  'POST /webhooks/sling': 'public', // Sling signature checked in the handler
  // Operational / back-office routes that live outside /v1/admin.
  'GET /health/dependencies': 'configuration:edit',
  'POST /v1/notify': 'configuration:edit',
  'POST /v1/communications/ai-cta/generate': 'configuration:edit',
  'POST /v1/communications/send': 'configuration:edit',
  'POST /v1/communications/automation/trigger': 'configuration:edit',
  'POST /v1/communications/lookup/phone': 'configuration:edit',
  'POST /v1/communications/lookup/rcs': 'configuration:edit',
  'GET /v1/communications/status/:messageId': 'configuration:edit',
  'GET /v1/admin/campaigns': 'configuration:edit',
  'POST /v1/admin/campaigns': 'configuration:edit',
  'POST /v1/admin/campaigns/:id/launch': 'configuration:edit',
  'GET /v1/admin/sling/status': 'configuration:edit',
  'POST /v1/admin/sling/contacts/sync': 'configuration:edit',
  'GET /v1/admin/prembly/mcp-tools': 'provider:verify',
  'POST /v1/admin/prembly/mcp-execute': 'provider:verify',
  'GET /v1/dispatch/candidates': 'booking:override',
  'POST /v1/dispatch/assign': 'booking:override',
  'POST /v1/jobs/:id/settle': 'payout:approve',
  'POST /v1/payouts': 'payout:approve',
  'POST /v1/warranties': 'booking:override',
  // GET /v1/support/tickets: any signed-in user; the handler scopes customers to their own tickets.
};
// Vendor platform routes (storefronts, trade rules, WhatsApp) declare their own
// public/permission entries next to the handlers; merged into the same gate.
Object.assign(ROUTE_POLICY, VENDOR_ROUTE_POLICY, ADMIN_OPS_POLICY, EMAIL_ROUTE_POLICY, VIRTUAL_ACCOUNT_ROUTE_POLICY, ADMIN_CONSOLE_POLICY, ADMIN_PASSWORD_POLICY, TIER_ROUTE_POLICY);

app.addHook('onRequest', async (req, reply) => {
  const url = req.routeOptions.url;
  if (!url || req.method === 'OPTIONS') return; // 404s and CORS preflight
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const policy = ROUTE_POLICY[`${method} ${url}`];
  if (policy === 'public') return;
  const claims = authed(req as never);
  if (!claims) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  // Suspended accounts, revoked sessions, admin idle timeout and admin 2FA
  // (admin-console.routes.ts) — one place for every authenticated route.
  const adminRoute = Boolean(policy) || url.startsWith('/v1/admin/');
  const blocked = await accountGate(claims, { url, adminRoute });
  if (blocked) return fail(reply, blocked.code, blocked.message, blocked.status);
  if (adminRoute) {
    const a = await adminActor(req as never);
    if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
    if ('denied' in a || (policy && !adminCan(a.role, policy))) return fail(reply, 'FORBIDDEN', 'Insufficient permissions', 403);
    return;
  }
  if (!authed(req as never)) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
});

// Who is calling about this booking: its customer, its assigned provider, or an
// admin who can view any booking. Sends 401/403/404 and returns null otherwise.
async function bookingParty(req: never, reply: FastifyReply, bookingId: string):
  Promise<{ sub: string; as: 'customer' | 'provider' | 'admin' } | null> {
  const a = authed(req);
  if (!a) { void fail(reply, 'UNAUTHENTICATED', 'Login required', 401); return null; }
  const b = await bookingService.getRaw(bookingId);
  if (!b) { void fail(reply, 'NOT_FOUND', 'Booking not found', 404); return null; }
  if (b.userId === a.sub) return { sub: a.sub, as: 'customer' };
  const prov = await providerService.byUserId(a.sub);
  if (prov) {
    const assigned = await q(
      `SELECT 1 FROM dispatch.assignment WHERE job_id=$1 AND provider_id=$2 AND status='accepted'`, [bookingId, prov.id],
    );
    if (assigned[0]) return { sub: a.sub, as: 'provider' };
  }
  const rows = await q<{ role: string }>(`SELECT role FROM identity.users WHERE id=$1`, [a.sub]);
  if (adminCan(rows[0]?.role, 'booking:view:any')) return { sub: a.sub, as: 'admin' };
  void fail(reply, 'FORBIDDEN', 'Not a party to this booking', 403);
  return null;
}

// ---------- health ----------
// GET / answers platform probes + humans (Pxxl health checks default to /).
app.get('/', async () => ({
  ok: true, service: 'kendibo-api', version: '0.1.0',
  docs: 'GET /health/live, /health/ready, /health/dependencies, /v1/mobile/config',
}));
app.get('/favicon.ico', async (_req, reply) => reply.code(204).send());
app.get('/health/live', async () => ({ ok: true }));
// Readiness actually asks the database (it used to report "postgres" whenever
// DATABASE_URL was set, even while every query was failing). 503 lets the
// platform and uptime monitors see an outage.
app.get('/health/ready', async (_req, reply) => {
  const { pingDb, databaseMode } = await import('../../../packages/database/db.js');
  const dbUp = await pingDb();
  const mode = databaseMode();
  const ok = dbUp && mode !== 'memory-fallback';
  return reply.code(ok ? 200 : 503).send({
    ok, db: mode, dbReachable: dbUp,
    redis: process.env.REDIS_URL ? 'redis' : 'memory', storage: objectStore.driver,
  });
});
app.get('/health/dependencies', async () => {
  const w = watchupClient as unknown as { enabled: boolean; environment: string; release: string; queueDepth: number };
  return {
    paga: payments.isConfigured() ? (process.env.PAGA_ENV === 'live' ? 'live' : 'sandbox') : 'not-configured', maps: 'adapter', kyc: 'adapter',
    sms: 'sling', email: 'smtp', push: 'fcm', storage: objectStore.driver,
    sling: slingClient.isConfigured() ? 'live' : 'sandbox-sim',
    whatsapp: 'sling',
    rcs: 'sling',
    truecaller: 'sling',
    aiRetainer: aiCtaService.isLiveAiConfigured() ? 'gemini' : 'deterministic',
    watchup: w.enabled
      ? { status: 'enabled', environment: w.environment, release: w.release, queueDepth: w.queueDepth }
      : { status: 'disabled', hint: 'set WATCHUP_API_KEY and redeploy' },
  };
});
app.get('/v1/admin/monitoring', async (req, reply) => {
  const a = await adminActor(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  if ('denied' in a) return fail(reply, 'FORBIDDEN', 'Admin access required', 403);
  const w = watchupClient as unknown as {
    enabled: boolean; queueDepth: number; lastFlush: { at: string | null; ok: boolean | null };
    environment: string; release: string; service: string;
  };
  return {
    data: {
      watchup: {
        enabled: w.enabled, service: w.service, environment: w.environment, release: w.release,
        queueDepth: w.queueDepth, lastFlush: w.lastFlush,
        dashboard: 'https://watchup.site',
      },
      slo: { apiP95ms: 500, bookingP95ms: 800, webhookLagSec: 60, queueAgeSec: 60 },
    },
  };
});
  app.get('/v1/config', async () => ({ priceBook: await configurationService.priceBook(), flags: await configurationService.flags() }));
  app.get('/v1/config/flags', async () => {
    const flags = await configurationService.flags();
    try {
      const { config: appConfig } = await import('../../../packages/config/env.js');
      const launchCity = appConfig.GEOLOCK_CITY?.split(',')[0]?.trim().toLowerCase();
      if (launchCity && (flags as any).launchCity === undefined) (flags as any).launchCity = launchCity;
    } catch {}
    return { data: flags };
  });

// ---------- auth (OTP + refresh + PIN/biometrics stubs) ----------
// Tight per-IP budgets on OTP endpoints: 5 tries per code is only a real limit
// if codes cannot be re-requested endlessly.
const OTP_LIMIT = { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } };
app.post('/v1/auth/otp/request', OTP_LIMIT, async (req, reply) => {
  try {
    const { channel, identity } = z.object({ channel: z.enum(['phone', 'email']), identity: z.string() }).parse(req.body);
    const r = await identityService.requestOtp(channel, identity);
    return { data: { sent: true, devCode: r.devCode } };
  } catch (e: unknown) {
    if (e instanceof z.ZodError) return fail(reply, 'BAD_REQUEST', 'Enter a valid phone number or email address.', 400);
    const msg = (e as Error).message;
    if (msg === 'BAD_IDENTITY') return fail(reply, 'BAD_IDENTITY', 'Enter a valid phone number or email address.');
    if (msg === 'SEND_FAILED') {
      const cause = (e as Error & { cause?: unknown }).cause;
      const { classifyOtpDeliveryError } = await import('../../../modules/identity/otp-delivery-error.js');
      const reason = classifyOtpDeliveryError(cause);
      const channel = (req.body as { channel?: unknown } | null)?.channel;
      req.log.warn({ reason, channel: channel === 'phone' || channel === 'email' ? channel : 'unknown' }, '[otp] delivery failed');
      return fail(reply, 'SEND_FAILED', 'Could not deliver the code. Try again.', 502, true);
    }
    throw e;
  }
});
app.post('/v1/auth/otp/verify', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
  const parsed = z.object({
    channel: z.enum(['phone', 'email']), identity: z.string(), code: z.string(),
    name: z.string().optional(), role: z.string().optional(),
    device: z.object({
      fp: z.string().optional(), platform: z.string().optional(), model: z.string().optional(),
      os: z.string().optional(), appVersion: z.string().optional(), city: z.string().optional(),
    }).optional(),
  }).safeParse(req.body);
  if (!parsed.success) return fail(reply, 'BAD_REQUEST', 'Enter a valid verification code and identity.', 400);
  const { channel, identity, code, device, name, role } = parsed.data;
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip;
  const ua = req.headers['user-agent'] ? String(req.headers['user-agent']) : undefined;
  // Admin seats: 5 failures / 15 min per account and per IP lock sign-in for 15 min.
  const adminId = await adminLogin.target(channel, identity).catch(() => null);
  const loginCtx = { ip: clientIp(req as never), ua: ua ?? null };
  if (adminId) {
    const retry = await adminLogin.retryAfter(adminId, loginCtx.ip);
    if (retry > 0) { await adminLogin.locked(adminId, retry, loginCtx); return sendLocked(reply, fail as never, retry); }
  }
  let s;
  try { s = await identityService.verifyOtp(channel, identity, code, { ...device, ip, ua, name, role }); }
  catch (e) {
    if ((e as Error).message === 'ACCOUNT_SUSPENDED') return fail(reply, 'ACCOUNT_SUSPENDED', 'This account is suspended. Contact Kendibo support.', 403);
    throw e;
  }
  if (!s) {
    if (adminId) {
      const locked = await adminLogin.failed(adminId, channel === 'phone' ? 'sms_otp' : 'email_otp', loginCtx);
      if (locked > 0) return sendLocked(reply, fail as never, locked);
    }
    return { error: { code: 'BAD_OTP', message: 'Invalid or expired code', retryable: false } };
  }
  if (adminId) await adminLogin.succeeded(adminId, s, channel === 'phone' ? 'sms_otp' : 'email_otp', loginCtx);
  observability.track('auth.verified', { channel });
  return { data: s };
});
// Login button pre-check: normalised identity -> existence only.
// The 300ms constant-time sleep added ~0.3s to every login attempt with zero
// benefit — the response body is already uniform and OTP/refresh routes have
// their own rate limits. Removed in the latency audit.
app.post('/v1/auth/account-exists', async (req, reply) => {
  const parsed = z.object({
    identity: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
  }).safeParse(req.body ?? {});
  const rawIdentity = (parsed.success ? (parsed.data.identity ?? parsed.data.email ?? parsed.data.phone ?? '') : '').trim();
  if (!rawIdentity) {
    return fail(reply, 'BAD_IDENTITY', 'Enter a valid phone number or email address.', 400);
  }
  try {
    const r = await identityService.accountExists(rawIdentity);
    observability.track('auth.account_checked', { channel: r.channel, exists: r.exists });
    return { data: r };
  } catch (e: unknown) {
    const code = String((e as Error)?.message ?? '');
    if (code === 'BAD_IDENTITY') {
      return fail(reply, 'BAD_IDENTITY', 'Enter a valid phone number or email address.', 400);
    }
    return fail(reply, 'ACCOUNT_CHECK_UNAVAILABLE', 'Account check temporarily unavailable. Please try again.', 503, true);
  }
});
// Google SSO (in-app browser now, native SDK later — same endpoint either way).
app.post('/v1/auth/google', async (req, reply) => {
  const body = z.object({
    idToken: z.string().optional(),
    accessToken: z.string().optional(),
    token: z.string().optional(),
    device: z.object({
      fp: z.string().optional(), platform: z.string().optional(), model: z.string().optional(),
      os: z.string().optional(), appVersion: z.string().optional(), city: z.string().optional(),
    }).optional(),
  }).safeParse(req.body ?? {});
  const idToken = (body.success ? (body.data.idToken ?? body.data.accessToken ?? body.data.token ?? '') : '').trim();
  const device = body.success ? body.data.device : undefined;
  if (!idToken) return fail(reply, 'GOOGLE_REJECTED', 'Google sign-in failed. Try again.', 401);
  try {
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip;
    const ua = req.headers['user-agent'] ? String(req.headers['user-agent']) : undefined;
    const s = await identityService.googleVerify(idToken, { ...device, ip, ua });
    if ('user' in s && isAdminRole(s.user.role)) await adminLogin.succeeded(s.user.id, s, 'google', { ip: clientIp(req as never), ua: ua ?? null });
    else if ('twoFactorRequired' in s) {
      const ch = await q<{ user_id: string }>(`SELECT user_id FROM identity.admin_login_challenge WHERE id=$1`, [s.challengeId]);
      if (ch[0]) await adminLogin.succeeded(String(ch[0].user_id), s, 'google', { ip: clientIp(req as never), ua: ua ?? null });
    }
    observability.track('auth.google_verified', { isNew: s.isNew });
    return { data: s };
  } catch (e: unknown) {
    const code = String((e as Error).message);
    if (code === 'ACCOUNT_SUSPENDED') return fail(reply, code, 'This account is suspended. Contact Kendibo support.', 403);
    if (code === 'ADMIN_LOGIN_LOCKED') {
      const lk = e as { retryAfter?: number; adminId?: string };
      const retry = Number(lk.retryAfter ?? 0);
      await adminLogin.locked(String(lk.adminId), retry, { ip: clientIp(req as never), ua: req.headers['user-agent'] ? String(req.headers['user-agent']) : null });
      return sendLocked(reply, fail as never, retry);
    }
    if (['BAD_GOOGLE_TOKEN','BAD_GOOGLE_AUDIENCE', 'GOOGLE_TOKEN_EXPIRED', 'GOOGLE_UNVERIFIED'].includes(code)) {
      return fail(reply, 'GOOGLE_REJECTED', 'Google sign-in failed. Try again.', 401);
    }
    return fail(reply, 'GOOGLE_FAILED', 'Google sign-in unavailable. Try OTP instead.', 502, true);
  }
});
// Facebook Login (same Meta app as WhatsApp): the app sends the user access token.
app.post('/v1/auth/facebook', async (req, reply) => {
  const body = z.object({
    accessToken: z.string().min(20).max(2000),
    device: z.object({
      fp: z.string().optional(), platform: z.string().optional(), model: z.string().optional(),
      os: z.string().optional(), appVersion: z.string().optional(), city: z.string().optional(),
    }).optional(),
  }).safeParse(req.body ?? {});
  if (!body.success) return fail(reply, 'FACEBOOK_REJECTED', 'Facebook sign-in failed. Try again.', 401);
  try {
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip;
    const s = await identityService.facebookVerify(body.data.accessToken, { ...body.data.device, ip });
    observability.track('auth.facebook_verified', { isNew: s.isNew });
    return { data: s };
  } catch (e: unknown) {
    const code = String((e as Error).message);
    if (code === 'ACCOUNT_SUSPENDED') return fail(reply, code, 'This account is suspended. Contact Kendibo support.', 403);
    if (code === 'FACEBOOK_NOT_CONFIGURED') return fail(reply, code, 'Facebook sign-in is not set up yet. Use your phone number instead.', 503);
    if (['BAD_FACEBOOK_TOKEN', 'BAD_FACEBOOK_APP', 'FACEBOOK_TOKEN_EXPIRED'].includes(code)) return fail(reply, 'FACEBOOK_REJECTED', 'Facebook sign-in failed. Try again.', 401);
    return fail(reply, 'FACEBOOK_FAILED', 'Facebook sign-in is unavailable right now. Try your phone number instead.', 502, true);
  }
});
// Meta "Data Deletion Request Callback": unlink the Facebook id, answer with a status URL + code.
const facebookCallback = (kind: 'data-deletion' | 'deauthorize') => async (req: { body?: unknown; headers: Record<string, unknown>; protocol: string; hostname: string }, reply: Parameters<typeof fail>[0]) => {
  const { parseSignedRequest } = await import('../../../modules/identity/facebook.js');
  const signed = String((req.body as { signed_request?: string } | undefined)?.signed_request ?? '');
  const data = parseSignedRequest(signed);
  if (!data) return fail(reply, 'BAD_SIGNED_REQUEST', 'Invalid signed_request', 400);
  const { code } = await identityService.facebookDataDeletion(data.user_id);
  observability.track(`auth.facebook_${kind}`, {});
  const base = (process.env.WHATSAPP_WEB_BASE_URL || process.env.STOREFRONT_BASE_URL || `${req.protocol}://${req.hostname}`).replace(/\/+$/, '');
  return { url: `${base}/w/facebook-deletion?code=${encodeURIComponent(code)}`, confirmation_code: code };
};
app.post('/v1/auth/facebook/data-deletion', facebookCallback('data-deletion') as never);
app.post('/v1/auth/facebook/deauthorize', facebookCallback('deauthorize') as never);
app.get('/w/facebook-deletion', async (req, reply) => {
  const code = String((req.query as { code?: string }).code ?? '').slice(0, 40);
  const rows = /^fbdel_[0-9a-f]{20}$/.test(code)
    ? await q<{ status: string; created_at: string }>(`SELECT status, created_at FROM identity.facebook_deletion WHERE code=$1`, [code]).catch(() => [])
    : [];
  const done = rows[0];
  const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
  reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'").type('text/html; charset=utf-8');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kendibo · Facebook data</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;color:#14212b}h1{font-size:20px}code{background:#eef1f4;padding:2px 6px;border-radius:4px}</style></head><body>
<h1>${done ? 'Your Facebook data has been removed' : 'Request not found'}</h1>
<p>${done ? `We unlinked your Facebook account from Kendibo and deleted the profile photo we got from Facebook on ${esc(new Date(String(done.created_at)).toUTCString())}. Bookings, payments and your phone number were not obtained from Facebook; to close your Kendibo account, use Settings in the app or write to support.` : 'Check the confirmation code and try again.'}</p>
<p>Confirmation code: <code>${esc(code || '-')}</code></p></body></html>`;
});
// Role selection after Google sign-up ("You're joining as…"). New Google
// accounts default to CUSTOMER (column default); this upgrades to PROVIDER
// or confirms customer. PROVIDER → CUSTOMER is one-way immutable.
app.post('/v1/auth/role', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const parsed = z.object({ role: z.enum(['customer', 'provider']) }).safeParse(req.body);
  if (!parsed.success) return fail(reply, 'BAD_ROLE', 'Role must be customer or provider');
  const target = parsed.data.role.toUpperCase();
  const rows = await q<{ role: string }>(`SELECT role FROM identity.users WHERE id=$1`, [a.sub]);
  const current = String(rows[0]?.role ?? 'CUSTOMER');
  if (current === 'PROVIDER' && target === 'CUSTOMER') return fail(reply, 'ROLE_IMMUTABLE', 'Provider accounts cannot become customers', 403);
  if (current !== target) await q(`UPDATE identity.users SET role=$2 WHERE id=$1`, [a.sub, target]);
  return { data: { role: target } };
});
app.post('/v1/auth/refresh', async (req, reply) => {
  const { refresh } = z.object({ refresh: z.string() }).parse(req.body);
  const blocked = await refreshGate(refresh);
  if (blocked) return fail(reply, blocked.code, blocked.message, blocked.status);
  const r = await identityService.refresh(refresh);
  if (!r) return { error: { code: 'REFRESH_REJECTED', message: 'Reuse detected or expired', retryable: false } };
  return { data: r };
});
app.post('/v1/auth/logout-all', async (req) => {
  const a = authed(req as never); if (!a) return { error: { code: 'UNAUTHENTICATED', message: 'Login required', retryable: false } };
  await identityService.logoutAll(a.sub);
  return { data: { ok: true } };
});
app.get('/v1/me', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  return { data: await identityService.me(a.sub) };
});
app.post('/v1/auth/pin/create', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  try {
    const { pin } = z.object({ pin: z.string() }).parse(req.body);
    return { data: await identityService.setPin(a.sub, pin) };
  } catch (e: unknown) { return fail(reply, 'BAD_PIN', (e as Error).message); }
});
app.post('/v1/auth/pin/verify', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const { pin } = z.object({ pin: z.string() }).parse(req.body);
  const ok = await identityService.verifyPin(a.sub, pin);
  if (!ok) return fail(reply, 'BAD_PIN', 'Incorrect PIN', 403);
  return { data: { ok: true } };
});
app.post('/v1/auth/pin/change', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  try {
    const { oldPin, newPin } = z.object({ oldPin: z.string(), newPin: z.string() }).parse(req.body);
    return { data: await identityService.changePin(a.sub, oldPin, newPin) };
  } catch (e: unknown) { return fail(reply, 'BAD_PIN', (e as Error).message, 403); }
});
app.post('/v1/auth/biometrics/enable', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
  return { data: await identityService.enableBiometrics(a.sub, enabled) };
});

// ---------- addresses / properties ----------
app.get('/v1/addresses', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  return { data: await propertyService.listAddresses(a.sub, (req.query as { cursor?: string }).cursor) };
});
app.post('/v1/addresses', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  try { return { data: await propertyService.createAddress(a.sub, req.body) }; }
  catch { return fail(reply, 'BAD_ADDRESS', 'Invalid Nigerian address payload'); }
});
app.patch('/v1/addresses/:id', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  try {
    const updated = await propertyService.updateAddress(a.sub, (req.params as { id: string }).id, req.body);
    if (!updated) return fail(reply, 'NOT_FOUND', 'Address not found', 404);
    return { data: updated };
  } catch { return fail(reply, 'BAD_ADDRESS', 'Invalid Nigerian address payload'); }
});
app.delete('/v1/addresses/:id', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const removed = await propertyService.deleteAddress(a.sub, (req.params as { id: string }).id);
  if (!removed) return fail(reply, 'NOT_FOUND', 'Address not found', 404);
  return { data: { deleted: true } };
});
app.post('/v1/addresses/:id/default', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const addr = await propertyService.setDefault(a.sub, (req.params as { id: string }).id);
  if (!addr) return fail(reply, 'NOT_FOUND', 'Address not found', 404);
  return { data: addr };
});
app.get('/v1/geo/zones/check', async (req) => {
  const q = req.query as { lat: string; lng: string };
  return { data: await geoService.checkZone(Number(q.lat), Number(q.lng)) };
});
// Supported coverage (city-wide Uyo & Eket): lets the client show the exact
// latitude/longitude we serve instead of a bare "not available" dead end.
app.get('/v1/geo/coverage', async () => ({ data: await geoService.coverage() }));
app.post('/v1/properties', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const { name, addressId } = z.object({ name: z.string(), addressId: z.string() }).parse(req.body);
  return { data: await propertyService.createProperty(a.sub, name, addressId) };
});
app.post('/v1/properties/:id/assets', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!(await propertyOwner(req as never, reply, id))) return reply;
  const { kind, brand } = z.object({ kind: z.string().max(60), brand: z.string().max(60).optional() }).parse(req.body);
  return { data: await propertyService.addAsset(id, kind, brand) };
});
app.get('/v1/properties/:id/assets', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!(await propertyOwner(req as never, reply, id))) return reply;
  return { data: await propertyService.assetsOf(id) };
});

// ---------- catalog / pricing ----------
const categoryKind = (req: { query: unknown }) => {
  const k = (req.query as { kind?: string } | undefined)?.kind;
  return k === 'product' || k === 'service' ? k : undefined;
};
app.get('/v1/categories', async (req) => ({ data: await catalogService.categories({ kind: categoryKind(req) }) }));
app.get('/v1/categories/grouped', async (req) => ({ data: await catalogService.grouped({ kind: categoryKind(req) }) }));
app.get('/v1/services', async (req) => {
  const q = req.query as { category?: string; q?: string };
  if (q.q) return { data: await catalogService.search(q.q) };
  return { data: await catalogService.list(q.category) };
});
app.get('/v1/services/:id', async (req, reply) => {
  const s = await catalogService.get((req.params as { id: string }).id);
  if (!s) return fail(reply, 'NOT_FOUND', 'Service not found', 404);
  const aos = await catalogService.addOns(s.id);
  return { data: { ...s, baseKobo: String(s.baseKobo), addOns: aos.map((a) => ({ ...a, priceKobo: String(a.priceKobo) })) } };
});
app.post('/v1/pricing/quote', async (req, reply) => {
  try {
    const b = await price(req.body as never);
    return { data: { ...b, baseKobo: String(b.baseKobo), totalKobo: String(b.totalKobo), vatKobo: String(b.vatKobo) } };
  } catch (e: unknown) { return fail(reply, 'PRICE_ERROR', (e as Error).message); }
});

// ---------- bookings / quotes ----------
app.post('/v1/bookings', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const idem = req.headers['idempotency-key'];
  if (typeof idem !== 'string') return fail(reply, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key required');
  const body = z.object({ serviceId: z.string(), addressId: z.string(), scheduledAt: z.string(), urgency: z.string().optional(), customerNotes: z.string().optional(), addOnIds: z.array(z.string()).optional() }).parse(req.body);
  try { 
    const booking = await bookingService.create(a.sub, { ...body, idempotencyKey: idem }); 
    // Broadcast matching logic if urgency is asap or standard
    // Find candidate providers
    const addr = await propertyService.listAddresses(a.sub);
    const address = addr.items.find(x => x.id === body.addressId) || addr.items[0];
    if (address && address.latitude && address.longitude) {
      const candidates = await dispatchService.findCandidates({ serviceId: body.serviceId, lat: address.latitude, lng: address.longitude, amountKobo: BigInt(String(booking.priceKobo ?? 0).split('.')[0] || '0') || null });
      for (const cand of candidates.slice(0, 5)) {
        await dispatchService.assign(booking.id, cand.providerId).catch(() => {});
      }
      // Enter the matching state so the customer app can poll matches/offers.
      await bookingService.setStatus(booking.id, 'MATCHING', 'system').catch((e) => observability.captureException(e));
      const updated = await bookingService.getRaw(booking.id);
      return { data: updated ?? booking };
    }
    return { data: booking };
  }
  catch (e: unknown) { return fail(reply, 'BOOKING_ERROR', (e as Error).message); }
});
app.get('/v1/bookings', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  return { data: await bookingService.list(a.sub, (req.query as { cursor?: string }).cursor) };
});
app.get('/v1/bookings/:id', async (req, reply) => {
  const a = authed(req as never);
  try { return { data: await bookingService.get((req.params as { id: string }).id, a?.sub) }; }
  catch { return fail(reply, 'FORBIDDEN', 'Not your booking', 403); }
});
app.get('/v1/bookings/:id/tracking', async (req, reply) => {
  const a = authed(req as never);
  const bookingId = (req.params as { id: string }).id;
  const booking = await bookingService.getRaw(bookingId);
  if (!booking) return fail(reply, 'NOT_FOUND', 'Booking not found', 404);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const isOwner = booking.userId === a.sub;
  let isProvider = false;
  const p = await providerService.byUserId(a.sub);
  if (p) {
    const assigns = await q<any>(`SELECT * FROM dispatch.assignment WHERE job_id=$1 AND provider_id=$2 AND status='accepted'`, [bookingId, p.id]);
    if (assigns.length > 0) isProvider = true;
  }
  if (!isOwner && !isProvider) return fail(reply, 'FORBIDDEN', 'Not authorized', 403);

  const jobId = bookingId;
  const isActive = await geoService.isJourneyActive(jobId);
  let provider = null;
  let location = null;
  let destination = null;
  let etaMinutes = null;
  let distanceKm = null;

  const assigned = await q<any>(`SELECT provider_id FROM dispatch.assignment WHERE job_id=$1 AND status='accepted' LIMIT 1`, [jobId]);
  const assignedProviderId = assigned[0]?.provider_id;
  if (assignedProviderId) {
    const prov = await providerService.byId(assignedProviderId);
    if (prov) {
      const user = await q<any>(`SELECT name, profile_image, phone FROM identity.users WHERE id=$1`, [prov.userId]);
      provider = {
        id: prov.id,
        name: user[0]?.name || user[0]?.phone || 'Provider',
        avatarUrl: user[0]?.profile_image || null,
        phone: user[0]?.phone || null,
      };
    }
  }

  if (provider && isActive) {
    const latest = await q<any>(`SELECT lat, lng, created_at FROM geo.provider_location WHERE provider_id=$1 ORDER BY created_at DESC LIMIT 1`, [provider.id]);
    if (latest[0]) {
      location = {
        lat: Number(latest[0].lat),
        lng: Number(latest[0].lng),
        at: latest[0].created_at ? String(latest[0].created_at) : new Date().toISOString(),
      };
    }
  }

  const addr = await q<any>(`SELECT lat, lng, street, house_number, estate, landmark, postcode FROM property.address WHERE id=$1`, [booking.addressId]);
  if (addr[0]) {
    const parts = [addr[0].house_number, addr[0].street, addr[0].estate, addr[0].landmark].filter(Boolean);
    destination = {
      lat: addr[0].lat ? Number(addr[0].lat) : null,
      lng: addr[0].lng ? Number(addr[0].lng) : null,
      label: parts.length > 0 ? parts.join(', ') : (addr[0].postcode || 'Address'),
    };
  }

  if (destination?.lat != null && destination?.lng != null && location) {
    const d = geoService.haversineKm(location.lat, location.lng, destination.lat, destination.lng);
    distanceKm = Math.round(d * 100) / 100;
    etaMinutes = Math.round(d * 3 + 5);
  } else {
    try {
      etaMinutes = await geoService.etaMinutes(bookingId, booking.addressId);
    } catch {}
  }

  return {
    data: {
      status: booking.status,
      provider,
      location: provider ? (location || null) : null,
      destination,
      etaMinutes,
      distanceKm,
    },
  };
});
// Hybrid matching fallback: when auto-dispatch offers are all declined/expired,
// the customer can list eligible providers and pick one (hybrid flow).
app.get('/v1/bookings/:id/match/candidates', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const bookingId = (req.params as { id: string }).id;
  const b = await bookingService.getRaw(bookingId);
  if (!b) return fail(reply, 'NOT_FOUND', 'Booking not found', 404);
  if (b.userId !== a.sub) return fail(reply, 'FORBIDDEN', 'Not your booking', 403);

  const assignments = await q<Record<string, unknown>>(`SELECT provider_id, status FROM dispatch.assignment WHERE job_id=$1`, [bookingId]);
  const byProvider = new Map(assignments.map((r) => [String(r.provider_id), String(r.status)]));
  const activeOffer = assignments.some((r) => ['offered', 'accepted'].includes(String(r.status)));

  const addr = await q<Record<string, unknown>>(`SELECT lat, lng FROM property.address WHERE id=$1`, [b.addressId]);
  const lat = addr[0]?.lat != null ? Number(addr[0].lat) : null;
  const lng = addr[0]?.lng != null ? Number(addr[0].lng) : null;
  if (lat == null || lng == null) return { data: { slaExhausted: true, candidates: [] } };

  const cands = await dispatchService.findCandidates({ serviceId: b.serviceId, lat, lng, amountKobo: BigInt(b.priceKobo) });
  const candidates: Record<string, unknown>[] = [];
  for (const c of cands) {
    const prov = await providerService.byId(c.providerId);
    if (!prov) continue;
    const u = await q<Record<string, unknown>>(`SELECT name, profile_image FROM identity.users WHERE id=$1`, [prov.userId]);
    const qual = await q<Record<string, unknown>>(`SELECT * FROM provider.quality WHERE provider_id=$1`, [c.providerId]);
    let etaMinutes = Math.round(c.distanceKm * 3 + 5);
    try {
      const loc = await q<Record<string, unknown>>(`SELECT lat, lng FROM geo.provider_location WHERE provider_id=$1 ORDER BY created_at DESC LIMIT 1`, [c.providerId]);
      if (loc[0]?.lat != null) {
        etaMinutes = Math.round(geoService.haversineKm(Number(loc[0].lat), Number(loc[0].lng), lat, lng) * 3 + 5);
      }
    } catch { /* keep zone-based estimate */ }
    const st = byProvider.get(c.providerId);
    candidates.push({
      providerId: c.providerId,
      name: u[0]?.name ?? 'Provider',
      avatarUrl: u[0]?.profile_image ?? null,
      rating: Number(qual[0]?.rating ?? 4.5) || 4.5,
      distanceKm: c.distanceKm,
      etaMinutes,
      rateKobo: b.priceKobo,
      offered: st === 'offered',
      declined: st === 'declined' || st === 'expired',
    });
  }
  return { data: { slaExhausted: !activeOffer, candidates } };
});
app.post('/v1/bookings/:id/match/pick', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const bookingId = (req.params as { id: string }).id;
  const { providerId } = z.object({ providerId: z.string() }).parse(req.body);
  const b = await bookingService.getRaw(bookingId);
  if (!b) return fail(reply, 'NOT_FOUND', 'Booking not found', 404);
  if (b.userId !== a.sub) return fail(reply, 'FORBIDDEN', 'Not your booking', 403);
  if (b.status !== 'MATCHING') return fail(reply, 'NO_CANDIDATE', 'Booking is not awaiting a match', 409);

  const addr = await q<Record<string, unknown>>(`SELECT lat, lng FROM property.address WHERE id=$1`, [b.addressId]);
  if (addr[0]?.lat == null || addr[0]?.lng == null) return fail(reply, 'NO_CANDIDATE', 'No serviceable location', 409);
  const cands = await dispatchService.findCandidates({ serviceId: b.serviceId, lat: Number(addr[0].lat), lng: Number(addr[0].lng), amountKobo: BigInt(b.priceKobo) });
  if (!cands.some((c) => c.providerId === providerId)) return fail(reply, 'NO_CANDIDATE', 'Provider is not eligible', 409);
  try {
    const offer = await dispatchService.assign(bookingId, providerId);
    return { data: { offerId: offer.id, status: 'offered' } };
  } catch {
    return fail(reply, 'NO_CANDIDATE', 'Provider is not available', 409);
  }
});
app.post('/v1/bookings/:id/cancel', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  try { return { data: await bookingService.cancel((req.params as { id: string }).id, a.sub) }; }
  catch { return fail(reply, 'FORBIDDEN', 'Cannot cancel', 403); }
});app.get('/v1/bookings/:id/timeline', async (req) => ({ data: await bookingService.timeline((req.params as { id: string }).id) }));
app.post('/v1/quotes', async (req, reply) => {
  const { bookingId, amountKobo, notes } = z.object({ bookingId: z.string(), amountKobo: z.string().regex(/^\d+$/), notes: z.string().max(2000).optional() }).parse(req.body);
  const p = await bookingParty(req as never, reply, bookingId); if (!p) return reply;
  if (p.as !== 'provider') return fail(reply, 'FORBIDDEN', 'Only the assigned provider can quote', 403);
  return { data: await quoteService.propose(bookingId, { amountKobo: BigInt(amountKobo), providerNotes: notes }) };
});
app.post('/v1/quotes/:bookingId/accept', async (req, reply) => {
  const bookingId = (req.params as { bookingId: string }).bookingId;
  const p = await bookingParty(req as never, reply, bookingId); if (!p) return reply;
  if (p.as !== 'customer') return fail(reply, 'FORBIDDEN', 'Only the customer can accept a quote', 403);
  const { version } = z.object({ version: z.number() }).parse(req.body);
  return { data: await quoteService.accept(bookingId, version) };
});

// ---------- payments (Paga — single PSP) ----------
/** Checkout could not start: 503 when Paga is not configured, 502 for any other PSP failure. Never another PSP. */
function checkoutFailure(reply: Parameters<typeof fail>[0], e: unknown) {
  if (e instanceof PspUnavailableError) return fail(reply, 'PSP_UNAVAILABLE', 'Payments are not available right now', 503, true);
  observability.captureException(e);
  return fail(reply, 'PSP_UNAVAILABLE', 'Provider unavailable', 502, true);
}
// Server-authoritative charge amount: the accepted quote total when one exists
// (quote flow), otherwise the frozen booking price snapshot. The client amount
// is advisory ONLY — a stale bundle may still send its own math, and charging
// whatever it asked for would let the amount drift from booking.price_kobo.
// Mismatches are charged at the server price and logged, never rejected: a
// rejected payment strands customers on older app bundles that cannot deploy.
async function expectedChargeKobo(bookingId: string, booking: { priceKobo: string }): Promise<bigint> {
  try {
    const rows = await q<Record<string, unknown>>(
      `SELECT total_kobo FROM booking.quote WHERE job_id=$1 AND status='accepted' ORDER BY version DESC LIMIT 1`,
      [bookingId],
    );
    if (rows[0]) return BigInt(String(rows[0].total_kobo));
  } catch (e: unknown) { observability.captureException(e); }
  return BigInt(booking.priceKobo);
}

app.post('/v1/bookings/:id/payments', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const idem = req.headers['idempotency-key'];
  if (typeof idem !== 'string') return fail(reply, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key header required');
  const parsed = z.object({ amountKobo: z.string(), email: z.string().email() }).safeParse(req.body);
  if (!parsed.success) return fail(reply, 'BAD_PAYMENT', 'amountKobo (kobo string) and a valid email are required');
  const bookingId = (req.params as { id: string }).id;
  const booking = await bookingService.getRaw(bookingId);
  if (!booking) return fail(reply, 'BOOKING_NOT_FOUND', 'Booking not found', 404);
  if (booking.userId !== a.sub) return fail(reply, 'FORBIDDEN', 'Not your booking', 403);
  const expected = await expectedChargeKobo(bookingId, booking);
  let sent: bigint | null = null;
  try { sent = BigInt(parsed.data.amountKobo); } catch { sent = null; }
  if (sent !== null && sent !== expected) {
    observability.captureMessage?.(`payment.amount_mismatch booking=${bookingId} client=${sent} server=${expected}`);
  }
  try {
    // The payer is the booking's own customer (read from our row); the reference is minted by the server.
    const session = await payments.createCheckout({
      bookingId, purpose: 'booking', amountKobo: expected,
      customerEmail: parsed.data.email, idempotencyKey: idem,
    });
    observability.track('booking.payment_initiated', { psp: session.psp });
    return { data: session };
  } catch (e: unknown) { return checkoutFailure(reply, e); }
});
import fastifyRawBody from 'fastify-raw-body';
void app.register(fastifyRawBody, { global: false });

// One settlement rule for every path (webhook, return/verify, background reconciler):
// see modules/payments/settlement.ts. Hooks plug in what only the API knows how to do.
const settlement = new PaymentSettlement(payments, {
  async confirm(row) {
    const amount = BigInt(String(row.amount_kobo));
    // Tier upgrade fee / Kendibo Pro subscription paid by checkout.
    // TODO(ledger): post these platform fees to the ledger once a fee-income account exists.
    if (row.purpose === 'tier' || row.purpose === 'subscription') {
      try { await tierService.onCheckoutPaid(String(row.subject_ref ?? ''), amount); } catch (e) { observability.captureException(e); }
      return;
    }
    // Booking or product order: books the money, then sends the receipt (WhatsApp link + verified email).
    try { await postCollection(row.reference, amount, currentPeriod()); } catch (e) { observability.captureException(e); }
    try {
      const { onPaymentSucceeded } = await import('../../../modules/invoices/invoice.service.js');
      await onPaymentSucceeded(String(row.booking_id));
    } catch (e) { observability.captureException(e); }
  },
  async notify(userId, title, body) {
    await notificationService.sendOmnichannel({ recipientId: userId, channels: ['inapp', 'push'], template: 'payment_update', vars: { title, body }, category: 'order' });
  },
  track: (event, props) => {
    observability.track(event, props);
    if (event === 'payment.review_needed' || event === 'payment.no_owner') observability.captureMessage?.(`${event} reference=${String(props?.reference ?? '')}`);
  },
});

/** Ask Paga about a still-open payment (at most every 5s per reference) and settle it. Returns the payment status. */
const lastReconcile = new Map<string, number>();
async function syncPendingPayment(reference: string): Promise<string | null> {
  const now = Date.now();
  if ((lastReconcile.get(reference) ?? 0) > now - 5000) return null;
  lastReconcile.set(reference, now);
  if (lastReconcile.size > 5000) lastReconcile.clear();
  const r = await settlement.settle(reference).catch((e) => { observability.captureException(e); return null; });
  return r && r.status !== 'busy' && r.status !== 'not_found' ? r.status : null;
}

/** Record a processed webhook event. Done AFTER processing: a crash mid-way leaves it unrecorded so the retry re-processes. */
async function recordWebhookEvent(eventId: string, raw: string): Promise<void> {
  try { await q(`INSERT INTO payment.webhook_event (psp, event_id, raw) VALUES ('paga',$1,$2)`, [eventId, raw]); }
  catch (e) { if ((e as { code?: string }).code !== '23505') throw e; }
}

// Return target of the old hosted checkout and of any link that still points at it.
// Checks with Paga (the webhook may lag), then hands the customer back to WhatsApp or the app.
app.get('/w/payment-return', async (req, reply) => {
  const { pageCsp, renderPaymentReturnPage } = await import('../../../modules/whatsapp/web-pages.js');
  const nonce = crypto.randomBytes(16).toString('base64');
  const reference = String((req.query as { reference?: string }).reference ?? '').slice(0, 120);
  let status = 'pending';
  let fromWhatsapp = false;
  if (/^[\w-]+$/.test(reference)) {
    const rows = await q<{ status: string; psp_details: unknown }>(`SELECT status, psp_details FROM payment.payment WHERE reference=$1`, [reference]).catch(() => []);
    status = rows[0]?.status ?? 'pending';
    const d = (typeof rows[0]?.psp_details === 'string' ? JSON.parse(rows[0].psp_details as string) : rows[0]?.psp_details ?? {}) as Record<string, unknown>;
    fromWhatsapp = d.source === 'whatsapp';
    if (status === 'pending' || status === 'partial') status = (await syncPendingPayment(reference)) ?? status;
  }
  if (status !== 'successful' && status !== 'failed') status = 'pending';
  const page = renderPaymentReturnPage({
    status, reference, nonce, fromWhatsapp,
    waNumber: process.env.WHATSAPP_BUSINESS_NUMBER || undefined,
    appWebBase: process.env.APP_WEB_URL || 'https://kendibo-app.pxxl.click',
  });
  return reply.header('Content-Security-Policy', pageCsp(nonce, false)).header('Cache-Control', 'no-store')
    .header('Referrer-Policy', 'no-referrer').type('text/html; charset=utf-8').send(page);
});

/** Settle after a callback was acknowledged. If another settle of the same payment is running, try again shortly (the reconciler is the backstop). */
async function settleAfterCallback(reference: string): Promise<void> {
  try {
    for (const wait of [0, 200, 1000, 4000]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      const r = await settlement.settle(reference);
      if (r.status !== 'busy') return;
    }
  } catch (e) { observability.captureException(e); }
}

/**
 * Second layer for Paga callbacks (the body hash stays mandatory): only Paga's published
 * source addresses (live 51.124.69.198, sandbox 51.136.123.148) when PAGA_CALLBACK_IPS is
 * set (comma list). Unset = log only, so an unknown proxy can never lock us out of callbacks.
 */
function pagaCallbackIpAllowed(ip: string, route: string): boolean {
  const allow = String(process.env.PAGA_CALLBACK_IPS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const clean = ip.replace(/^::ffff:/, '');
  if (!allow.length) { if (process.env.NODE_ENV !== 'test') app.log.info({ ip: clean, route }, 'paga callback source (PAGA_CALLBACK_IPS not set, not enforced)'); return true; }
  return allow.includes(clean);
}

// Paga payment callback. Verified (hash, constant time) -> persisted on the payment row ->
// acknowledged at once with 200 {"status":"SUCCESS"} (Paga wants an answer within 5s) ->
// settled in the background. The body is only trusted for its hash-verified amount fields;
// /status confirms the payment, and the reconciler finishes anything this process drops.
// The notificationId is recorded after the callback is persisted (not before), so a crash
// in between makes Paga's retry (same notificationId, up to 3x) store it again.
app.post('/webhooks/payments/paga', { config: { rawBody: true } }, (req, reply) => handlePagaCheckoutCallback(req, reply));

async function handlePagaCheckoutCallback(req: FastifyRequest, reply: FastifyReply) {
  if (!pagaCallbackIpAllowed(String(req.ip ?? ''), 'payments')) return fail(reply, 'FORBIDDEN', 'Source not allowed', 403);
  try {
    const raw = Buffer.from((req as unknown as { rawBody?: string }).rawBody || JSON.stringify(req.body ?? {}));
    const evt = payments.parseWebhook(raw, req.headers as Record<string, string>);
    if (!evt.ok) return fail(reply, 'BAD_SIGNATURE', 'Invalid webhook signature', 401);
    if ((await q(`SELECT 1 FROM payment.webhook_event WHERE event_id=$1`, [evt.eventId]))[0]) return { status: 'SUCCESS', ok: true }; // fully processed before
    const reference = evt.reference;
    if (reference) {
      await settlement.recordCallback(reference, evt.callback);
      setImmediate(() => { void settleAfterCallback(reference); });
    }
    await recordWebhookEvent(evt.eventId, evt.raw);
    return { status: 'SUCCESS', ok: true };
  } catch (e) {
    observability.captureException(e);
    app.log.error({ err: e }, 'webhook processing failed');
    return fail(reply, 'WEBHOOK_ERROR', 'Webhook processing failed', 500);
  }
}

// Paga bank-transfer pay page (signed link from the checkout): account number,
// exact amount, expiry and live status. Pending payments are re-checked with Paga.
app.get('/w/paga/pay', async (req, reply) => {
  const { verifyLink } = await import('../../../modules/whatsapp/links.js');
  const { pageCsp } = await import('../../../modules/whatsapp/web-pages.js');
  const { renderPagaPayPage } = await import('../../../modules/payments/paga/pay-page.js');
  const claims = verifyLink(String((req.query as { t?: string }).t ?? ''), 'paga');
  if (!claims) return reply.code(403).type('text/plain; charset=utf-8').send('This payment link is not valid or has expired. Ask for a new one in WhatsApp or the app.');
  const reference = claims.d;
  const rows = await q<{ status: string; amount_kobo: string; psp_details: unknown; psp: string }>(
    `SELECT status, amount_kobo, psp_details, psp FROM payment.payment WHERE reference=$1`, [reference],
  ).catch(() => []);
  const row = rows[0];
  if (!row || row.psp !== 'paga') return reply.code(404).type('text/plain; charset=utf-8').send('Payment not found.');
  let status = row.status;
  if (status === 'pending') status = (await syncPendingPayment(reference)) ?? status;
  const d = (typeof row.psp_details === 'string' ? JSON.parse(row.psp_details) : row.psp_details ?? {}) as Record<string, string | null>;
  const nonce = crypto.randomBytes(16).toString('base64');
  const expired = status === 'pending' && d.expiresAt ? Date.parse(`${String(d.expiresAt).replace(/Z?$/, 'Z')}`) < Date.now() : false;
  const page = renderPagaPayPage({
    status: expired ? 'expired' : status === 'successful' ? 'successful' : status === 'failed' ? 'failed' : 'pending',
    accountNumber: d.accountNumber ?? null, bankName: d.bankName ?? null,
    amountKobo: BigInt(String(d.amountToPayKobo ?? row.amount_kobo)), expiresAt: d.expiresAt ?? null,
    reference, sandbox: process.env.PAGA_ENV !== 'live', nonce,
  });
  return reply.header('Content-Security-Policy', pageCsp(nonce, false)).header('Cache-Control', 'no-store')
    .header('Referrer-Policy', 'no-referrer').type('text/html; charset=utf-8').send(page);
});

// Paga Business API money-transfer status (vendor payouts). Hash in x-paga-hash;
// Paga retries until it gets 200 {"status":"SUCCESS"}. Recorded once per reference+outcome.
app.post('/webhooks/paga/transfer', { config: { rawBody: true } }, (req, reply) => handlePagaTransferCallback(req, reply));

async function handlePagaTransferCallback(req: FastifyRequest, reply: FastifyReply) {
  if (!pagaCallbackIpAllowed(String(req.ip ?? ''), 'transfer')) return fail(reply, 'FORBIDDEN', 'Source not allowed', 403);
  const { PagaAdapter } = await import('../../../modules/payments/paga.adapter.js');
  const raw = Buffer.from((req as unknown as { rawBody?: string }).rawBody || JSON.stringify(req.body ?? {}));
  if (!new PagaAdapter().verifyTransferNotification(raw, req.headers as Record<string, string>)) {
    return fail(reply, 'BAD_SIGNATURE', 'Invalid Paga notification hash', 401);
  }
  const e = JSON.parse(raw.toString('utf-8')) as { referenceNumber?: string; responseCode?: number; transactionId?: string; message?: string };
  const reference = String(e.referenceNumber ?? '');
  const outcome = Number(e.responseCode) === 0 ? 'paid' : Number(e.responseCode) === 3 ? 'processing' : 'failed';
  try {
    await q(`INSERT INTO payment.webhook_event (psp, event_id, raw) VALUES ('paga', $1, $2)`, [`paga-transfer:${reference}:${outcome}`, raw.toString('utf-8')]);
  } catch { return { status: 'SUCCESS' }; } // already recorded
  if (reference) {
    await q(
      `UPDATE payment.payout SET status=$2, psp_reference=COALESCE($3, psp_reference), paid_at=CASE WHEN $2='paid' THEN now() ELSE paid_at END
        WHERE id::text=$1 AND status NOT IN ('paid','failed')`, // payouts send their row id as Paga's referenceNumber
      [reference, outcome, e.transactionId ?? null],
    ).catch((err) => observability.captureException(err));
  }
  return { status: 'SUCCESS' };
}

// Paga's dashboard has ONE callback URL (/webhooks/paga/subsidiary), so every request we send
// Paga names it, and this decides which handler a notification belongs to:
//   payout status       referenceNumber + responseCode           -> transfer handler
//   checkout payment    externalReferenceNumber of a Paga payment -> checkout handler
//   anything else       persistent (subsidiary) account events    -> virtual-account handler
async function routePagaCallback(req: FastifyRequest, reply: FastifyReply): Promise<unknown | undefined> {
  let body: Record<string, unknown>;
  try { body = JSON.parse(String((req as unknown as { rawBody?: string }).rawBody || JSON.stringify(req.body ?? {}))); } catch { return undefined; }
  if (!body || typeof body !== 'object' || body.event || body.accountNumber) return undefined;
  if (body.referenceNumber !== undefined && body.responseCode !== undefined) return handlePagaTransferCallback(req, reply);
  const ext = body.externalReferenceNumber ? String(body.externalReferenceNumber) : '';
  if (ext && (await q(`SELECT 1 FROM payment.payment WHERE reference=$1 AND psp='paga'`, [ext]))[0]) return handlePagaCheckoutCallback(req, reply);
  return undefined;
}

app.post('/v1/refunds', async (req, reply) => {
  const { bookingId, amountKobo, reason } = z.object({ bookingId: z.string(), amountKobo: z.string().regex(/^\d+$/), reason: z.string().max(1000) }).parse(req.body);
  // Customers may only REQUEST a refund on their own booking; money moves via
  // the finance-approved /v1/admin/refunds path.
  const p = await bookingParty(req as never, reply, bookingId); if (!p) return reply;
  if (p.as === 'provider') return fail(reply, 'FORBIDDEN', 'Only the customer can request a refund', 403);
  // Cap at what was actually collected, and evaluate policy on the REAL status
  // (the service default of CONFIRMED would auto-approve every request).
  const paid = await q<{ total: string }>(`SELECT COALESCE(SUM(amount_kobo),0) AS total FROM payment.payment WHERE booking_id=$1 AND status='successful'`, [bookingId]);
  if (BigInt(amountKobo) <= 0n || BigInt(amountKobo) > BigInt(String(paid[0]?.total ?? 0))) {
    return fail(reply, 'BAD_AMOUNT', 'Refund cannot exceed the amount paid for this booking');
  }
  const booking = await bookingService.getRaw(bookingId);
  return { data: await refundService.request(bookingId, BigInt(amountKobo), reason, booking?.status) };
});

// ---------- wallet (minimal per-user ledger; mock-gateway topups) ----------
// NOTE: payment webhooks and POST /v1/refunds are NOT hooked into the wallet:
// webhooks carry no authenticated user (booking->user attribution + double-spend
// semantics need a wallet design pass), and /v1/refunds only records a request.
// Topups credit via await walletService.credit; payments/refunds move wallet money
// through the exported await walletService.credit/debit (covered in tests/wallet.test.js).
app.get('/v1/wallet', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const balanceKobo = await walletService.getBalance(a.sub);
  const txns = await walletService.txns(a.sub);
  return { data: { balanceKobo, txns } };
});
app.post('/v1/wallet/topup', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const idem = req.headers['idempotency-key'];
  if (typeof idem !== 'string') return fail(reply, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key header required');
  const parsed = z.object({ amountKobo: z.number().int().min(100).max(50000000) }).safeParse(req.body);
  if (!parsed.success) return fail(reply, 'BAD_AMOUNT', 'amountKobo must be an integer kobo amount between 100 and 50000000');
  
  const user = await identityService.me(a.sub);
  try {
    const session = await payments.createCheckout({
      bookingId: 'wallet_topup', purpose: 'topup', amountKobo: BigInt(parsed.data.amountKobo),
      ...(user?.email ? { customerEmail: user.email } : {}), idempotencyKey: idem, userId: a.sub,
    });
    observability.track('wallet.topup_initiated', { psp: session.psp });
    return { data: session };
  } catch (e: unknown) { return checkoutFailure(reply, e); }
});

// Pay a booking from the customer's own wallet balance. No PSP session: the
// money is already held in payment.wallet_txn, so this is an idempotent debit
// that books the job as paid the same way the webhook does for a PSP charge.
// amountKobo is accepted but IGNORED — the server's price snapshot is charged,
// exactly like POST /v1/bookings/:id/payments (never trust the client's number).
app.post('/v1/bookings/:id/pay-with-wallet', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const idem = req.headers['idempotency-key'];
  if (typeof idem !== 'string' || !idem.trim()) return fail(reply, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key header required');
  const bookingId = (req.params as { id: string }).id;
  const booking = await bookingService.getRaw(bookingId);
  if (!booking) return fail(reply, 'BOOKING_NOT_FOUND', 'Booking not found', 404);
  if (booking.userId !== a.sub) return fail(reply, 'FORBIDDEN', 'Not your booking', 403);

  const expected = await expectedChargeKobo(bookingId, booking);
  const amountKobo = Number(expected);
  if (!Number.isSafeInteger(amountKobo) || amountKobo <= 0) {
    return fail(reply, 'BAD_AMOUNT', 'This booking has no payable amount yet', 400);
  }
  // Already settled? A fresh idempotency key mints a NEW bw_ ref, so replay
  // safety cannot ride on the debit's per-ref dedupe (that only catches a retry
  // of the SAME key). Check the booking first: if it is not in a pre-payment
  // state and has no successful intent, refuse to charge again. A completed
  // booking that DOES have a successful intent falls through and replays as paid.
  const settled = await q(`SELECT 1 FROM payment.payment WHERE booking_id=$1 AND status='successful'`, [bookingId]);
  if (booking.status !== 'REQUESTED' && booking.status !== 'PAYMENT_PENDING' && !settled[0]) {
    return fail(reply, 'BOOKING_NOT_PAYABLE', `Booking is ${booking.status} and cannot be paid from wallet`, 409);
  }

  // Stable idempotency: the wallet txn ref doubles as the payment.reference, so
  // a retry (or a double-tap) replays the SAME debit instead of charging twice.
  const ref = `bw_${bookingId}_${idem.slice(0, 24)}`;
  try {
    const alreadyPaid = !!settled[0];
    if (!alreadyPaid) {
      // Money held in the customer's Paga sub-account (account number) moves to
      // Kendibo first; the ledger debit follows. No account number: no-op.
      const replay = (await q(`SELECT 1 FROM payment.wallet_txn WHERE ref=$1`, [ref]))[0];
      if (!replay && (await walletService.getBalance(a.sub)) < amountKobo) throw new Error('INSUFFICIENT_FUNDS');
      let vaCharge: Awaited<ReturnType<typeof chargeForWalletPayment>> = null;
      if (!replay) {
        try { vaCharge = await chargeForWalletPayment(a.sub, ref, amountKobo); }
        catch (e) {
          if (e instanceof VaError) return fail(reply, e.code, e.message, e.status, e.status >= 500);
          throw e;
        }
      }
      try {
        await walletService.debit(a.sub, amountKobo, ref, 'payment', bookingId);
      } catch (e) {
        if (vaCharge) await reverseWalletCharge(vaCharge).catch((err) => observability.captureException(err));
        throw e;
      }
      // Book the job as paid before the intent row: a crash here leaves an
      // unpaid booking the user can retry (debit replays by ref), never a
      // charged-but-unpaid job.
      try { await postCollection(ref, expected, currentPeriod()); } catch (e) { observability.captureException(e); }
      await q(
        `INSERT INTO payment.payment (booking_id, psp, reference, charge_id, amount_kobo, status, user_id, purpose, subject_ref, received_kobo, settled_at, confirmed_at)
         VALUES ($1, 'wallet', $2, $2, $3, 'successful', $4, 'booking', $5, $3, now(), now())
         ON CONFLICT DO NOTHING`,
        [bookingId, ref, amountKobo, a.sub, bookingId],
      );
      await q(`UPDATE payment.payment SET status='successful' WHERE reference=$1 AND status<>'successful'`, [ref]);
    }
    observability.track('booking.paid_from_wallet', { bookingId, amountKobo, ref, replayed: alreadyPaid });
    return { data: { status: 'successful', reference: ref, amountKobo, method: 'WALLET' } };
  } catch (e: unknown) {
    const msg = (e as Error)?.message ?? '';
    if (msg.includes('INSUFFICIENT_FUNDS')) {
      return fail(reply, 'INSUFFICIENT_FUNDS', 'Your wallet balance is too low for this booking', 402);
    }
    observability.captureException(e);
    return fail(reply, 'WALLET_PAY_FAILED', `Could not pay from wallet: ${(e as Error)?.message ?? e}`, 500);
  }
});

// ---------- providers / dispatch / tracking / execution ----------
// Hybrid dispatch lifecycle helpers (also driven by the SLA sweep below).
async function advanceBookingAfterAccept(jobId: string): Promise<void> {
  try {
    const b = await bookingService.getRaw(jobId);
    if (!b) return;
    if (b.status === 'MATCHING') await bookingService.setStatus(jobId, 'PROVIDER_ASSIGNED', 'system');
    const after = await bookingService.getRaw(jobId);
    if (after?.status === 'PROVIDER_ASSIGNED') await bookingService.setStatus(jobId, 'PROVIDER_ACCEPTED', 'system');
  } catch (e) { observability.captureException(e); }
}
async function escalateJob(jobId: string): Promise<void> {
  try {
    const b = await bookingService.getRaw(jobId);
    if (!b || b.status !== 'MATCHING') return;
    const active = await q(`SELECT 1 FROM dispatch.assignment WHERE job_id=$1 AND status IN ('offered','accepted')`, [jobId]);
    if (active.length > 0) return;
    const addr = await q<Record<string, unknown>>(`SELECT lat, lng FROM property.address WHERE id=$1`, [b.addressId]);
    if (addr[0]?.lat == null || addr[0]?.lng == null) return;
    await dispatchService.escalateNext(jobId, b.serviceId, Number(addr[0].lat), Number(addr[0].lng));
  } catch (e) { observability.captureException(e); }
}
async function dispatchSweep(): Promise<void> {
  try {
    await dispatchService.expireOverdueOffers();
    const jobs = await q<Record<string, unknown>>(`SELECT DISTINCT job_id FROM dispatch.assignment WHERE status IN ('expired','declined')`);
    for (const row of jobs) await escalateJob(String(row.job_id));
  } catch (e) { observability.captureException(e); }
}

app.post('/v1/provider/onboarding', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  return { data: await providerService.onboard(a.sub) };
});
app.get('/v1/provider/me', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const provider = await providerService.byUserId(a.sub);
  return { data: provider };
});
// Session-scoped provider identity: never trust a client-supplied providerId.
// Returns the caller's provider row or sends the failure response and nulls out.
async function providerActor(req: never, reply: FastifyReply): Promise<{ id: string } | null> {
  const a = authed(req); if (!a) { void fail(reply, 'UNAUTHENTICATED', 'Login required', 401); return null; }
  const me = await providerService.byUserId(a.sub);
  if (!me) { void fail(reply, 'NOT_FOUND', 'Provider profile not found', 404); return null; }
  return { id: me.id };
}
// Storefront gallery: photos uploaded via the media pipeline, then referenced
// here. Reads are public (customers view the storefront); writes are session-scoped.
app.get('/v1/provider/gallery/mine', async (req, reply) => {
  const me = await providerActor(req as never, reply);
  if (!me) return reply;
  return { data: await providerService.gallery(me.id) };
});
app.get('/v1/provider/:id/gallery', async (req) => ({
  data: await providerService.gallery((req.params as { id: string }).id),
}));
app.post('/v1/provider/gallery', async (req, reply) => {
  const me = await providerActor(req as never, reply);
  if (!me) return reply;
  const { assetId, caption } = z.object({ assetId: z.string(), caption: z.string().max(200).optional() }).parse(req.body ?? {});
  try {
    return { data: await providerService.galleryAdd(me.id, assetId, caption) };
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg === 'ASSET_NOT_FOUND') return fail(reply, 'NOT_FOUND', 'Media asset not found', 404);
    if (msg === 'ASSET_NOT_CLEAN') return fail(reply, 'NOT_CLEAN', 'Upload the photo through the media pipeline first', 409);
    throw e;
  }
});
app.delete('/v1/provider/gallery/:entryId', async (req, reply) => {
  const me = await providerActor(req as never, reply);
  if (!me) return reply;
  try {
    return { data: await providerService.galleryRemove(me.id, (req.params as { entryId: string }).entryId) };
  } catch (e: unknown) {
    if ((e as Error).message === 'NOT_FOUND') return fail(reply, 'NOT_FOUND', 'Gallery photo not found', 404);
    throw e;
  }
});
app.post('/v1/provider/kyc', async (req, reply) => {
  const a = authed(req as never);
  const me = await providerActor(req as never, reply);
  if (!me) return reply;
  const {
    nin, bvn, rcNumber, businessName, headline, bio,
    officeAddress, officeStreet, officeLandmark, officeCity,
    skills, bank, location, radiusKm, documents, selfieBase64,
  } = z.object({
    nin: z.string().optional(),
    bvn: z.string().optional(),
    rcNumber: z.string().optional(),
    businessName: z.string().optional(),
    headline: z.string().optional(),
    bio: z.string().optional(),
    officeAddress: z.string().optional(),
    officeStreet: z.string().optional(),
    officeLandmark: z.string().optional(),
    officeCity: z.string().optional(),
    skills: z.array(z.string()).optional(),
    bank: z.object({
      accountNumber: z.string(),
      bankCode: z.string(),
      bankName: z.string().optional(),
      accountName: z.string().optional(),
    }).optional(),
    location: z.object({ lat: z.number(), lng: z.number() }).optional(),
    radiusKm: z.number().int().min(1).max(50).optional(),
    selfieBase64: z.string().optional(),
    documents: z.array(z.object({
      assetId: z.string(),
      kind: z.enum(['id_front', 'id_back', 'selfie', 'cac', 'address', 'other']),
    })).max(8).optional(),
  }).parse(req.body ?? {});

  if (businessName || headline || bio || officeAddress || officeStreet || officeLandmark || officeCity || bank || location || radiusKm) {
    const sets: string[] = []; const vals: unknown[] = [];
    if (businessName) { sets.push(`business_name=$${vals.length + 1}`); vals.push(businessName); }
    if (headline) { sets.push(`headline=$${vals.length + 1}`); vals.push(headline); }
    if (bio) { sets.push(`bio=$${vals.length + 1}`); vals.push(bio); }
    if (officeAddress) { sets.push(`office_address=$${vals.length + 1}`); vals.push(officeAddress); }
    if (officeStreet) { sets.push(`office_street=$${vals.length + 1}`); vals.push(officeStreet); }
    if (officeLandmark) { sets.push(`office_landmark=$${vals.length + 1}`); vals.push(officeLandmark); }
    if (officeCity) { sets.push(`office_city=$${vals.length + 1}`); vals.push(officeCity); }
    if (headline || bio || businessName) { sets.push(`storefront_completed=TRUE`); }
    if (bank) {
      sets.push(`account_number=$${vals.length + 1}`, `bank_code=$${vals.length + 2}`, `bank_changed_at=now()`);
      vals.push(bank.accountNumber, bank.bankCode);
      if (bank.accountName) { sets.push(`account_name=$${vals.length + 1}`); vals.push(bank.accountName); }
      if (bank.bankName) { sets.push(`bank_name=$${vals.length + 1}`); vals.push(bank.bankName); }
    }
    if (location) { sets.push(`lat=$${vals.length + 1}`, `lng=$${vals.length + 2}`); vals.push(location.lat, location.lng); }
    if (radiusKm) { sets.push(`service_radius_km=$${vals.length + 1}`); vals.push(radiusKm); }
    if (sets.length > 0) await q(`UPDATE provider.provider SET ${sets.join(', ')} WHERE id=$${vals.length + 1}`, [...vals, me.id]);
    if (bank) emit('provider.bank_added', { providerId: me.id });
  }
  if (rcNumber || businessName) emit('provider.kyb_submitted', { providerId: me.id, hasRcNumber: Boolean(rcNumber) });
  for (const s of skills ?? []) { try { await providerService.addSkill(me.id, s); } catch { /* unknown skill tag */ } }
  if (documents?.length) {
    try { await kycService.attachDocuments(me.id, documents); }
    catch (e: unknown) {
      const msg = (e as Error).message;
      if (msg === 'ASSET_NOT_FOUND') return fail(reply, 'NOT_FOUND', 'Media asset not found — upload through the media pipeline first', 404);
      if (msg === 'ASSET_NOT_CLEAN') return fail(reply, 'NOT_CLEAN', 'Document upload still in moderation', 409);
      throw e;
    }
  }

  // Load user's profile name and existing provider record for strict Name <-> CAC <-> Bank alignment
  const userProfile = a ? await identityService.me(a.sub).catch(() => null) : null;
  const provRow = await providerService.byId(me.id);

  // Tiered vendor checks (NIN/BVN -> doc+face -> CAC/address + Name Alignment).
  if (documents?.length || nin || bvn || rcNumber || selfieBase64) {
    const outcome = await kycService.runTierChecks('provider', me.id, {
      nin,
      bvn,
      rcNumber: rcNumber ?? provRow?.cacNumber ?? undefined,
      businessName: businessName ?? provRow?.businessName ?? undefined,
      submittedName: userProfile?.name ?? undefined,
      bankAccountName: bank?.accountName ?? provRow?.accountName ?? undefined,
      selfieBase64,
      documents: documents ?? [],
    });
    const applied = await kycService.applyProviderTier(me.id, outcome);
    if (a?.sub) {
      void slingAutomationService.triggerEvent(
        applied?.status === 'VERIFIED' ? 'provider.kyc_verified' : 'provider.kyc_submitted',
        a.sub,
        {
          provider: businessName ?? provRow?.businessName ?? userProfile?.name ?? 'Vendor',
          status: applied?.status ?? 'UNDER_REVIEW',
        },
      ).catch(() => {});
    }
    return { data: applied };
  }
  return { data: await kycService.status(me.id) };
});

// Storefront & Office Pinpoint management for professional vendors
const storefrontPatchSchema = z.object({
  businessName: z.string().min(2).max(120).optional(),
  headline: z.string().max(160).optional(),
  bio: z.string().max(1000).optional(),
  officeAddress: z.string().max(240).optional(),
  officeStreet: z.string().max(200).optional(),
  officeLandmark: z.string().max(160).optional(),
  officeCity: z.string().max(80).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  serviceRadiusKm: z.number().int().min(1).max(50).optional(),
  operatingHours: z.record(z.string(), z.unknown()).optional(),
  skills: z.array(z.string()).optional(),
  storefrontCompleted: z.boolean().optional(),
  onboardingStep: z.string().optional(),
});
app.patch('/v1/provider/storefront', async (req, reply) => {
  const me = await providerActor(req as never, reply);
  if (!me) return reply;
  const patch = storefrontPatchSchema.parse(req.body ?? {});
  return { data: await providerService.updateStorefront(me.id, patch) };
});
app.put('/v1/provider/storefront', async (req, reply) => {
  const me = await providerActor(req as never, reply);
  if (!me) return reply;
  const patch = storefrontPatchSchema.parse(req.body ?? {});
  return { data: await providerService.updateStorefront(me.id, patch) };
});

// Bolt-Style AI Dispatch & Request Radar Feed for Vendors
app.get('/v1/provider/dispatch-feed', async (req, reply) => {
  const me = await providerActor(req as never, reply);
  if (!me) return reply;
  return { data: await providerService.dispatchFeedFor(me.id) };
});
app.post('/v1/provider/dispatch-feed/respond', async (req, reply) => {
  const me = await providerActor(req as never, reply);
  if (!me) return reply;
  const { feedType, offerId, requestId, accept, counterKobo } = z.object({
    feedType: z.enum(['job_offer', 'request_offer', 'open_field_request']),
    offerId: z.string().optional(),
    requestId: z.string().optional(),
    accept: z.boolean().optional().default(false),
    // Request offers only: the pro's own price, once (customer accepts or declines).
    counterKobo: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).optional(),
  }).parse(req.body ?? {});
  if (counterKobo !== undefined) {
    if (feedType !== 'request_offer' || !offerId) return fail(reply, 'BAD_REQUEST', 'A counter-price applies to request offers only.', 400);
    const own = await q<{ provider_id: string; category_id: string | null }>(
      `SELECT o.provider_id, r.category_id FROM booking.request_offer o JOIN booking.service_request r ON r.id=o.request_id WHERE o.id=$1`, [offerId],
    );
    if (!own[0] || String(own[0].provider_id) !== me.id) return fail(reply, 'NOT_FOUND', 'Offer not found', 404);
    if (!(await vendorEligibilityService.allowed(me.id, own[0].category_id, { amountKobo: BigInt(counterKobo) }))) return fail(reply, 'NOT_ELIGIBLE', 'Complete your verification first, and keep the price within your tier limit.', 403);
    try { return { data: await requestService.counterOffer(offerId, me.id, BigInt(counterKobo)) }; }
    catch (e: unknown) {
      const m = (e as Error).message;
      if (m.startsWith('BELOW_MINIMUM')) return fail(reply, 'BELOW_MINIMUM', `The lowest price is ₦${(Number(m.split(':')[1]) / 100).toLocaleString('en-NG')}.`, 400);
      return fail(reply, 'OFFER_GONE', 'You can send one price per job, while the offer is open.', 409);
    }
  }

  // Ownership + category rules, whichever feed the item came from.
  let categoryId: string | null = null;
  if (feedType === 'job_offer' && offerId) {
    const o = await q<{ provider_id: string; job_id: string }>(`SELECT provider_id, job_id FROM dispatch.assignment WHERE id=$1`, [offerId]);
    if (!o[0] || String(o[0].provider_id) !== me.id) return fail(reply, 'NOT_FOUND', 'Offer not found', 404);
    const c = await q<{ category_id: string }>(
      `SELECT s.category_id FROM booking.booking b JOIN catalog.service s ON s.id=b.service_id WHERE b.id::text=$1`, [String(o[0].job_id)],
    ).catch(() => []);
    categoryId = c[0]?.category_id ? String(c[0].category_id) : null;
  } else if (feedType === 'request_offer' && offerId) {
    const o = await q<{ provider_id: string; category_id: string | null }>(
      `SELECT o.provider_id, r.category_id FROM booking.request_offer o JOIN booking.service_request r ON r.id=o.request_id WHERE o.id=$1`, [offerId],
    );
    if (!o[0] || String(o[0].provider_id) !== me.id) return fail(reply, 'NOT_FOUND', 'Offer not found', 404);
    categoryId = o[0].category_id ? String(o[0].category_id) : null;
  } else if (feedType === 'open_field_request' && requestId) {
    const r = await q<{ category_id: string | null }>(`SELECT category_id FROM booking.service_request WHERE id=$1`, [requestId]);
    if (!r[0]) return fail(reply, 'NOT_FOUND', 'Request not found', 404);
    categoryId = r[0].category_id ? String(r[0].category_id) : null;
  }
  // Tier caps: the job's price and the pro's open jobs (modules/tiers).
  const jobCtx = accept ? {
    accepting: true, ref: offerId ?? requestId ?? null,
    amountKobo: await tierService.jobAmountKobo(
      feedType === 'job_offer' ? { assignmentId: offerId } : feedType === 'request_offer' ? { requestOfferId: offerId } : { requestId },
    ).catch(() => null),
  } : {};
  if (accept && !(await vendorEligibilityService.allowed(me.id, categoryId, jobCtx))) {
    const why = await vendorEligibilityService.evaluate(me.id, categoryId ?? '', jobCtx).catch(() => null);
    return fail(reply, 'NOT_ELIGIBLE', `Complete these first: ${(why?.missing ?? ['verification']).join(', ')}`, 403);
  }

  try {
    if (feedType === 'job_offer' && offerId) {
      const result = (await providerService.respondToOffer(offerId, accept)) as Record<string, unknown>;
      const jobId = String(result.job_id ?? result.jobId ?? '');
      if (jobId) {
        if (accept) await advanceBookingAfterAccept(jobId);
        else await escalateJob(jobId);
      }
      return { data: result };
    }
    if (feedType === 'request_offer' && offerId) {
      const result = (await requestService.respondOffer(offerId, accept)) as Record<string, unknown>;
      if (accept && result.bookingId) {
        const bookingId = String(result.bookingId);
        await bookingService.setStatus(bookingId, 'MATCHING', 'system').catch(() => {});
        await advanceBookingAfterAccept(bookingId);
      }
      return { data: result };
    }
    if (feedType === 'open_field_request' && requestId) {
      if (!accept) return { data: { requestId, status: 'declined' } };
      // Create an offer row on the fly if none exists for this provider, then accept it
      const existing = await q<{ id: string }>(
        `SELECT id FROM booking.request_offer WHERE request_id=$1 AND provider_id=$2`,
        [requestId, me.id],
      );
      let reqOfferId = existing[0]?.id ? String(existing[0].id) : '';
      if (!reqOfferId) {
        const ins = await q<{ id: string }>(
          `INSERT INTO booking.request_offer (request_id, provider_id, eta_minutes) VALUES ($1,$2,20) RETURNING id`,
          [requestId, me.id],
        );
        reqOfferId = String(ins[0].id);
        await q(`UPDATE booking.service_request SET status='OFFERED' WHERE id=$1 AND status IN ('SUBMITTED','MATCHING')`, [requestId]);
      }
      const result = (await requestService.respondOffer(reqOfferId, true)) as Record<string, unknown>;
      if (result.bookingId) {
        const bookingId = String(result.bookingId);
        await bookingService.setStatus(bookingId, 'MATCHING', 'system').catch(() => {});
        await advanceBookingAfterAccept(bookingId);
      }
      return { data: result };
    }
    return fail(reply, 'BAD_REQUEST', 'Invalid dispatch feed response payload');
  } catch (e: unknown) {
    return fail(reply, 'OFFER_GONE', (e as Error).message, 409);
  }
});

// ── USER (customer) KYC — session-scoped tiered verification + 60s Fast Track ──
// Same 3-tier ladder as providers; customer rows live in kyc.customer.
app.get('/v1/user/kyc', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  return { data: await kycService.userStatus(a.sub) };
});
app.post('/v1/user/kyc', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  // selfieBase64 is still accepted from older app versions but ignored:
  // customers verify with NIN/BVN only (face checks are for providers).
  const { nin, bvn, rcNumber, businessName, fullName, dateOfBirth, documents: rawDocuments } = z.object({
    nin: z.string().optional(), bvn: z.string().optional(),
    // Checked against the NIN/BVN record: full name (name alignment) and date of birth.
    fullName: z.string().trim().min(3).max(120).optional(),
    dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional(),
    rcNumber: z.string().optional(), businessName: z.string().optional(),
    selfieBase64: z.string().optional(),
    documents: z.array(z.object({
      assetId: z.string(),
      kind: z.enum(['id_front', 'id_back', 'selfie', 'cac', 'address', 'other']),
    })).max(8).optional(),
  }).parse(req.body ?? {});
  const documents = (rawDocuments ?? []).filter((d) => d.kind !== 'selfie');
  if (documents.length) {
    try { await kycService.attachUserDocuments(a.sub, documents); }
    catch (e: unknown) {
      const msg = (e as Error).message;
      if (msg === 'ASSET_NOT_FOUND') return fail(reply, 'NOT_FOUND', 'Media asset not found — upload through the media pipeline first', 404);
      if (msg === 'ASSET_NOT_CLEAN') return fail(reply, 'NOT_CLEAN', 'Document upload still in moderation', 409);
      throw e;
    }
  }
  if (documents.length || nin || bvn || rcNumber) {
    const applied = await kycService.submitUserApplication(a.sub, {
      nin, bvn, rcNumber, businessName, documents,
      ...(fullName ? { submittedName: fullName } : {}),
      ...(dateOfBirth ? { dateOfBirth } : {}),
    });
    // Customers hear from us only when the outcome is known (verified here,
    // or approved/rejected by an admin later), never on submission.
    if (applied.status === 'VERIFIED') {
      void slingAutomationService.triggerEvent('user.kyc_verified', a.sub, { status: applied.status }).catch(() => {});
    }
    return { data: applied };
  }
  return { data: await kycService.userStatus(a.sub) };
});
app.post('/v1/provider/skills', async (req, reply) => {
  const me = await providerActor(req as never, reply);
  if (!me) return reply;
  const { skill } = z.object({ skill: z.string() }).parse(req.body);
  const out = await providerService.addSkill(me.id, skill);
  // Adding a service enrolls the vendor in its trade so the app can show
  // exactly what that trade still needs (licence, tier, …).
  // A skill is a category id, a service id or a skill tag (catalog.service.requires_skill).
  for (const c of await categoriesForSkills([skill])) await vendorEligibilityService.enroll(me.id, c).catch((e) => observability.captureException(e));
  return { data: out };
});
app.post('/v1/provider/online', async (req, reply) => {
  const me = await providerActor(req as never, reply);
  if (!me) return reply;
  const { online, lat, lng } = z.object({ online: z.boolean(), lat: z.number().optional(), lng: z.number().optional() }).parse(req.body);
  if (online) {
    // Accepting live work requires an approved account — dispatch candidates,
    // customer provider strips and payout rails all assume VERIFIED/active.
    const rows = await q<{ kyc_status: string; status: string; verify_level: string }>(
      `SELECT kyc_status, status, verify_level FROM provider.provider WHERE id=$1`, [me.id]);
    const r = rows[0];
    // NIN in manual review: a pro who finished Tier 1 may work at Tier 1 limits meanwhile.
    const manualTier1 = r && String(r.kyc_status) === 'UNDER_REVIEW'
      ? await tierService.tier1Status(me.id).then((t) => t.manualReview && t.done).catch(() => false)
      : false;
    if (!r || (String(r.kyc_status) !== 'VERIFIED' && !manualTier1) || String(r.status) !== 'active' || String(r.verify_level) === 'suspended') {
      return fail(reply, 'KYC_REQUIRED', 'Complete identity verification before going online', 403);
    }
  }
  return { data: await providerService.setOnline(me.id, online, lat, lng) };
});
app.get('/v1/provider/offers', async (req, reply) => {
  const me = await providerActor(req as never, reply);
  if (!me) return reply;
  return { data: await providerService.offersFor(me.id) };
});
app.post('/v1/provider/offers/:id/respond', async (req, reply) => {
  const me = await providerActor(req as never, reply);
  if (!me) return reply;
  const { accept } = z.object({ accept: z.boolean() }).parse(req.body);
  const offerId = (req.params as { id: string }).id;
  const owned = await q<{ provider_id: string }>(`SELECT provider_id FROM dispatch.assignment WHERE id=$1`, [offerId]);
  if (!owned[0] || String(owned[0].provider_id) !== me.id) return fail(reply, 'NOT_FOUND', 'Offer unavailable', 404);
  if (accept) {
    // Same gate as the dispatch feed: category rules + tier caps on this job.
    const jobRow = await q<{ job_id: string }>(`SELECT job_id FROM dispatch.assignment WHERE id=$1`, [offerId]);
    const jobId = String(jobRow[0]?.job_id ?? '');
    const c = await q<{ category_id: string }>(
      `SELECT s.category_id FROM booking.booking b JOIN catalog.service s ON s.id=b.service_id WHERE b.id::text=$1`, [jobId],
    ).catch(() => []);
    const categoryId = c[0]?.category_id ? String(c[0].category_id) : null;
    const jobCtx = { accepting: true, ref: offerId, amountKobo: await tierService.jobAmountKobo({ bookingId: jobId }).catch(() => null) };
    if (!(await vendorEligibilityService.allowed(me.id, categoryId, jobCtx))) {
      const why = await vendorEligibilityService.evaluate(me.id, categoryId ?? '', jobCtx).catch(() => null);
      return fail(reply, 'NOT_ELIGIBLE', `Complete these first: ${(why?.missing ?? ['verification']).join(', ')}`, 403);
    }
  }
  let result: Record<string, unknown>;
  try {
    result = (await providerService.respondToOffer(offerId, accept)) as Record<string, unknown>;
  } catch (e: unknown) {
    return fail(reply, 'OFFER_GONE', (e as Error).message, 409);
  }
  const jobId = String(result.job_id ?? result.jobId ?? '');
  if (jobId) {
    if (accept) await advanceBookingAfterAccept(jobId);
    else await escalateJob(jobId);
  }
  return { data: result };
});
app.post('/v1/provider/sync', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const { commands } = z.object({ commands: z.array(z.object({ clientEventId: z.string(), command: z.string(), jobId: z.string() })) }).parse(req.body);
  return { data: { results: await providerService.sync(commands) } };
});
app.post('/v1/provider/location', async (req, reply) => {
  const me = await providerActor(req as never, reply);
  if (!me) return reply;
  const { lat, lng } = z.object({ lat: z.number(), lng: z.number() }).parse(req.body);
  return { data: await providerService.updateLocation(me.id, lat, lng) };
});
// Approved providers visible to customers ("providers in your area" home strip).
// Only KYC-verified, active accounts are listed; customers see an empty strip
// until a real approved provider has applied.
app.get('/v1/providers/approved', async () => {
  const rows = await q<Record<string, unknown>>(
    `SELECT p.id, p.rating, p.service_radius_km, p.lat, p.lng,
            p.business_name, p.headline, p.office_city, p.cac_verified, u.name
       FROM provider.provider p JOIN identity.users u ON u.id = p.user_id
      WHERE p.kyc_status = 'VERIFIED' AND p.status = 'active'
      ORDER BY p.rating DESC LIMIT 20`,
  );
  return {
    data: rows.map((r) => ({
      id: String(r.id),
      name: String(r.business_name ?? r.name ?? 'Provider'),
      businessName: r.business_name ? String(r.business_name) : null,
      headline: r.headline ? String(r.headline) : null,
      officeCity: r.office_city ? String(r.office_city) : null,
      cacVerified: Boolean(r.cac_verified),
      rating: Number(r.rating ?? 5),
      serviceRadiusKm: Number(r.service_radius_km ?? 15),
      lat: (r.lat as number) ?? null,
      lng: (r.lng as number) ?? null,
    })),
  };
});

// Public Storefront endpoint for customers viewing a vendor's profile, packages & work gallery
// Delegates to storefrontService.publicView (verified + active vendors only, no
// invented rating or "certified" copy, no live coordinates or CAC number) and
// keeps the legacy field names the app's provider screen reads.
async function buildPublicStorefront(providerId: string) {
  const sf = await storefrontService.publicView(providerId);
  if (!sf) return null;
  const p = await providerService.byId(providerId);
  return {
    ...sf,
    officeAddress: p?.officeAddress ?? null,
    lat: null,
    lng: null,
    kycVerified: sf.badges.identityVerified,
    cacVerified: sf.badges.businessRegistered,
    faceVerified: sf.badges.faceVerified,
  };
}

app.get('/v1/providers/:id', async (req, reply) => {
  const data = await buildPublicStorefront((req.params as { id: string }).id);
  if (!data) return fail(reply, 'NOT_FOUND', 'Provider storefront not found', 404);
  return { data };
});
app.get('/v1/providers/:id/storefront', async (req, reply) => {
  const data = await buildPublicStorefront((req.params as { id: string }).id);
  if (!data) return fail(reply, 'NOT_FOUND', 'Provider storefront not found', 404);
  return { data };
});
app.get('/v1/dispatch/candidates', async (req) => {
  const q = req.query as { serviceId: string; lat: string; lng: string };
  return { data: await dispatchService.findCandidates({ serviceId: q.serviceId, lat: Number(q.lat), lng: Number(q.lng) }) };
});
app.post('/v1/dispatch/assign', async (req) => {
  // booking:override enforced by ROUTE_POLICY against the caller's DB role.
  const { jobId, providerId } = z.object({ jobId: z.string(), providerId: z.string() }).parse(req.body);
  return { data: await dispatchService.assign(jobId, providerId) };
});
// Current job status from the event log (server-authoritative; transition()
// appends job_event rows and does not touch booking.status). Fast path: indexed
// job_id lookup (real Postgres). Fallback: scan recent rows in JS — pg-mem
// misses constant TEXT lookups, same pattern as provider.service offer
// reactivation. A job with no events yet starts from its booking status.
async function currentJobStatus(jobId: string): Promise<JobStatus | null> {
  let latest: { to_status: string } | undefined;
  try {
    const scoped = await q<{ to_status: string }>(
      `SELECT to_status FROM booking.job_event WHERE job_id=$1 ORDER BY created_at DESC LIMIT 1`, [jobId]);
    latest = scoped[0];
  } catch { latest = undefined; }
  if (!latest) {
    const events = await q<{ job_id: string; to_status: string }>(
      `SELECT job_id, to_status FROM booking.job_event ORDER BY created_at DESC LIMIT 200`,
    );
    latest = events.find((e) => String(e.job_id) === jobId);
  }
  const status = latest?.to_status ?? (await bookingService.getRaw(jobId))?.status;
  return status ? (status as JobStatus) : null;
}
app.post('/v1/jobs/:id/transition', async (req, reply) => {
  const jobId = (req.params as { id: string }).id;
  const party = await bookingParty(req as never, reply, jobId); if (!party) return reply;
  // `from` and `actor` are accepted for older clients but never trusted: the
  // current status comes from the event log and the actor from the session.
  const { to, code } = z.object({ from: z.string().optional(), to: z.string(), actor: z.string().optional(), code: z.string().max(8).optional() }).parse(req.body);
  const from = await currentJobStatus(jobId);
  if (!from) return fail(reply, 'NOT_FOUND', 'No job events for this job', 404);
  // Each side may only make its own moves (a provider can't confirm for the customer).
  const reason = whyNot(party.as, from, to as JobStatus);
  if (reason) return fail(reply, 'NOT_YOUR_STEP', reason, 403);
  // Check-in needs the start code the customer reads out at the door.
  if (to === 'CHECK_IN' && party.as === 'provider') {
    const check = await checkStartCode(jobId, code);
    if (check === 'missing') return fail(reply, 'START_CODE_MISSING', 'Ask the customer to open the booking for their start code.', 409);
    if (check === 'locked') return fail(reply, 'START_CODE_LOCKED', 'Too many wrong codes. Contact Kendibo support to continue.', 423);
    if (check === 'wrong') return fail(reply, 'START_CODE_WRONG', 'That code is not right. Ask the customer to read it again.', 400);
    // The pro must actually be at the address (when we have a fresh location).
    const assigned = await q<{ provider_id: string }>(`SELECT provider_id FROM dispatch.assignment WHERE job_id=$1 AND status='accepted' LIMIT 1`, [jobId]);
    if (assigned[0]) {
      const near = await checkInDistance(jobId, String(assigned[0].provider_id));
      if (near.result === 'far') return fail(reply, 'TOO_FAR', `You seem to be about ${near.metres} m from the job address. Check in when you are there.`, 403);
    }
    if (selfieRequired() && !(await selfiePassed(jobId))) {
      return fail(reply, 'SELFIE_REQUIRED', 'Take your check-in selfie first so the customer knows it is you.', 409);
    }
  }
  try {
    const out = await transition(jobId, from, to as JobStatus, party.as);
    void afterTransition(jobId, to as JobStatus).catch((e) => observability.captureException(e));
    return out;
  } catch (e: unknown) { return fail(reply, 'ILLEGAL_TRANSITION', (e as Error).message, 409); }
});
// The pro's check-in selfie for this job (liveness via the KYC provider; kept as evidence).
app.post('/v1/provider/jobs/:id/checkin-selfie', { bodyLimit: 12 * 1024 * 1024 }, async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const party = await bookingParty(req as never, reply, id); if (!party) return reply;
  if (party.as !== 'provider') return fail(reply, 'FORBIDDEN', 'Only the assigned provider can do this', 403);
  const { selfieBase64 } = z.object({ selfieBase64: z.string().min(100).max(11_000_000) }).parse(req.body);
  const out = await recordCheckinSelfie(id, selfieBase64);
  if (!out.ok) return fail(reply, 'SELFIE_NOT_VERIFIED', out.reason === 'PHOTO_REJECTED' ? 'That photo could not be used. Take a clear selfie in good light.' : 'We could not verify that selfie. Try again facing the camera.', 422);
  return { data: { verified: true } };
});
// Ratings both ways; each side sees the other's only once both have rated (or after 14 days).
app.get('/v1/bookings/:id/ratings', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const party = await bookingParty(req as never, reply, id); if (!party) return reply;
  if (party.as === 'admin') return fail(reply, 'FORBIDDEN', 'Use the admin console', 403);
  return { data: await ratingsFor(id, party.as) };
});
// The customer's start code, shown only to them (never to the provider).
app.get('/v1/bookings/:id/start-code', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const party = await bookingParty(req as never, reply, id); if (!party) return reply;
  if (party.as !== 'customer') return fail(reply, 'FORBIDDEN', 'Only the customer can see the start code', 403);
  return { data: { code: await ensureStartCode(id) } };
});
// Customer confirms the work is done (also: WhatsApp "DONE", or auto after 48h).
app.post('/v1/bookings/:id/confirm-done', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const party = await bookingParty(req as never, reply, id); if (!party) return reply;
  if (party.as !== 'customer') return fail(reply, 'FORBIDDEN', 'Only the customer can confirm the job is done', 403);
  const out = await confirmCompletion(id, 'customer');
  if (out === 'not_ready') return fail(reply, 'NOT_COMPLETED', 'The provider has not marked this job as done yet.', 409);
  if (out === 'disputed') return fail(reply, 'DISPUTED', 'This job has an open report. Our team will settle it with you.', 409);
  return { data: { status: 'CUSTOMER_CONFIRMATION' } };
});
app.post('/v1/jobs/:id/settle', async (req, reply) => {
  // The split is computed server-side from what was actually collected and the
  // category's commission rule; body amounts are accepted for old clients but ignored.
  z.object({ totalKobo: z.string().optional(), providerKobo: z.string().optional() }).parse(req.body ?? {});
  const jobId = (req.params as { id: string }).id;
  const assigned = await q<{ provider_id: string }>(`SELECT provider_id FROM dispatch.assignment WHERE job_id=$1 AND status='accepted'`, [jobId]);
  if (!assigned[0]) return fail(reply, 'NO_PROVIDER', 'No accepted provider for this job', 409);
  try {
    const split = await vendorFinanceService.creditEarning(String(assigned[0].provider_id), jobId);
    const j = await postSettlement(`settle_${jobId}`, split.collectedKobo, split.providerKobo, currentPeriod(), split.vatKobo);
    const tb = await trialBalance();
    return { data: { balanced: tb.balanced, journal: j.reference, split: { ...split, collectedKobo: String(split.collectedKobo), commissionKobo: String(split.commissionKobo), providerKobo: String(split.providerKobo), vatKobo: String(split.vatKobo) } } };
  } catch (e: unknown) { return fail(reply, 'SETTLEMENT_BLOCKED', (e as Error).message, 409); }
});
app.get('/v1/bookings/:id/eta', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!(await bookingParty(req as never, reply, id))) return reply;
  const b = await bookingService.get(id);
  if (!b) return fail(reply, 'NOT_FOUND', 'Booking not found', 404);
  const minutes = await geoService.etaMinutes(b.id, b.addressId);
  return { data: { minutes } };
});

// ---------- messaging / notifications / media ----------
app.get('/v1/jobs/:id/messages', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!(await bookingParty(req as never, reply, id))) return reply;
  return { data: await messagingService.list(id) };
});
app.post('/v1/jobs/:id/messages', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const party = await bookingParty(req as never, reply, id); if (!party) return reply;
  // Sender is the session user id, never the client's `from` claim.
  const { body } = z.object({ from: z.string().optional(), body: z.string().min(1).max(4000) }).parse(req.body);
  return { data: await messagingService.send(id, party.sub, body) };
});
app.post('/v1/notify', async (req, reply) => {
  const { template, to, vars } = z.object({
    template: z.enum(TEMPLATES as unknown as [string, ...string[]]),
    to: z.object({
      userId: z.string().optional(),
      push: z.string().optional(),
      phone: z.string().optional(),
      whatsapp: z.string().optional(),
      email: z.string().optional(),
    }),
    vars: z.record(z.string(), z.string()).optional(),
  }).parse(req.body);
  void reply;
  return await notificationService.dispatch(template as (typeof TEMPLATES)[number], to, vars as Record<string, string>);
});

// ---------- Sling Omnichannel Communications, AI CTA Retainers & Bulk Campaigns ----------
const CHANNEL_ENUM = z.enum(['push', 'sms', 'whatsapp', 'rcs', 'truecaller', 'email', 'inapp']);
const AI_GOAL_ENUM = z.enum([
  'retainer_maintenance',
  'winback_inactive',
  'quote_followup',
  'seasonal_promo',
  'warranty_renewal',
  'loyalty_cashback',
  'operational_alert',
]);
const CADENCE_ENUM = z.enum(['weekly', 'biweekly', 'monthly', 'quarterly', 'winback_14d', 'winback_30d']);

// User Inbox & Read state
app.get('/v1/me/notifications', async (req, reply) => {
  const a = authed(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  return { data: await notificationService.listInbox(a.sub) };
});
app.post('/v1/me/notifications/:id/read', async (req, reply) => {
  const a = authed(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const ok = await notificationService.markRead(a.sub, (req.params as { id: string }).id);
  return { data: { read: ok } };
});

// User Omnichannel & Category Notification Preferences (synced with Sling Contact)
app.get('/v1/me/notification-preferences', async (req, reply) => {
  const a = authed(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  return { data: await notificationService.getUserPreferences(a.sub) };
});
const prefPatchSchema = z.object({
  order: z.boolean().optional(),
  chat: z.boolean().optional(),
  maint: z.boolean().optional(),
  promo: z.boolean().optional(),
  cashback: z.boolean().optional(),
  push: z.boolean().optional(),
  sms: z.boolean().optional(),
  wa: z.boolean().optional(),
  rcs: z.boolean().optional(),
  email: z.boolean().optional(),
  tips: z.boolean().optional(),
  preferredChannel: z.enum(['whatsapp', 'sms', 'push', 'rcs', 'email']).optional(),
});
app.put('/v1/me/notification-preferences', async (req, reply) => {
  const a = authed(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const patch = prefPatchSchema.parse(req.body ?? {});
  const updated = await notificationService.updateUserPreferences(a.sub, patch);
  return { data: updated };
});
app.patch('/v1/me/notification-preferences', async (req, reply) => {
  const a = authed(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const patch = prefPatchSchema.parse(req.body ?? {});
  const updated = await notificationService.updateUserPreferences(a.sub, patch);
  return { data: updated };
});

// AI-Assisted Customer Retainers (Smart Preventive Maintenance & Win-Back Cadences)
app.get('/v1/me/retainers', async (req, reply) => {
  const a = authed(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  return { data: await slingAutomationService.listUserRetainers(a.sub) };
});
app.post('/v1/me/retainers', async (req, reply) => {
  const a = authed(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const body = z.object({
    propertyId: z.string().optional(),
    serviceId: z.string().default('home_cleaning'),
    serviceName: z.string().default('Preventive Home & AC Maintenance'),
    cadence: CADENCE_ENUM.default('monthly'),
    channels: z.array(CHANNEL_ENUM).optional(),
    aiAssisted: z.boolean().optional(),
    customGoal: z.string().optional(),
  }).parse(req.body ?? {});
  const retainer = await slingAutomationService.createRetainer({
    userId: a.sub,
    ...body,
    cadence: body.cadence as RetainerCadence,
    channels: body.channels as NotificationChannel[] | undefined,
  });
  return { data: retainer };
});
app.patch('/v1/me/retainers/:id', async (req, reply) => {
  const a = authed(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const patch = z.object({
    status: z.enum(['active', 'paused', 'completed']).optional(),
    cadence: CADENCE_ENUM.optional(),
    channels: z.array(CHANNEL_ENUM).optional(),
  }).parse(req.body ?? {});
  const updated = await slingAutomationService.updateRetainer((req.params as { id: string }).id, a.sub, {
    status: patch.status,
    cadence: patch.cadence as RetainerCadence | undefined,
    channels: patch.channels as NotificationChannel[] | undefined,
  });
  if (!updated) return fail(reply, 'NOT_FOUND', 'Retainer not found', 404);
  return { data: updated };
});
app.post('/v1/me/retainers/:id/trigger-ai', async (req, reply) => {
  const a = authed(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const res = await slingAutomationService.triggerRetainerNow((req.params as { id: string }).id, a.sub);
  if (!res) return fail(reply, 'NOT_FOUND', 'Retainer not found', 404);
  return { data: res };
});

// AI-Assisted CTA Generator & Omnichannel Dispatch Surface
app.post('/v1/communications/ai-cta/generate', async (req) => {
  const body = z.object({
    goal: AI_GOAL_ENUM.default('retainer_maintenance'),
    customerName: z.string().optional(),
    city: z.string().optional(),
    serviceName: z.string().optional(),
    discountPct: z.number().optional(),
    cashbackNaira: z.number().optional(),
    lastServiceDaysAgo: z.number().optional(),
    customPrompt: z.string().optional(),
    deepLinkRoute: z.string().optional(),
    ctaUrl: z.string().optional(),
  }).parse(req.body ?? {});
  const variant = await aiCtaService.generateOmnichannelCta({
    ...body,
    goal: body.goal as AiCtaCampaignGoal,
  });
  return { data: variant };
});

app.post('/v1/communications/send', async (req) => {
  const body = z.object({
    recipientId: z.string(),
    channels: z.array(CHANNEL_ENUM).min(1),
    template: z.string().default('booking.confirmed'),
    vars: z.record(z.string(), z.string()).optional(),
    category: z.enum(['order', 'chat', 'maint', 'promo', 'cashback', 'tips', 'security']).optional(),
    msgType: z.enum(['transactional', 'promotional', 'otp']).optional(),
    ctaLabel: z.string().optional(),
    ctaUrl: z.string().optional(),
    route: z.string().optional(),
    aiAssisted: z.boolean().optional(),
  }).parse(req.body);
  const res = await notificationService.sendOmnichannel({
    ...body,
    channels: body.channels as NotificationChannel[],
  });
  return { data: res };
});

app.post('/v1/communications/automation/trigger', async (req) => {
  const body = z.object({
    triggerEvent: z.string(),
    recipientId: z.string(),
    vars: z.record(z.string(), z.string()).optional(),
    channels: z.array(CHANNEL_ENUM).optional(),
    aiGoal: AI_GOAL_ENUM.optional(),
    ctaLabel: z.string().optional(),
    ctaUrl: z.string().optional(),
    route: z.string().optional(),
  }).parse(req.body);
  const res = await slingAutomationService.triggerEvent(body.triggerEvent, body.recipientId, body.vars ?? {}, {
    channels: body.channels as NotificationChannel[] | undefined,
    aiGoal: body.aiGoal as AiCtaCampaignGoal | undefined,
    ctaLabel: body.ctaLabel,
    ctaUrl: body.ctaUrl,
    route: body.route,
  });
  return { data: res };
});

// Sling HLR Phone Carrier & RCS Capability Lookups + Message Status
app.post('/v1/communications/lookup/phone', async (req) => {
  const { phone } = z.object({ phone: z.string().min(7) }).parse(req.body);
  return { data: await slingClient.checkPhoneNumber(phone) };
});
app.post('/v1/communications/lookup/rcs', async (req) => {
  const { phone } = z.object({ phone: z.string().min(7) }).parse(req.body);
  return { data: await slingClient.checkRcsCapability(phone) };
});
app.get('/v1/communications/status/:messageId', async (req) => {
  return { data: await slingClient.getMessageStatus((req.params as { messageId: string }).messageId) };
});

// Admin Bulk Promotional, Operational Alert & AI CTA Campaigns + Sling Sync
app.get('/v1/admin/campaigns', async () => ({
  data: await slingAutomationService.listCampaigns(),
}));
app.post('/v1/admin/campaigns', async (req) => {
  const body = z.object({
    name: z.string().min(2),
    kind: z.enum(['bulk_promotional', 'comms_alert', 'ai_cta', 'retainer', 'automation']).default('bulk_promotional'),
    channels: z.array(CHANNEL_ENUM).default(['sms', 'whatsapp', 'push']),
    targetSegment: z.enum(['all_customers', 'all_providers', 'active_retainers', 'all_users', 'custom_numbers']).optional(),
    slingGroupId: z.string().optional(),
    customNumbers: z.array(z.string()).optional(),
    messageBody: z.string().optional(),
    subject: z.string().optional(),
    ctaLabel: z.string().optional(),
    ctaUrl: z.string().optional(),
    aiAssisted: z.boolean().optional(),
    aiGoal: AI_GOAL_ENUM.optional(),
    aiPrompt: z.string().optional(),
    serviceName: z.string().optional(),
    discountPct: z.number().optional(),
    scheduledAt: z.string().optional(),
    autoLaunch: z.boolean().optional(),
  }).parse(req.body);
  const a = authed(req as never);
  const created = await slingAutomationService.createCampaign({
    ...body,
    channels: body.channels as NotificationChannel[],
    aiGoal: body.aiGoal as AiCtaCampaignGoal | undefined,
    createdBy: a?.sub ?? 'admin',
  });
  return { data: created };
});
app.post('/v1/admin/campaigns/:id/launch', async (req, reply) => {
  const body = z.object({ customNumbers: z.array(z.string()).max(50_000).optional() }).safeParse(req.body ?? {});
  if (!body.success) return fail(reply, 'VALIDATION', 'customNumbers must be a list of phone numbers', 400);
  try {
    const launched = await slingAutomationService.launchCampaign((req.params as { id: string }).id, body.data.customNumbers);
    return { data: launched };
  } catch (e: unknown) {
    const code = (e as Error).message;
    if (code === 'CAMPAIGN_ALREADY_LAUNCHED') {
      return fail(reply, code, 'This campaign has already gone out. Only a failed campaign can be launched again, and then only what failed is re-sent.', 409);
    }
    if (code === 'CAMPAIGN_NOT_FOUND') return fail(reply, code, 'Campaign not found', 404);
    throw e;
  }
});
app.get('/v1/admin/sling/status', async () => {
  const [balance, groups, rules] = await Promise.all([
    slingClient.getBalance(),
    slingClient.listGroups(),
    slingAutomationService.listAutomationRules(),
  ]);
  return {
    data: {
      configured: slingClient.isConfigured(),
      aiConfigured: aiCtaService.isLiveAiConfigured(),
      senders: slingClient.senders,
      balance,
      groups: groups.groups,
      automationRules: rules,
    },
  };
});
app.post('/v1/admin/sling/contacts/sync', async () => ({
  data: await slingAutomationService.syncAudienceGroupsToSling(),
}));

// Sling Delivery Receipt Webhook Callback (POST /webhooks/sling)
// Sling receipts are authenticated with SLING_WEBHOOK_SECRET: either an HMAC-SHA256
// hex digest of the raw body (x-sling-signature) or the shared secret itself
// (x-webhook-secret / ?token=) for dashboards that only support a static token.
// Production fails closed when the secret is unset.
function slingWebhookAuthentic(raw: string, headers: Record<string, string | string[] | undefined>, token?: string): boolean {
  const secret = appConfig.SLING_WEBHOOK_SECRET;
  if (!secret) return !PROD;
  const same = (a: string, b: string) => {
    const x = Buffer.from(a); const y = Buffer.from(b);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };
  const sig = String(headers['x-sling-signature'] ?? '').replace(/^sha256=/, '');
  if (sig) return same(sig, crypto.createHmac('sha256', secret).update(raw).digest('hex'));
  const shared = String(headers['x-webhook-secret'] ?? token ?? '');
  return !!shared && same(shared, secret);
}
app.post('/webhooks/sling', { config: { rawBody: true } }, async (req, reply) => {
  const raw = (req as unknown as { rawBody?: string }).rawBody || JSON.stringify(req.body ?? {});
  if (!slingWebhookAuthentic(raw, req.headers, (req.query as { token?: string }).token)) {
    return fail(reply, 'BAD_SIGNATURE', 'Invalid webhook signature', 401);
  }
  const payload = (req.body ?? {}) as Record<string, unknown>;
  const result = await slingAutomationService.handleSlingWebhook(payload);
  observability.track('sling.webhook.delivery', {
    status: result.status,
    reference: result.reference,
    messageId: result.messageId,
  });
  return { data: result };
});
app.post('/v1/media/presign', async (req, reply) => {
  // Session-scoped: presign mints an upload slot + storage URL. Was public.
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const { kind } = z.object({ kind: z.enum(['avatar', 'photo', 'video', 'doc']) }).parse(req.body);
  return { data: await mediaService.presign(kind, a.sub) };
});
// Multipart direct upload (self-hosted path, ADR-001): auth -> validate ->
// quarantine -> promote. Poor-network clients keep using presign + base64 ingest.
app.post('/v1/media/upload', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  try {
    const file = await req.file();
    if (!file) return fail(reply, 'NO_FILE', 'Attach a single file field.');
    const kindRaw = (file.fields as Record<string, { value?: string } | undefined> | undefined)?.kind?.value ?? 'photo';
    const kind = kindRaw === 'avatar' || kindRaw === 'video' || kindRaw === 'doc' ? kindRaw : 'photo';
    const { assetId } = await mediaService.presign(kind, a.sub);
    const bytes = await file.toBuffer();
    const done = await mediaService.ingest(assetId, bytes, file.mimetype);
    if (done.status !== 'clean') return fail(reply, 'FILE_REJECTED', 'File type or size not allowed.');
    return { data: done };
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg === 'STORAGE_PAUSED') return fail(reply, 'STORAGE_PAUSED', 'Object storage paused.', 503, true);
    if (msg === 'FTP_NOT_CONFIGURED') return fail(reply, 'STORAGE_UNCONFIGURED', 'FTP storage is not configured.', 503, true);
    return fail(reply, 'UPLOAD_FAILED', msg);
  }
});

// ---------- payouts / disputes / warranty / reviews ----------
// Bank reference + account resolution for provider payout onboarding.
// The list is public reference data (cached for 24h; stale beats broken);
// name resolution requires a session so the PSP endpoint stays off the open web.
let banksCache: { at: number; banks: { name: string; code: string }[] } | null = null;
app.get('/v1/banks', async (req, reply) => {
  const country = String((req.query as { country?: string }).country ?? 'NG').toUpperCase().slice(0, 2);
  if (banksCache && banksCache.at > Date.now() - 24 * 60 * 60 * 1000) return { data: banksCache.banks };
  try {
    const banks = await payments.listBanks(country);
    if (banks.length > 0) banksCache = { at: Date.now(), banks };
    return { data: banks };
  } catch (e: unknown) {
    if (banksCache) return { data: banksCache.banks };
    return fail(reply, 'BANKS_UNAVAILABLE', (e as Error).message, 502);
  }
});
app.post('/v1/payouts/resolve-account', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const { accountNumber, bankCode, businessName } = z.object({
    accountNumber: z.string().regex(/^\d{10}$/, 'Account number must be 10 digits'),
    bankCode: z.string().min(1),
    businessName: z.string().optional(),
  }).parse(req.body);
  const userProfile = await identityService.me(a.sub).catch(() => null);
  const provProfile = await providerService.byUserId(a.sub).catch(() => null);

  let lookupDown = false;
  let r = await payments.verifyBankAccount(accountNumber, bankCode).catch((e: unknown) => {
    if ((e as { code?: string }).code === 'INSUFFICIENT_BALANCE') {
      lookupDown = true;
      observability.captureException(e); // ops: fund the Paga business wallet
      app.log.error({ code: 'PAGA_BUSINESS_BALANCE_LOW' }, 'account name lookup blocked: Paga business balance too low');
    }
    return { valid: false, accountName: undefined };
  });
  if (lookupDown) return fail(reply, 'NAME_CHECK_UNAVAILABLE', "We can't confirm account names right now. Please try again in a few minutes.", 503, true);
  // Sandbox-only: invent a name so the onboarding flow can be demoed without a
  // live PSP. NEVER in production — a made-up name always "aligns" with the
  // vendor's own profile, which would let any account receive payouts.
  let sandboxResolved = false;
  if (!r.valid || !r.accountName) {
    if (!PROD && !accountNumber.startsWith('0000')) {
      sandboxResolved = true;
      const fallbackName = (
        provProfile?.verifiedLegalName ||
        userProfile?.name ||
        businessName ||
        provProfile?.businessName ||
        'Kendibo VERIFIED VENDOR'
      ).toUpperCase();
      r = { valid: true, accountName: fallbackName };
    }
  }
  if (!r.valid || !r.accountName) return fail(reply, 'ACCOUNT_UNRESOLVED', 'Account number not recognised for this bank', 422);

  const alignment = kycService.verifyNameAlignment({
    submittedName: userProfile?.name ?? undefined,
    businessName: businessName ?? provProfile?.businessName ?? undefined,
    ninLegalName: provProfile?.verifiedLegalName ?? undefined,
    cacCompanyName: provProfile?.cacCompanyName ?? undefined,
    bankAccountName: r.accountName,
  });

  return { data: { accountName: r.accountName, valid: true, alignment, sandbox: sandboxResolved } };
});

// Prembly Name Alignment Check & Prembly MCP Server Endpoints (docs.prembly.com)
app.post('/v1/kyc/check-alignment', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const body = z.object({
    submittedName: z.string().optional(),
    businessName: z.string().optional(),
    ninLegalName: z.string().optional(),
    bvnLegalName: z.string().optional(),
    cacCompanyName: z.string().optional(),
    bankAccountName: z.string().optional(),
  }).parse(req.body ?? {});
  const userProfile = await identityService.me(a.sub).catch(() => null);
  const provProfile = await providerService.byUserId(a.sub).catch(() => null);
  const alignment = kycService.verifyNameAlignment({
    submittedName: body.submittedName ?? userProfile?.name ?? undefined,
    businessName: body.businessName ?? provProfile?.businessName ?? undefined,
    ninLegalName: body.ninLegalName ?? provProfile?.verifiedLegalName ?? undefined,
    bvnLegalName: body.bvnLegalName ?? undefined,
    cacCompanyName: body.cacCompanyName ?? provProfile?.cacCompanyName ?? undefined,
    bankAccountName: body.bankAccountName ?? provProfile?.accountName ?? undefined,
  });
  return { data: alignment };
});
app.get('/v1/admin/prembly/mcp-tools', async () => ({
  data: kycService.getMcpToolsManifest(),
}));
app.post('/v1/admin/prembly/mcp-execute', async (req, reply) => {
  const { tool, arguments: args } = z.object({
    tool: z.string(),
    arguments: z.record(z.string(), z.unknown()).default({}),
  }).parse(req.body ?? {});
  try {
    return { data: await kycService.executeMcpTool(tool, args) };
  } catch (e: unknown) {
    return fail(reply, 'PREMBLY_MCP_ERROR', (e as Error).message, 400);
  }
});
app.post('/v1/payouts', async (req, reply) => {
  // payout:approve enforced by ROUTE_POLICY against the caller's DB role.
  const { providerId, amountKobo, reference } = z.object({ providerId: z.string(), amountKobo: z.string().regex(/^\d+$/), reference: z.string() }).parse(req.body);
  const a = authed(req as never);
  // Never pay out more than earned − already paid − outstanding fees.
  const bal = await vendorFinanceService.balance(providerId);
  if (BigInt(amountKobo) <= 0n || BigInt(amountKobo) > BigInt(bal.availableKobo)) {
    return fail(reply, 'PAYOUT_EXCEEDS_BALANCE', `Available to pay out: ${bal.availableKobo} kobo`, 409);
  }
  try {
    const payout = await payoutService.create(providerId, BigInt(amountKobo), reference);
    await vendorFinanceService.recoverFees(providerId, payout.reference);
    if (a) await auditService.log(a.sub, 'payout.create', `${providerId}:${reference}:${amountKobo}`);
    return { data: payout };
  } catch (e: unknown) { return fail(reply, 'PAYOUT_BLOCKED', (e as Error).message, 409); }
});
app.post('/v1/disputes', async (req, reply) => {
  try {
    const { bookingId, reason, description } = z.object({ bookingId: z.string(), raisedBy: z.enum(['customer', 'provider']).optional(), reason: z.string().max(200), description: z.string().max(4000).optional() }).parse(req.body);
    const party = await bookingParty(req as never, reply, bookingId); if (!party) return reply;
    if (party.as === 'admin') return fail(reply, 'FORBIDDEN', 'Disputes are raised by the customer or provider', 403);
    return { data: await disputeService.open(bookingId, party.as, reason, description) };
  } catch (e: unknown) { return fail(reply, 'BAD_DISPUTE', (e as Error).message); }
});
app.post('/v1/warranties', async (req) => {
  const { bookingId, days } = z.object({ bookingId: z.string(), days: z.number().int().min(1).max(365) }).parse(req.body);
  return { data: await fullWarranty.activate(bookingId, days) };
});
app.post('/v1/reviews', async (req, reply) => {
  const parsed = z.object({ bookingId: z.string(), rating: z.number().int().min(1).max(5), tags: z.array(z.string().max(40)).max(10), comment: z.string().max(2000).optional() }).safeParse(req.body);
  if (!parsed.success) return fail(reply, 'BAD_RATING', 'Rating 1-5 required');
  const { bookingId, rating, tags, comment } = parsed.data;
  const party = await bookingParty(req as never, reply, bookingId); if (!party) return reply;
  if (party.as === 'admin') return fail(reply, 'FORBIDDEN', 'Reviews come from the customer or the provider', 403);
  // The pro rates the customer (held until the customer rates too).
  if (party.as === 'provider') {
    await rateParty(bookingId, 'provider', party.sub, rating, comment);
    return { data: { bookingId, rating, visibleToCustomer: false } };
  }
  try {
    const out = await reviewService.add(bookingId, { provider: rating, quality: rating, punctuality: rating, professionalism: rating, result: rating }, tags, comment);
    await rateParty(bookingId, 'customer', party.sub, rating, comment);
    return { data: out };
  } catch (e: unknown) { return fail(reply, 'BAD_REVIEW', (e as Error).message, 409); }
});

// ---------- admin (audited) ----------
app.get('/v1/admin/dispatch/live', async (req, reply) => {
  const a = await adminActor(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  if ('denied' in a || !adminCan(a.role, 'booking:view:any')) return fail(reply, 'FORBIDDEN', 'Operations access required', 403);
  await auditService.log(a.sub, 'dispatch.live.view');
  const online = await providerService.allOnline();
  return { data: { online: online.length } };
});

// ================= PRD APPENDIX C SURFACE =================
// ---- USER APP: me/properties ----
app.patch('/v1/me', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  try {
    const patch = z.object({
      name: z.string().optional(), nickname: z.string().optional(),
      dob: z.string().optional(), avatarUrl: z.string().optional(),
    }).parse(req.body);
    return { data: await identityService.updateProfile(a.sub, patch) };
  } catch (e: unknown) { return fail(reply, 'BAD_PROFILE', (e as Error).message); }
});
// Link a phone number to the signed-in account (code sent to it first), so the
// owner can sign in with that number too.
const phoneLinkError = (reply: FastifyReply, e: unknown) => {
  const m = (e as Error).message;
  if (e instanceof z.ZodError || m === 'BAD_IDENTITY') return fail(reply, 'BAD_IDENTITY', 'Enter a valid phone number.', 400);
  if (m === 'PHONE_IN_USE') return fail(reply, 'PHONE_IN_USE', 'This phone number is already on another Kendibo account.', 409);
  if (m === 'BAD_OTP') return fail(reply, 'BAD_OTP', 'Invalid or expired code', 400);
  if (m === 'SEND_FAILED') return fail(reply, 'SEND_FAILED', 'Could not deliver the code. Try again.', 502, true);
  throw e;
};
app.post('/v1/me/phone/request', OTP_LIMIT, async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  try {
    const { phone } = z.object({ phone: z.string().min(7).max(20) }).parse(req.body);
    const r = await identityService.requestPhoneLink(a.sub, phone);
    return { data: { sent: true, phone: r.phone, devCode: r.devCode } };
  } catch (e) { return phoneLinkError(reply, e); }
});
app.post('/v1/me/phone/verify', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  try {
    const { phone, code } = z.object({ phone: z.string().min(7).max(20), code: z.string().min(4).max(8) }).parse(req.body);
    return { data: await identityService.confirmPhoneLink(a.sub, phone, code) };
  } catch (e) { return phoneLinkError(reply, e); }
});
// Account deletion (NDPA s.34; Google Play): erases personal details. Refused
// while a job is still open or money is in the wallet, so nobody loses either.
app.delete('/v1/me', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  // Customer bookings, plus jobs assigned to this user as a provider.
  if (await identityService.hasOpenBookings(a.sub)) return fail(reply, 'OPEN_BOOKINGS', 'Finish or cancel your open bookings before deleting your account.', 409);
  const balance = await walletService.getBalance(a.sub).catch(() => 0);
  if (balance > 0) return fail(reply, 'WALLET_NOT_EMPTY', 'Withdraw or use your wallet balance before deleting your account. Contact support if you need help.', 409);
  return { data: await identityService.eraseAccount(a.sub) };
});
// NDPA s.34(1)(b) / s.38: a machine-readable copy of the user's data.
app.get('/v1/me/export', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  void reply.header('Content-Disposition', 'attachment; filename="kendibo-my-data.json"');
  return { data: await identityService.exportData(a.sub) };
});
// Public page Google Play links to: how to delete an account without the app installed.
app.get('/w/delete-account', async (_req, reply) => {
  const support = process.env.SUPPORT_EMAIL || 'support@kendibo.com';
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Delete your Kendibo account</title><style>body{font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0F172A;max-width:640px;margin:0 auto;padding:24px}h1{font-size:24px}li{margin:6px 0}.note{color:#475569;font-size:14px}a{color:#1D5BD6}</style></head><body>
<h1>Delete your Kendibo account</h1>
<h2>In the app</h2><ol><li>Open Kendibo and go to <b>Profile</b>, then <b>Settings</b>.</li><li>Tap <b>Manage account</b>, then <b>Delete account</b>.</li><li>Confirm. You are signed out everywhere.</li></ol>
<h2>Without the app</h2><p>Email <a href="mailto:${support}?subject=Delete%20my%20Kendibo%20account">${support}</a> from the email on your account, or include the phone number you signed up with. We confirm before deleting.</p>
<h2>What is deleted</h2><p>Your name, email, phone number, photo, saved addresses, linked Google or Facebook sign-in, PIN and devices.</p>
<h2>What we keep, and why</h2><p>Records of bookings, payments and identity checks are kept for as long as Nigerian law requires (tax, anti-fraud and consumer-protection rules), linked only to an anonymous id. Open bookings must be finished or cancelled, and any wallet balance withdrawn, before deletion.</p>
<p class="note">Kendibo processes personal data under the Nigeria Data Protection Act 2023. You can also ask for a copy of your data or complain to the Nigeria Data Protection Commission.</p>
</body></html>`;
  return reply.header('Cache-Control', 'public, max-age=3600').type('text/html; charset=utf-8').send(page);
});
app.get('/v1/me/properties', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  return { data: await propertyService.listAddresses(a.sub) };
});
app.get('/v1/services/:id/availability', async (req) => ({ data: { slots: ['10:00-11:00', '13:00-14:00'], serviceId: (req.params as { id: string }).id } }));
// ---- USER APP: reschedule / confirm / failed (PRD §20/27) ----
app.post('/v1/bookings/:id/reschedule', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const { from, to } = z.object({ from: z.string(), to: z.string() }).parse(req.body);
  const list = await reschedule((req.params as { id: string }).id, from, to, a.sub);
  observability.track('booking.rescheduled', analyticProps({ bookingId: (req.params as { id: string }).id }));
  return { data: list };
});
app.get('/v1/bookings/:id/reschedules', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!(await bookingParty(req as never, reply, id))) return reply;
  return { data: await rescheduleHistory(id) };
});
app.post('/v1/bookings/:id/confirm', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const party = await bookingParty(req as never, reply, id); if (!party) return reply;
  if (party.as !== 'customer') return fail(reply, 'FORBIDDEN', 'Only the customer can confirm this booking', 403);
  try {
    const updated = await bookingService.setStatus(id, 'CONFIRMED', 'customer');
    if (updated?.userId) {
      void slingAutomationService.triggerEvent('booking.confirmed', updated.userId, {
        id: updated.id,
        service: updated.serviceId,
        slot: updated.scheduledAt || 'scheduled window',
      }).catch(() => {});
    }
    return { data: updated };
  }
  catch (e: unknown) { return fail(reply, 'ILLEGAL_TRANSITION', (e as Error).message, 409); }
});
app.post('/v1/bookings/:id/fail', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const party = await bookingParty(req as never, reply, id); if (!party) return reply;
  const { code } = z.object({ code: z.string() }).parse(req.body);
  return { data: await markFailed(id, code as never, party.sub) };
});
app.get('/v1/bookings/:id/cancel-quote', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!(await bookingParty(req as never, reply, id))) return reply;
  const b = await bookingService.get(id);
  if (!b) return fail(reply, 'NOT_FOUND', 'Booking not found', 404);
  return { data: await evaluateCancellationLive(b.status) };
});
// ---- USER APP: quote-requests + approve/reject + change orders (PRD §23-25) ----
app.post('/v1/quote-requests', async (req, reply) => {
  const { bookingId, issueSummary, attachments } = z.object({ bookingId: z.string(), issueSummary: z.string().max(4000), attachments: z.array(z.string()).max(10).optional() }).parse(req.body);
  const party = await bookingParty(req as never, reply, bookingId); if (!party) return reply;
  if (party.as !== 'customer') return fail(reply, 'FORBIDDEN', 'Only the customer can request a quote', 403);
  const q = await quoteService.propose(bookingId, { issueSummary, attachments });
  try { await bookingService.setStatus(bookingId, 'QUOTE_PENDING', 'customer'); } catch { /* already there */ }
  return { data: q };
});
app.get('/v1/quotes/:bookingId', async (req, reply) => {
  const bookingId = (req.params as { bookingId: string }).bookingId;
  if (!(await bookingParty(req as never, reply, bookingId))) return reply;
  return { data: await quoteService.revisions(bookingId) };
});
app.post('/v1/quotes/:bookingId/approve', async (req, reply) => {
  const party = await bookingParty(req as never, reply, (req.params as { bookingId: string }).bookingId); if (!party) return reply;
  if (party.as !== 'customer') return fail(reply, 'FORBIDDEN', 'Only the customer can approve a quote', 403);
  try {
    const bookingId = (req.params as { bookingId: string }).bookingId;
    const { version } = z.object({ version: z.number() }).parse(req.body);
    const q = await quoteService.accept(bookingId, version);
    observability.track('quote.approved', analyticProps({ bookingId }));
    const b = await bookingService.get(bookingId).catch(() => null);
    if (b?.userId) {
      void slingAutomationService.triggerEvent('quote.approved', b.userId, { jobId: bookingId }).catch(() => {});
    }
    return { data: q };
  } catch (e: unknown) { return fail(reply, 'QUOTE_GONE', (e as Error).message, 409); }
});
app.post('/v1/quotes/:bookingId/change-orders', async (req, reply) => {
  const bookingId = (req.params as { bookingId: string }).bookingId;
  const party = await bookingParty(req as never, reply, bookingId); if (!party) return reply;
  if (party.as !== 'provider') return fail(reply, 'FORBIDDEN', 'Only the assigned provider can raise a change order', 403);
  const { quoteId, reason, amountKobo, evidence } = z.object({ quoteId: z.string(), reason: z.string().max(2000), amountKobo: z.string().regex(/^\d+$/), evidence: z.array(z.string()).max(10).optional() }).parse(req.body);
  return { data: await quoteService.requestChange(bookingId, quoteId, reason, BigInt(amountKobo), evidence) };
});
app.post('/v1/change-orders/:id/approve', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const rows = await q<{ job_id: string }>(`SELECT job_id FROM booking.change_order WHERE id=$1`, [id]);
  if (!rows[0]) return fail(reply, 'NOT_FOUND', 'Change order not found', 404);
  const party = await bookingParty(req as never, reply, String(rows[0].job_id)); if (!party) return reply;
  if (party.as !== 'customer') return fail(reply, 'FORBIDDEN', 'Only the customer can decide a change order', 403);
  const { approve } = z.object({ approve: z.boolean(), approver: z.string().optional() }).parse(req.body);
  return { data: await quoteService.decideChange(id, approve, party.sub) };
});
// A payment row belongs to the booking's customer; wallet top-ups (wt_<userId>_…)
// to the user that minted them. Admins with payment:view may read any.
async function paymentVisible(p: Record<string, unknown>, sub: string): Promise<boolean> {
  if (p.user_id && String(p.user_id) === sub) return true; // owner stored on our row at checkout time
  if (String(p.reference).startsWith(`wt_${sub}_`)) return true; // rows from before owners were stored
  // Tier upgrade fee / Kendibo Pro checkouts live in payment.payment with no booking: they belong to the provider's user.
  if (/^(tier_|sub_)/.test(String(p.reference)) && (await tierService.checkoutOwner(String(p.reference))) === sub) return true;
  const b = p.booking_id ? await bookingService.getRaw(String(p.booking_id)) : null;
  if (b?.userId === sub) return true;
  const rows = await q<{ role: string }>(`SELECT role FROM identity.users WHERE id=$1`, [sub]);
  return adminCan(rows[0]?.role, 'payment:view');
}
app.get('/v1/payments/:reference', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  // The return page may carry the checkout id instead of our reference.
  const key = (req.params as { reference: string }).reference;
  const rows = await q<Record<string, unknown>>(`SELECT * FROM payment.payment WHERE reference=$1 OR charge_id=$1 LIMIT 1`, [key]);
  const p = rows[0];
  if (!p || !(await paymentVisible(p, a.sub))) return fail(reply, 'NOT_FOUND', 'Payment not found', 404);
  // Webhook late or missing: ask Paga directly so the app never waits forever.
  let status = String(p.status);
  let received = String(p.received_kobo ?? 0);
  if (String(p.psp) === 'paga' && (status === 'pending' || status === 'partial')) {
    status = (await syncPendingPayment(String(p.reference))) ?? status;
    const again = await q<{ received_kobo: string }>(`SELECT received_kobo FROM payment.payment WHERE reference=$1`, [String(p.reference)]).catch(() => []);
    received = String(again[0]?.received_kobo ?? received);
  }
  return { data: { reference: String(p.reference), psp: String(p.psp), purpose: String(p.purpose ?? 'booking'), amountKobo: String(p.amount_kobo), receivedKobo: received, currency: 'NGN', status } };
});
app.post('/v1/payments/:reference/verify', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const ref = (req.params as { reference: string }).reference;
  const rows = await q<Record<string, unknown>>(`SELECT * FROM payment.payment WHERE reference=$1`, [ref]);
  const p = rows[0];
  if (!p || !(await paymentVisible(p, a.sub))) return fail(reply, 'NOT_FOUND', 'Payment not found', 404);
  try {
    const v = await payments.verify(String(p.psp), String(p.charge_id || ref));
    const settled = await settlement.settle(ref); // same rule as the webhook and the reconciler
    const after = (await q<{ received_kobo: string }>(`SELECT received_kobo FROM payment.payment WHERE reference=$1`, [ref]).catch(() => []))[0];
    return { data: { ...v, amountKobo: String(v.amountKobo), receivedKobo: String(after?.received_kobo ?? 0), status: settled.status === 'busy' ? String(p.status) : settled.status } };
  } catch (e: unknown) { return fail(reply, 'VERIFY_FAILED', (e as Error).message, 502, true); }
});
app.post('/v1/payments/:reference/refund', async (req, reply) => {
  const a = authed(req as never);
  if (!a || !authorize('FINANCE', 'payment:refund')) return fail(reply, 'FORBIDDEN', 'Finance required', 403);
  const ref = (req.params as { reference: string }).reference;
  const { amountKobo, reason } = z.object({ amountKobo: z.string().optional(), reason: z.string().optional() }).parse(req.body ?? {});
  try {
    const r = await payments.refund(ref, amountKobo ? BigInt(amountKobo) : undefined, reason);
    auditService.log(a.sub, `payment.${ref}.refund`);
    return { data: r };
  } catch (e: unknown) { return fail(reply, 'REFUND_FAILED', (e as Error).message, 502, true); }
});
app.get('/v1/geo/geocode', async (req) => {
  const query = req.query as { q?: string; city?: string };
  if (!query.q) return { error: { code: 'BAD_REQUEST', message: 'q required', retryable: false } };
  return { data: await maps.geocode(query.q, query.city) };
});
app.get('/v1/geo/reverse-geocode', async (req) => {
  const query = req.query as { lat?: string; lng?: string };
  return { data: await maps.reverse(Number(query.lat), Number(query.lng)) };
});
app.get('/v1/provider/kyc/status', async (req, reply) => {
  // Session-scoped: providers read their own status. A client-supplied
  // providerId used to make this endpoint an unauthenticated PII/status
  // oracle — removed (admin detail lives behind /v1/admin/providers/:id).
  const a = authed(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const me = await providerService.byUserId(a.sub);
  if (!me) return fail(reply, 'NOT_FOUND', 'Provider profile not found', 404);
  return { data: { ...(await kycService.status(me.id)), providerId: me.id, provider: selectKycAdapter().name } };
});
// ---- ON-DEMAND service requests (Bolt-style broadcast + accept) ----
app.post('/v1/service-requests', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const idem = req.headers['idempotency-key'];
  if (typeof idem !== 'string') return fail(reply, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key header required');
  const body = z.object({
    serviceId: z.string().optional(), categoryId: z.string().optional(),
    title: z.string(), details: z.string().optional(),
    urgency: z.enum(['emergency', 'today', 'this_week']).optional(),
    addressId: z.string().optional(), lat: z.number().optional(), lng: z.number().optional(),
    contactName: z.string().optional(), contactPhone: z.string().optional(), contactEmail: z.string().optional(),
    notes: z.string().optional(), smsUpdates: z.boolean().optional(),
    scheduledDate: z.string().optional(), timeWindow: z.string().optional(),
    // From a pro's profile: that pro gets first refusal (eligibility still checked in matching).
    preferredProviderId: z.string().uuid().optional(),
  }).parse(req.body);
  return { data: await requestService.create(a.sub, { ...body, idempotencyKey: idem }) };
});
app.get('/v1/service-requests', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  return { data: await requestService.list(a.sub) };
});
app.get('/v1/service-requests/:id', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  try { return { data: await requestService.get((req.params as { id: string }).id, a.sub) }; }
  catch { return fail(reply, 'FORBIDDEN', 'Not your request', 403); }
});
app.get('/v1/service-requests/:id/matches', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const id = (req.params as { id: string }).id;
  try {
    const r = await requestService.get(id, a.sub);
    if (!r) return fail(reply, 'NOT_FOUND', 'Request not found', 404);
    return { data: await requestService.matches(id) };
  } catch { return fail(reply, 'FORBIDDEN', 'Not your request', 403); }
});
app.post('/v1/service-requests/:id/broadcast', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const id = (req.params as { id: string }).id;
  // Owner check only: any authenticated user may broadcast their own request.
  try {
    const r = await requestService.get(id, a.sub);
    if (!r) return fail(reply, 'NOT_FOUND', 'Request not found', 404);
  } catch { return fail(reply, 'FORBIDDEN', 'Not your request', 403); }
  const { limit } = z.object({ limit: z.number().optional() }).parse(req.body ?? {});
  auditService.log(a.sub, `request.${id}.broadcast`);
  return { data: await requestService.broadcast(id, limit ?? 5) };
});
app.post('/v1/service-requests/:id/cancel', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  try { return { data: await requestService.cancel((req.params as { id: string }).id, a.sub) }; }
  catch { return fail(reply, 'CANCEL_BLOCKED', 'Request can no longer be cancelled', 409); }
});
app.post('/v1/service-requests/:id/convert', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  try { return { data: await requestService.convert((req.params as { id: string }).id, a.sub) }; }
  catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg === 'FORBIDDEN') return fail(reply, 'FORBIDDEN', 'Not your request', 403);
    return fail(reply, 'CONVERT_BLOCKED', msg, 409);
  }
});
// A ?providerId= query param is accepted for older clients but ignored: these
// always return the signed-in vendor's own queue.
app.get('/v1/provider/requests', async (req, reply) => {
  const me = await providerActor(req as never, reply); if (!me) return reply;
  return { data: await requestService.incoming(me.id) };
});
app.get('/v1/provider/bookings', async (req, reply) => {
  const me = await providerActor(req as never, reply); if (!me) return reply;
  return { data: await bookingService.listForProvider(me.id) };
});
// Customer names their price for a request (inDrive-style; at least the minimum).
app.post('/v1/service-requests/:id/propose-price', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const { amountKobo } = z.object({ amountKobo: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]) }).parse(req.body);
  try { return { data: await requestService.proposePrice((req.params as { id: string }).id, a.sub, BigInt(amountKobo)) }; }
  catch (e: unknown) {
    const m = (e as Error).message;
    if (m.startsWith('BELOW_MINIMUM')) return fail(reply, 'BELOW_MINIMUM', `The lowest price you can offer is ₦${(Number(m.split(':')[1]) / 100).toLocaleString('en-NG')}.`, 400);
    return fail(reply, 'REQUEST_CLOSED', 'This request is no longer open for price changes.', 409);
  }
});
// The offers on a customer's request, with any counter-price a pro sent.
app.get('/v1/service-requests/:id/offers', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const id = (req.params as { id: string }).id;
  const own = await q(`SELECT 1 FROM booking.service_request WHERE id=$1 AND user_id=$2`, [id, a.sub]);
  if (!own[0]) return fail(reply, 'NOT_FOUND', 'Request not found', 404);
  const rows = await q<Record<string, unknown>>(
    `SELECT o.id, o.status, o.counter_kobo, o.eta_minutes, p.business_name, p.rating FROM booking.request_offer o
       JOIN provider.provider p ON p.id=o.provider_id WHERE o.request_id=$1`, [id],
  );
  return { data: rows.map((r) => ({ id: String(r.id), status: String(r.status), counterKobo: r.counter_kobo != null ? String(r.counter_kobo) : null, etaMinutes: r.eta_minutes ?? null, provider: { name: String(r.business_name ?? 'Verified pro'), rating: r.rating ?? null } })) };
});
app.post('/v1/service-requests/:id/offers/:offerId/accept-counter', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const { id, offerId } = req.params as { id: string; offerId: string };
  try {
    const result = (await requestService.acceptCounter(id, offerId, a.sub)) as Record<string, unknown>;
    if (result.bookingId) {
      await bookingService.setStatus(String(result.bookingId), 'MATCHING', 'system').catch((e) => observability.captureException(e));
      await advanceBookingAfterAccept(String(result.bookingId));
    }
    return { data: result };
  } catch { return fail(reply, 'COUNTER_GONE', 'That price is no longer available.', 409); }
});
app.post('/v1/service-requests/:id/offers/:offerId/decline-counter', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const { id, offerId } = req.params as { id: string; offerId: string };
  try { return { data: await requestService.declineCounter(id, offerId, a.sub) }; }
  catch { return fail(reply, 'COUNTER_GONE', 'That price is no longer available.', 409); }
});
app.post('/v1/provider/requests/:id/respond', async (req, reply) => {
  const { accept, counterKobo } = z.object({ accept: z.boolean().optional(), counterKobo: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).optional() }).parse(req.body);
  const me = await providerActor(req as never, reply); if (!me) return reply;
  const offerId = (req.params as { id: string }).id;
  const offer = await q<{ provider_id: string; category_id: string | null }>(
    `SELECT o.provider_id, r.category_id FROM booking.request_offer o JOIN booking.service_request r ON r.id=o.request_id WHERE o.id=$1`, [offerId],
  );
  if (!offer[0] || String(offer[0].provider_id) !== me.id) return fail(reply, 'NOT_FOUND', 'Offer not found', 404);
  // Re-check the category rules at the moment of acceptance (or counter): KYC can
  // lapse, a licence can expire, or the vendor can hit their concurrent-job cap.
  // A counter-price must also fit the pro's per-job tier cap.
  const counterCtx = counterKobo !== undefined ? { amountKobo: BigInt(counterKobo) } : {};
  if ((accept || counterKobo !== undefined) && !(await vendorEligibilityService.allowed(me.id, offer[0].category_id, counterCtx))) {
    const why = await vendorEligibilityService.evaluate(me.id, String(offer[0].category_id ?? ''), counterCtx).catch(() => null);
    return fail(reply, 'NOT_ELIGIBLE', `Complete these first: ${(why?.missing ?? ['verification']).join(', ')}`, 403);
  }
  // One counter-price per offer; the customer then accepts or declines it.
  if (counterKobo !== undefined) {
    try { return { data: await requestService.counterOffer(offerId, me.id, BigInt(counterKobo)) }; }
    catch (e: unknown) {
      const m = (e as Error).message;
      if (m.startsWith('BELOW_MINIMUM')) return fail(reply, 'BELOW_MINIMUM', `The lowest price is ₦${(Number(m.split(':')[1]) / 100).toLocaleString('en-NG')}.`, 400);
      return fail(reply, 'OFFER_GONE', 'You can send one price per job, while the offer is open.', 409);
    }
  }
  if (accept === undefined) return fail(reply, 'BAD_REQUEST', 'Send accept (true/false) or a counterKobo price.', 400);
  const acceptCtx = accept
    ? { accepting: true, ref: offerId, amountKobo: await tierService.jobAmountKobo({ requestOfferId: offerId }).catch(() => null) }
    : {};
  if (accept && !(await vendorEligibilityService.allowed(me.id, offer[0].category_id, acceptCtx))) {
    const why = await vendorEligibilityService.evaluate(me.id, String(offer[0].category_id ?? ''), acceptCtx).catch(() => null);
    return fail(reply, 'NOT_ELIGIBLE', `Complete these first: ${(why?.missing ?? ['verification']).join(', ')}`, 403);
  }
  try {
    const result = (await requestService.respondOffer(offerId, accept)) as Record<string, unknown>;
    // On accept the service links a booking; advance it so tracking/candidate
    // logic reflects the winning provider (REQUESTED -> MATCHING -> ... -> ACCEPTED).
    if (accept && result.bookingId) {
      const bookingId = String(result.bookingId);
      await bookingService.setStatus(bookingId, 'MATCHING', 'system').catch((e) => observability.captureException(e));
      await advanceBookingAfterAccept(bookingId);
    }
    return { data: result };
  }
  catch (e: unknown) { return fail(reply, 'OFFER_GONE', (e as Error).message, 409); }
});
// ---- USER APP: warranty claims + property history/reminders/recurring ----
app.get('/v1/jobs/:id/warranty', async (req, reply) => {
  const w = await fullWarranty.getWarranty((req.params as { id: string }).id);
  if (!w) return { data: null };
  if (!(await bookingParty(req as never, reply, w.bookingId))) return reply;
  return { data: w };
});
app.post('/v1/warranties/:id/claims', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const w = await fullWarranty.getWarranty(id);
  if (!w) return fail(reply, 'WARRANTY_GONE', 'Warranty not found', 404);
  const party = await bookingParty(req as never, reply, w.bookingId); if (!party) return reply;
  if (party.as !== 'customer') return fail(reply, 'FORBIDDEN', 'Only the customer can claim this warranty', 403);
  try {
    const { reason, description, evidence } = z.object({ reason: z.string().max(200), description: z.string().max(4000), evidence: z.array(z.string()).max(10).optional() }).parse(req.body);
    return { data: await fullWarranty.claim(id, reason, description, evidence) };
  } catch (e: unknown) { return fail(reply, 'WARRANTY_GONE', (e as Error).message, 409); }
});
app.get('/v1/warranty-claims/:id', async (req, reply) => {
  const c = await fullWarranty.getClaim((req.params as { id: string }).id);
  if (!c) return fail(reply, 'NOT_FOUND', 'Claim not found', 404);
  const w = await fullWarranty.getWarranty(c.warrantyId);
  if (!w || !(await bookingParty(req as never, reply, w.bookingId))) return reply.sent ? reply : fail(reply, 'NOT_FOUND', 'Claim not found', 404);
  return { data: c };
});
// Property-scoped reads: only the owner (or an org member of the owning org).
async function propertyOwner(req: never, reply: FastifyReply, propertyId: string): Promise<string | null> {
  const a = authed(req); if (!a) { void fail(reply, 'UNAUTHENTICATED', 'Login required', 401); return null; }
  const rows = await q<{ owner_id: string; organisation_id: string | null }>(`SELECT owner_id, organisation_id FROM property.property WHERE id=$1`, [propertyId]);
  const p = rows[0];
  if (p && (String(p.owner_id) === a.sub || (p.organisation_id && (await b2bService.memberRole(String(p.organisation_id), a.sub))))) return a.sub;
  void fail(reply, 'NOT_FOUND', 'Property not found', 404);
  return null;
}
app.get('/v1/properties/:id/history', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!(await propertyOwner(req as never, reply, id))) return reply;
  return { data: await historyService.timeline(id) };
});
app.get('/v1/properties/:id/reminders', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  if (!(await propertyOwner(req as never, reply, id))) return reply;
  return { data: await reminderService.due(id) };
});
app.post('/v1/recurring', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const body = z.object({ propertyId: z.string(), serviceId: z.string(), frequency: z.enum(['weekly', 'biweekly', 'monthly', 'quarterly']), startDate: z.string(), endDate: z.string().optional(), timeWindow: z.string(), paymentMethod: z.string() }).parse(req.body);
  const rec = await recurringService.create(a.sub, body);
  void slingAutomationService.createRetainer({
    userId: a.sub,
    propertyId: body.propertyId,
    serviceId: body.serviceId,
    serviceName: `Recurring ${body.serviceId} (${body.frequency})`,
    cadence: body.frequency,
    channels: ['whatsapp', 'push', 'sms'],
    aiAssisted: true,
  }).catch(() => {});
  return { data: rec };
});
// ---- USER APP: support tickets ----
app.post('/v1/support/tickets', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const { reason, jobId } = z.object({ reason: z.string(), jobId: z.string().optional() }).parse(req.body);
  return { data: await supportService.open(a.sub, reason, jobId) };
});
// Customers see only their own tickets; support agents see the queue.
app.get('/v1/support/tickets', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const roleRows = await q<{ role: string }>(`SELECT role FROM identity.users WHERE id=$1`, [a.sub]);
  const isAgent = adminCan(roleRows[0]?.role, 'booking:view:any');
  return { data: await supportService.list(isAgent ? null : a.sub, (req.query as { cursor?: string }).cursor) };
});
app.post('/v1/support/tickets/:id/messages', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const id = (req.params as { id: string }).id;
  const t = await supportService.get(id);
  const roleRows = await q<{ role: string }>(`SELECT role FROM identity.users WHERE id=$1`, [a.sub]);
  const isAgent = adminCan(roleRows[0]?.role, 'booking:view:any');
  if (!t || (t.customerId !== a.sub && !isAgent)) return fail(reply, 'NOT_FOUND', 'Ticket not found', 404);
  const { body } = z.object({ from: z.string().optional(), body: z.string().min(1).max(4000) }).parse(req.body);
  return { data: await supportService.message(id, a.sub, body) };
});
app.get('/v1/cities', async () => ({ data: await cityService.list() }));

// ---- PROVIDER/B2B APP: job execution (PRD App C) ----
for (const step of [['accept', 'PROVIDER_ACCEPTED'], ['arrive', 'ARRIVED'], ['start', 'IN_PROGRESS'], ['complete', 'COMPLETED']] as const) {
  app.post(`/v1/provider/jobs/:id/${step[0]}`, async (req, reply) => {
    const jobId = (req.params as { id: string }).id;
    const me = await providerActor(req as never, reply); if (!me) return reply;
    // Accept is allowed on a live offer; every later step needs the accepted assignment.
    const statuses = step[0] === 'accept' ? ['offered', 'accepted'] : ['accepted'];
    const mine = await q<{ status: string }>(`SELECT status FROM dispatch.assignment WHERE job_id=$1 AND provider_id=$2`, [jobId, me.id]);
    if (!mine[0] || !statuses.includes(String(mine[0].status))) return fail(reply, 'FORBIDDEN', 'Not assigned to this job', 403);
    // `from` is accepted for older clients but the server's current status wins.
    z.object({ from: z.string().optional(), actor: z.string().optional() }).parse(req.body ?? {});
    const from = await currentJobStatus(jobId);
    if (!from) return fail(reply, 'NOT_FOUND', 'Job not found', 404);
    const actor: string | undefined = undefined; // display name comes from the provider profile, never the body
    try {
      const res = await transition(jobId, from, step[1] as JobStatus, 'provider');
      const b = await bookingService.get(jobId).catch(() => null);
      if (b?.userId) {
        const evt =
          step[0] === 'accept'
            ? 'provider.assigned'
            : step[0] === 'arrive'
              ? 'provider.arrived'
              : `booking.${step[0]}`;
        void slingAutomationService.triggerEvent(evt, b.userId, {
          jobId,
          provider: actor ?? 'Your Kendibo Technician',
          service: b.serviceId,
        }).catch(() => {});
      }
      return res;
    }
    catch (e: unknown) { return fail(reply, 'ILLEGAL_TRANSITION', (e as Error).message, 409); }
  });
}
app.post('/v1/provider/jobs/:id/decline', async (req, reply) => {
  const me = await providerActor(req as never, reply); if (!me) return reply;
  const { offerId } = z.object({ offerId: z.string() }).parse(req.body);
  const offer = await q<{ provider_id: string }>(`SELECT provider_id FROM dispatch.assignment WHERE id=$1`, [offerId]);
  if (!offer[0] || String(offer[0].provider_id) !== me.id) return fail(reply, 'NOT_FOUND', 'Offer not found', 404);
  return { data: await providerService.respondToOffer(offerId, false) };
});
app.post('/v1/provider/jobs/:id/evidence', async (req, reply) => {
  const party = await bookingParty(req as never, reply, (req.params as { id: string }).id); if (!party) return reply;
  if (party.as !== 'provider') return fail(reply, 'FORBIDDEN', 'Not assigned to this job', 403);
  const { kind } = z.object({ kind: z.enum(['avatar', 'photo', 'video', 'doc']) }).parse(req.body);
  return { data: await mediaService.presign(kind) };
});
app.post('/v1/provider/jobs/:id/quote', async (req, reply) => {
  const jobId = (req.params as { id: string }).id;
  const party = await bookingParty(req as never, reply, jobId); if (!party) return reply;
  if (party.as !== 'provider') return fail(reply, 'FORBIDDEN', 'Not assigned to this job', 403);
  const { amountKobo, diagnosis } = z.object({ amountKobo: z.string().regex(/^\d+$/), diagnosis: z.string().max(4000).optional() }).parse(req.body);
  const q = await quoteService.propose(jobId, { amountKobo: BigInt(amountKobo), diagnosis });
  const b = await bookingService.get(jobId).catch(() => null);
  if (b?.userId) {
    const naira = (Number(amountKobo) / 100).toLocaleString('en-NG');
    void slingAutomationService.triggerEvent('quote.ready', b.userId, {
      jobId,
      amount: naira,
      service: b.serviceId,
    }).catch(() => {});
  }
  return { data: q };
});
// providerId / id query params are ignored for scoping: always the caller's own rows.
// ---- Provider price lists (commission model: customer pays the listed price,
// Kendibo keeps the trade's commission, the provider gets the rest) ----
const offeringBody = z.object({
  categoryId: z.string().min(1).max(60), name: z.string().min(2).max(80), description: z.string().max(500).optional(),
  priceKobo: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]), priceUnit: z.enum(['job', 'hour', 'visit', 'item']).optional(),
  durationMinutes: z.number().int().min(5).max(24 * 60).optional(),
  // Product vendors (052): kind, stock note ("In stock", "2–3 days"), photo (own media asset), max order quantity.
  kind: z.enum(['service', 'product']).optional(), stockNote: z.string().trim().max(60).nullable().optional(),
  photoAssetId: z.string().min(1).max(64).nullable().optional(), maxQuantity: z.number().int().min(1).max(1000).optional(),
});
const offeringKindQuery = z.object({ kind: z.enum(['service', 'product']).optional() });
const offeringError = (reply: FastifyReply, e: unknown) => {
  const m = (e as Error).message;
  if (m.startsWith('BELOW_MINIMUM')) return fail(reply, 'BELOW_MINIMUM', `The lowest price is ₦${(Number(m.split(':')[1]) / 100).toLocaleString('en-NG')}.`, 400);
  if (m.startsWith('KIND_MISMATCH:')) return fail(reply, 'KIND_MISMATCH', m.slice('KIND_MISMATCH:'.length), 400);
  if (m === 'BAD_CATEGORY') return fail(reply, 'BAD_CATEGORY', 'Choose one of Kendibo\'s trades.', 400);
  if (m === 'BAD_MAX_QUANTITY') return fail(reply, 'BAD_MAX_QUANTITY', 'Max quantity must be between 1 and 1,000.', 400);
  if (m === 'ASSET_NOT_FOUND') return fail(reply, 'ASSET_NOT_FOUND', 'Upload the product photo first (it must be your own image).', 400);
  if (m === 'NOT_FOUND') return fail(reply, 'NOT_FOUND', 'Price not found', 404);
  if (m.startsWith('LISTING_LIMIT:')) return fail(reply, 'LISTING_LIMIT', `Your tier allows ${m.split(':')[1]} active product listings. Pause one, or upgrade your tier to list more.`, 409);
  return fail(reply, 'OFFERING_ERROR', m, 400);
};
app.get('/v1/provider/offerings', async (req, reply) => {
  const me = await providerActor(req as never, reply); if (!me) return reply;
  const { kind } = offeringKindQuery.parse(req.query ?? {});
  return { data: await offeringService.listForProvider(me.id, true, kind) };
});
// "You receive ₦X after Kendibo's Y% commission" while the provider types a price.
app.get('/v1/provider/offerings/preview', async (req, reply) => {
  const me = await providerActor(req as never, reply); if (!me) return reply;
  const { categoryId, priceKobo } = z.object({ categoryId: z.string().min(1), priceKobo: z.string().regex(/^\d+$/) }).parse(req.query);
  return { data: await earningsFor(categoryId, BigInt(priceKobo), me.id) };
});
app.post('/v1/provider/offerings', async (req, reply) => {
  const me = await providerActor(req as never, reply); if (!me) return reply;
  const b = offeringBody.parse(req.body);
  const cat = await q(`SELECT 1 FROM catalog.category WHERE id=$1`, [b.categoryId]);
  if (!cat[0]) return fail(reply, 'BAD_CATEGORY', 'Choose one of Kendibo\'s trades.', 400);
  try { return { data: await offeringService.create(me.id, { ...b, priceKobo: BigInt(b.priceKobo) }) }; }
  catch (e) { return offeringError(reply, e); }
});
app.patch('/v1/provider/offerings/:id', async (req, reply) => {
  const me = await providerActor(req as never, reply); if (!me) return reply;
  const b = offeringBody.partial().extend({ active: z.boolean().optional() }).parse(req.body);
  try { return { data: await offeringService.update(me.id, (req.params as { id: string }).id, { ...b, priceKobo: b.priceKobo !== undefined ? BigInt(b.priceKobo) : undefined }) }; }
  catch (e) { return offeringError(reply, e); }
});
// A provider's prices, for signed-in customers (members-only marketplace).
app.get('/v1/providers/:id/offerings', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const { kind } = offeringKindQuery.parse(req.query ?? {});
  const rows = await offeringService.listForProvider((req.params as { id: string }).id, false, kind);
  return { data: rows.map(({ earnings: _e, ...o }) => o) }; // customers see the price, not the split
});
// Customer books a listed price with that provider.
app.post('/v1/offerings/:id/book', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const idem = req.headers['idempotency-key'];
  if (typeof idem !== 'string') return fail(reply, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key header required');
  const b = z.object({
    lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), addressText: z.string().max(200).optional(),
    notes: z.string().max(500).optional(), scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    timeWindow: z.string().max(20).optional(),
    quantity: z.number().int().optional(), // products only (1..max_quantity); services ignore it
  }).parse(req.body);
  try { return { data: await offeringService.book(a.sub, (req.params as { id: string }).id, { ...b, idempotencyKey: idem }) }; }
  catch (e) {
    const m = (e as Error).message;
    if (m === 'OFFERING_GONE') return fail(reply, 'OFFERING_GONE', 'This price is no longer available.', 404);
    if (m.startsWith('QUANTITY_RANGE:')) return fail(reply, 'QUANTITY_RANGE', `Choose a quantity from 1 to ${m.split(':')[1]}.`, 400);
    if (m.startsWith('BELOW_ORDER_MINIMUM:')) return fail(reply, 'BELOW_ORDER_MINIMUM', `The smallest order is ₦${(Number(m.split(':')[1]) / 100).toLocaleString('en-NG')}.`, 400);
    if (m === 'PROVIDER_UNAVAILABLE') return fail(reply, 'PROVIDER_UNAVAILABLE', 'This pro cannot take new jobs right now. Try another pro.', 409);
    throw e;
  }
});
app.get('/v1/provider/earnings/summary', async (req, reply) => {
  const me = await providerActor(req as never, reply); if (!me) return reply;
  return { data: await vendorFinanceService.summary(me.id) };
});
app.get('/v1/provider/earnings', async (req, reply) => {
  const me = await providerActor(req as never, reply); if (!me) return reply;
  return { data: await earningsService.forProvider(me.id) };
});
app.get('/v1/provider/payouts', async (req, reply) => {
  const me = await providerActor(req as never, reply); if (!me) return reply;
  const p = await payoutService.get((req.query as { id: string }).id ?? '');
  return { data: p && p.providerId === me.id ? p : null };
});
app.post('/v1/provider/verify-level', async (req, reply) => {
  // Trust & Safety only: setting a verification level is an admin action, so it
  // goes through adminActor (caller's role) like the /v1/admin routes.
  const a = await adminActor(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  if ('denied' in a || !adminCan(a.role, 'provider:verify')) return fail(reply, 'FORBIDDEN', 'Trust & Safety access required', 403);
  const { providerId, level } = z.object({ providerId: z.string(), level: z.string() }).parse(req.body);
  const v = await verificationService.set(providerId, level as never);
  await auditService.log(a.sub, `provider.${providerId}.level=${level}`);
  return { data: v };
});
app.get('/v1/checklists/:category', async (req) => ({ data: await checklistService.forCategory((req.params as { category: string }).category) }));
app.post('/v1/emergency', async (req, reply) => {
  const { jobId, kind } = z.object({ jobId: z.string(), kind: z.string().max(60) }).parse(req.body);
  if (!(await bookingParty(req as never, reply, jobId))) return reply;
  return { data: await emergencyService.create(jobId, kind) };
});
// ---- PROVIDER/B2B APP: B2B work orders ----
// Org membership (b2b.organisation_user) scopes every B2B read and write.
async function orgMember(req: never, reply: FastifyReply, orgId: string): Promise<{ sub: string; role: string } | null> {
  const a = authed(req); if (!a) { void fail(reply, 'UNAUTHENTICATED', 'Login required', 401); return null; }
  const role = await b2bService.memberRole(orgId, a.sub);
  if (!role) { void fail(reply, 'FORBIDDEN', 'Not an org member', 403); return null; }
  return { sub: a.sub, role };
}
app.post('/v1/b2b/organisations', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const { name, type } = z.object({ name: z.string().min(2).max(120), type: z.string().max(60) }).parse(req.body);
  const org = await b2bService.createOrg(name, type);
  await b2bService.addMember(org.id, a.sub, 'B2B_ADMIN'); // creator administers the org
  return { data: org };
});
app.post('/v1/b2b/work-orders', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const { orgId, propertyId, title, amountKobo } = z.object({ orgId: z.string(), propertyId: z.string(), title: z.string(), amountKobo: z.string() }).parse(req.body);
  const role = await b2bService.memberRole(orgId, a.sub);
  if (!role) return fail(reply, 'FORBIDDEN', 'Not an org member', 403);
  return { data: await b2bService.createWorkOrder(orgId, propertyId, title, BigInt(amountKobo)) };
});
app.get('/v1/b2b/work-orders', async (req, reply) => {
  const orgId = String((req.query as { orgId?: string }).orgId ?? '');
  if (!(await orgMember(req as never, reply, orgId))) return reply;
  return { data: await b2bService.list(orgId) };
});
const B2B_APPROVER_ROLES = ['B2B_ADMIN', 'APPROVER', 'FACILITY_MANAGER'];
app.post('/v1/b2b/work-orders/:id/approve', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const wo = await q<{ org_id: string }>(`SELECT org_id FROM b2b.work_order WHERE id=$1`, [id]);
  if (!wo[0]) return fail(reply, 'NOT_FOUND', 'Work order not found', 404);
  const m = await orgMember(req as never, reply, String(wo[0].org_id)); if (!m) return reply;
  if (!B2B_APPROVER_ROLES.includes(m.role)) return fail(reply, 'FORBIDDEN', 'Your org role cannot approve work orders', 403);
  // role/by come from the membership row, never the request body.
  try { return { data: await b2bService.approve(id, m.role, m.sub) }; }
  catch (e: unknown) { return fail(reply, 'APPROVAL_BLOCKED', (e as Error).message, 409); }
});
app.post('/v1/b2b/invoices', async (req, reply) => {
  const { orgId, workOrderId } = z.object({ orgId: z.string(), workOrderId: z.string() }).parse(req.body);
  const m = await orgMember(req as never, reply, orgId); if (!m) return reply;
  if (!['B2B_ADMIN', 'FINANCE'].includes(m.role)) return fail(reply, 'FORBIDDEN', 'Your org role cannot invoice', 403);
  const wo = await q<{ org_id: string }>(`SELECT org_id FROM b2b.work_order WHERE id=$1`, [workOrderId]);
  if (!wo[0] || String(wo[0].org_id) !== orgId) return fail(reply, 'NOT_FOUND', 'Work order not found', 404);
  return { data: await b2bService.invoice(orgId, workOrderId) };
});
app.get('/v1/b2b/reports', async (req, reply) => {
  const orgId = String((req.query as { orgId?: string }).orgId ?? '');
  if (!(await orgMember(req as never, reply, orgId))) return reply;
  return { data: await b2bService.report(orgId) };
});

// ---- ADMIN CONSOLE: full ops (PRD §54 + App C) ----
app.get('/v1/admin/jobs', async (req, reply) => {
  const a = await adminActor(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  if ('denied' in a || !adminCan(a.role, 'booking:view:any')) return fail(reply, 'FORBIDDEN', 'Operations access required', 403);
  const userId = (req.query as { userId?: string }).userId;
  // userId filter → one customer's history; absent → recent jobs across users
  // (the old `list('')` always matched nothing, so the console showed an empty table).
  return { data: userId ? await bookingService.list(userId) : await bookingService.listAll() };
});
app.post('/v1/admin/jobs/:id/assign', async (req, reply) => {
  const a = await adminActor(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  if ('denied' in a || !adminCan(a.role, 'booking:override')) return fail(reply, 'FORBIDDEN', 'Dispatcher access required', 403);
  const { providerId } = z.object({ providerId: z.string() }).parse(req.body);
  await auditService.log(a.sub, `job.${(req.params as { id: string }).id}.assign=${providerId}`);
  return { data: await dispatchService.assign((req.params as { id: string }).id, providerId) };
});
app.post('/v1/admin/jobs/:id/flag', async (req, reply) => {
  const a = await adminActor(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  if ('denied' in a || !adminCan(a.role, 'booking:override')) return fail(reply, 'FORBIDDEN', 'Operations access required', 403);
  const { flag: f, reason } = z.object({ flag: z.string(), reason: z.string().optional() }).parse(req.body);
  await auditService.log(a.sub, `job.${(req.params as { id: string }).id}.flag=${f}`);
  return { data: await flagJob((req.params as { id: string }).id, f as never, a.sub, reason) };
});
app.get('/v1/admin/jobs/:id/flags', async (req, reply) => {
  // Auth gap: was public — flag reasons can contain customer PII/dispute detail.
  const a = await adminActor(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  if ('denied' in a || !adminCan(a.role, 'booking:view:any')) return fail(reply, 'FORBIDDEN', 'Operations access required', 403);
  return { data: await flagsOf((req.params as { id: string }).id) };
});
app.post('/v1/admin/providers/:id/approve', async (req, reply) => {
  const a = await adminActor(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  if ('denied' in a || !adminCan(a.role, 'provider:verify')) return fail(reply, 'FORBIDDEN', 'Trust & Safety access required', 403);
  const id = (req.params as { id: string }).id;
  const existing = await providerService.byId(id);
  if (!existing) return fail(reply, 'NOT_FOUND', 'Provider not found', 404);
  await auditService.log(a.sub, `provider.${id}.approve`, id);
  await providerService.verifyKyc(id);
  await kycService.markApproved(id, a.sub);
  const level = await verificationService.set(id, 'verified');
  // Approval changes what the vendor may do: enroll the trades of their skills
  // and re-evaluate every enrollment against its category rules.
  for (const c of await providerSkillCategories(id)) await vendorEligibilityService.enroll(id, c).catch((e) => observability.captureException(e));
  await vendorEligibilityService.refreshAll(id).catch((e) => observability.captureException(e));
  return { data: level };
});
app.post('/v1/admin/providers/:id/reject', async (req, reply) => {
  const a = await adminActor(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  if ('denied' in a || !adminCan(a.role, 'provider:verify')) return fail(reply, 'FORBIDDEN', 'Trust & Safety access required', 403);
  const id = (req.params as { id: string }).id;
  const { reason } = z.object({ reason: z.string().min(3).max(500) }).parse(req.body);
  const existing = await providerService.byId(id);
  if (!existing) return fail(reply, 'NOT_FOUND', 'Provider not found', 404);
  return { data: await kycService.reject(id, reason, a.sub) };
});
// ── ADMIN: customer KYC queue — same Trust & Safety gate (provider:verify) ──
app.get('/v1/admin/users/kyc', async (req, reply) => {
  const a = await adminActor(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  if ('denied' in a || !adminCan(a.role, 'provider:verify')) return fail(reply, 'FORBIDDEN', 'Trust & Safety access required', 403);
  const status = (req.query as { status?: string }).status ?? 'UNDER_REVIEW';
  const allowed = ['PENDING', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED'];
  const st = allowed.includes(status) ? status : 'UNDER_REVIEW';
  const rows = await q<Record<string, unknown>>(
    `SELECT c.user_id, c.status, c.tier, c.submitted_at, u.name, u.phone, u.email,
            (SELECT COUNT(*) FROM kyc.customer_document d WHERE d.user_id = c.user_id) AS doc_count
       FROM kyc.customer c JOIN identity.users u ON u.id = c.user_id
      WHERE c.status = $1
      ORDER BY c.submitted_at DESC NULLS LAST
      LIMIT 100`, [st]);
  return {
    data: rows.map((r) => ({
      userId: String(r.user_id), name: String(r.name ?? 'Customer'),
      phone: r.phone ? String(r.phone) : null, email: r.email ? String(r.email) : null,
      status: String(r.status), tier: Number(r.tier ?? 0),
      submittedAt: r.submitted_at ? String(r.submitted_at) : null,
      documentCount: Number(r.doc_count ?? 0),
    })),
  };
});
app.get('/v1/admin/users/kyc/:userId', async (req, reply) => {
  const a = await adminActor(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  if ('denied' in a || !adminCan(a.role, 'provider:verify')) return fail(reply, 'FORBIDDEN', 'Trust & Safety access required', 403);
  const userId = (req.params as { userId: string }).userId;
  const status = await kycService.userStatus(userId);
  const docs = await kycService.userDocumentsFor(userId);
  const docUrls = await Promise.all(docs.map(async (d) => {
    const asset = await mediaService.get(d.assetId).catch(() => null);
    return { ...d, url: asset?.url ?? null, moderation: asset?.status ?? null };
  }));
  const checks = await kycService.checksFor('user', userId);
  return { data: { ...status, documents: docUrls, checks } };
});
app.post('/v1/admin/users/kyc/:userId/approve', async (req, reply) => {
  const a = await adminActor(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  if ('denied' in a || !adminCan(a.role, 'provider:verify')) return fail(reply, 'FORBIDDEN', 'Trust & Safety access required', 403);
  const userId = (req.params as { userId: string }).userId;
  const status = await kycService.userStatus(userId);
  if (!status.submittedAt && status.status === 'PENDING') return fail(reply, 'NOT_FOUND', 'No KYC application for this customer', 404);
  await kycService.userApprove(userId, a.sub);
  return { data: await kycService.userStatus(userId) };
});
app.post('/v1/admin/users/kyc/:userId/reject', async (req, reply) => {
  const a = await adminActor(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  if ('denied' in a || !adminCan(a.role, 'provider:verify')) return fail(reply, 'FORBIDDEN', 'Trust & Safety access required', 403);
  const userId = (req.params as { userId: string }).userId;
  const { reason } = z.object({ reason: z.string().min(3).max(500) }).parse(req.body);
  const status = await kycService.userStatus(userId);
  if (!status.submittedAt && status.status === 'PENDING') return fail(reply, 'NOT_FOUND', 'No KYC application for this customer', 404);
  await kycService.userReject(userId, reason, a.sub);
  return { data: await kycService.userStatus(userId) };
});
app.post('/v1/admin/providers/:id/suspend', async (req, reply) => {
  const a = await adminActor(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  if ('denied' in a || !adminCan(a.role, 'provider:suspend')) return fail(reply, 'FORBIDDEN', 'Trust & Safety access required', 403);
  const id = (req.params as { id: string }).id;
  const existing = await providerService.byId(id);
  if (!existing) return fail(reply, 'NOT_FOUND', 'Provider not found', 404);
  // Fully suspend: status drives /v1/providers/approved + dispatch candidates,
  // verify_level drives badges/online; online=false stops the location poller.
  const mc = await makerChecker.submit('suspension', id, a.sub);
  await q(`UPDATE provider.provider SET status='suspended', verify_level='suspended', online=FALSE WHERE id=$1`, [id]);
  await auditService.log(a.sub, `provider.${id}.suspend.queued=${mc.id}`, id);
  const v = await verificationService.set(id, 'suspended');
  return { data: { ...v, checkerId: mc.id } };
});
// Admin KYC review queue + detail (documents travel via media file URLs).
app.get('/v1/admin/providers', async (req, reply) => {
  const a = await adminActor(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  if ('denied' in a || !adminCan(a.role, 'provider:verify')) return fail(reply, 'FORBIDDEN', 'Trust & Safety access required', 403);
  const status = (req.query as { status?: string }).status ?? 'UNDER_REVIEW';
  const allowed = ['PENDING', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED'];
  const st = allowed.includes(status) ? status : 'UNDER_REVIEW';
  const rows = await q<Record<string, unknown>>(
    `SELECT p.id, p.kyc_status, p.kyc_submitted_at, p.kyc_tier, p.kyc_provider, p.nin_masked,
            p.business_name, p.rating, p.status, p.created_at,
            u.name, u.phone, u.email,
            (SELECT COUNT(*) FROM kyc.submission_document d WHERE d.provider_id = p.id) AS doc_count
       FROM provider.provider p JOIN identity.users u ON u.id = p.user_id
      WHERE p.kyc_status = $1
      ORDER BY p.kyc_submitted_at DESC NULLS LAST, p.created_at DESC
      LIMIT 100`, [st]);
  return {
    data: rows.map((r) => ({
      id: String(r.id), name: String(r.name ?? 'Provider'), phone: r.phone ? String(r.phone) : null,
      email: r.email ? String(r.email) : null, businessName: r.business_name ? String(r.business_name) : null,
      kycStatus: String(r.kyc_status), status: String(r.status), rating: Number(r.rating ?? 0),
      tier: Number(r.kyc_tier ?? 0), kycProvider: r.kyc_provider ? String(r.kyc_provider) : null,
      ninMasked: r.nin_masked ? String(r.nin_masked) : null,
      submittedAt: r.kyc_submitted_at ? String(r.kyc_submitted_at) : null,
      createdAt: String(r.created_at), documentCount: Number(r.doc_count ?? 0),
    })),
  };
});
app.get('/v1/admin/providers/:id', async (req, reply) => {
  const a = await adminActor(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  if ('denied' in a || !adminCan(a.role, 'provider:verify')) return fail(reply, 'FORBIDDEN', 'Trust & Safety access required', 403);
  const id = (req.params as { id: string }).id;
  const rows = await q<Record<string, unknown>>(
    `SELECT p.*, u.name, u.phone, u.email
       FROM provider.provider p JOIN identity.users u ON u.id = p.user_id WHERE p.id=$1`, [id]);
  const r = rows[0];
  if (!r) return fail(reply, 'NOT_FOUND', 'Provider not found', 404);
  const documents = await kycService.documentsFor(id);
  const docUrls = await Promise.all(documents.map(async (d) => {
    const asset = await mediaService.get(d.assetId).catch(() => null);
    return { ...d, url: asset?.url ?? null, moderation: asset?.status ?? null };
  }));
  return {
    data: {
      id: String(r.id), userId: String(r.user_id), name: String(r.name ?? 'Provider'),
      phone: r.phone ? String(r.phone) : null, email: r.email ? String(r.email) : null,
      businessName: r.business_name ? String(r.business_name) : null,
      kycStatus: String(r.kyc_status), rejectionReason: r.kyc_rejection_reason ? String(r.kyc_rejection_reason) : null,
      tier: Number(r.kyc_tier ?? 0), kycProvider: r.kyc_provider ? String(r.kyc_provider) : null,
      ninMasked: r.nin_masked ? String(r.nin_masked) : null,
      submittedAt: r.kyc_submitted_at ? String(r.kyc_submitted_at) : null,
      reviewedAt: r.kyc_reviewed_at ? String(r.kyc_reviewed_at) : null,
      reviewedBy: r.kyc_reviewed_by ? String(r.kyc_reviewed_by) : null,
      status: String(r.status), verifyLevel: String(r.verify_level ?? 'pending'),
      rating: Number(r.rating ?? 0), lat: r.lat ?? null, lng: r.lng ?? null,
      serviceRadiusKm: r.service_radius_km != null ? Number(r.service_radius_km) : null,
      bankName: r.bank_name ? String(r.bank_name) : null,
      accountNumber: r.account_number ? String(r.account_number) : null,
      bankCode: r.bank_code ? String(r.bank_code) : null,
      documents: docUrls,
      checks: await kycService.checksFor('provider', id),
      createdAt: String(r.created_at),
    },
  };
});
// Runtime map-provider switch (chain always terminates on keyless OSM).
app.get('/v1/admin/maps/config', async (req, reply) => {
  const a = await adminActor(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  if ('denied' in a || !adminCan(a.role, 'configuration:edit')) return fail(reply, 'FORBIDDEN', 'Super admin access required', 403);
  const cfg = await getMapsConfig();
  return { data: { provider: cfg.provider, fallbacks: cfg.fallbacks, availability: cfg.availability } };
});
app.put('/v1/admin/maps/config', async (req, reply) => {
  const a = await adminActor(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  if ('denied' in a || !adminCan(a.role, 'configuration:edit')) return fail(reply, 'FORBIDDEN', 'Super admin access required', 403);
  const enumNames = MAPS_PROVIDER_NAMES as [MapsProviderName, ...MapsProviderName[]];
  const { provider, fallbacks } = z.object({
    provider: z.enum(enumNames).optional(),
    fallbacks: z.array(z.enum(enumNames)).max(3).optional(),
  }).parse(req.body ?? {});
  const cfg = await setMapsConfig({ provider, fallbacks });
  await auditService.log(a.sub, `maps.provider=${cfg.provider} fallbacks=${cfg.fallbacks.join('|')}`);
  return { data: { provider: cfg.provider, fallbacks: cfg.fallbacks, availability: cfg.availability } };
});
// Maker-checker decide (refund/suspension/etc. queue actions).
app.post('/v1/admin/checker/:id/decide', async (req, reply) => {
  const a = await adminActor(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  if ('denied' in a || !adminCan(a.role, 'payout:approve')) return fail(reply, 'FORBIDDEN', 'Finance access required', 403);
  const { approve } = z.object({ approve: z.boolean() }).parse(req.body);
  try {
    const item = await makerChecker.decide((req.params as { id: string }).id, a.sub, approve);
    await auditService.log(a.sub, `checker.${item.id}=${item.status}`, item.refId);
    // Approved suspensions apply for real (submission only queued the record).
    if (item.kind === 'suspension' && item.status === 'approved') {
      await q(`UPDATE provider.provider SET status='suspended', verify_level='suspended', online=FALSE WHERE id=$1`, [item.refId]);
      await auditService.log(a.sub, `provider.${item.refId}.suspend.applied`, item.refId);
    }
    return { data: item };
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg === 'CHECKER_GONE') return fail(reply, 'CHECKER_GONE', 'Decision already recorded', 409);
    if (msg === 'MAKER_CANNOT_CHECK') return fail(reply, 'MAKER_CANNOT_CHECK', 'Another admin must review this item', 403);
    throw e;
  }
});
app.get('/v1/admin/disputes', async (req, reply) => {
  const a = await adminActor(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  if ('denied' in a || !adminCan(a.role, 'booking:view:any')) return fail(reply, 'FORBIDDEN', 'Support access required', 403);
  return { data: await disputeService.get((req.query as { id: string }).id) };
});
app.post('/v1/admin/refunds', async (req, reply) => {
  const a = await adminActor(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  if ('denied' in a || !adminCan(a.role, 'payment:refund')) return fail(reply, 'FORBIDDEN', 'Finance access required', 403);
  const { id, status } = z.object({ id: z.string(), status: z.string() }).parse(req.body);
  const mc = await makerChecker.submit('refund', id, a.sub);
  await auditService.log(a.sub, `refund.${id}=${status} checker=${mc.id}`);
  return { data: await refundService.mark(id, status as never) };
});
app.get('/v1/admin/ledger', async (req, reply) => {
  const a = await adminActor(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  if ('denied' in a || !adminCan(a.role, 'ledger:view')) return fail(reply, 'FORBIDDEN', 'Finance access required', 403);
  return { data: await trialBalance() };
});
app.get('/v1/admin/checker', async (req, reply) => {
  const a = await adminActor(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  if ('denied' in a || !adminCan(a.role, 'payout:approve')) return fail(reply, 'FORBIDDEN', 'Finance access required', 403);
  return { data: makerChecker.pending() };
});
app.get('/v1/admin/analytics', async (req, reply) => {
  const a = await adminActor(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  if ('denied' in a) return fail(reply, 'FORBIDDEN', 'Admin access required', 403);
  return { data: analyticProps({ surface: 'admin' }) };
});
app.get('/v1/admin/audit', async (req, reply) => {
  const a = await adminActor(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  if ('denied' in a || !adminCan(a.role, 'audit:view')) return fail(reply, 'FORBIDDEN', 'Audit view access required', 403);
  return { data: await auditService.query(auditQuerySchema.parse(req.query ?? {})) };
});
app.post('/v1/admin/flags', async (req, reply) => {
  const a = await adminActor(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  if ('denied' in a || !adminCan(a.role, 'configuration:edit')) return fail(reply, 'FORBIDDEN', 'Super admin access required', 403);
  const { key, value } = z.object({ key: z.string(), value: z.boolean() }).parse(req.body);
  await auditService.log(a.sub, `flag.${key}=${value}`);
  return { data: await configurationService.setFlag(key, value, a.sub) };
});

// addressSchema re-export guard (keeps import used)
void addressSchema;

// ---------- mobile-first: cacheable config + device registry ----------
// Low-bandwidth: one round-trip for flags/zones/pricebook (PRD §60).
app.addHook('onSend', async (req, reply, payload) => {
  if (req.method === 'GET' && /^\/(v1\/(config|mobile\/config|cities|categories|services))/.test(req.url)) {
    void reply.header('Cache-Control', 'private, max-age=60');
  }
  return payload;
});
app.get('/v1/mobile/config', async () => ({
  data: {
    priceBook: await configurationService.priceBook(),
    flags: await configurationService.flags(),
    cities: await cityService.list(),
    // Active map provider + fallbacks so the web/native layers render the
    // right tiles (admin-switchable without redeploy; no secrets exposed).
    maps: await (async () => { const c = await getMapsConfig(); return { provider: c.provider, fallbacks: c.fallbacks, googleMapsKey: process.env.GOOGLE_MAPS_BROWSER_KEY || process.env.GOOGLE_MAPS_API_KEY || undefined }; })(),
    surfaces: ['user_app', 'provider_b2b_app', 'admin_console'],
  },
}));
// Blueprint §14 device sessions (push targets for channel router).
app.post('/v1/devices', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  // The push token is bound to the session user; a body userId is ignored so a
  // caller can never route another account's notifications to their device.
  const { platform, pushToken, channel } = z.object({ userId: z.string().optional(), platform: z.enum(['android', 'ios', 'web']), pushToken: z.string().min(10).max(512), channel: z.string().max(60).optional() }).parse(req.body);
  return { data: await deviceService.register(a.sub, platform, pushToken, channel) };
});
app.delete('/v1/devices/:id', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const id = (req.params as { id: string }).id;
  const own = await q(`SELECT 1 FROM identity.device WHERE id=$1 AND user_id=$2`, [id, a.sub]);
  return { data: { removed: own[0] ? await deviceService.remove(id) : false } };
});
app.get('/v1/me/sessions', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  return { data: await deviceService.sessionsFor(a.sub) };
});
// Throttled batch ingest from the Android tracker hook.
app.post('/v1/provider/location/batch', async (req, reply) => {
  const me = await providerActor(req as never, reply);
  if (!me) return reply;
  try {
    const { points } = z.object({ points: z.array(z.object({ lat: z.number(), lng: z.number(), at: z.string() })) }).parse(req.body);
    return { data: await geoService.ingestBatch(me.id, points) };
  } catch (e: unknown) { return fail(reply, 'BAD_BATCH', (e as Error).message); }
});
// Media ingest writes through the object store (quarantine -> promote).
// Preferred mobile flow is direct PUT to the presigned uploadUrl.
// Base64 adds a third, so a 25MB file is ~34MB of JSON. Fastify's 1MB default
// rejected every normal phone photo with 413 before this handler ran.
app.post('/v1/media/:id/ingest', { bodyLimit: 36 * 1024 * 1024 }, async (req, reply) => {
  // Session-scoped: ingest writes bytes into the object store. Was public.
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  try {
    const { dataBase64, mime } = z.object({ dataBase64: z.string(), mime: z.string() }).parse(req.body);
    const bytes = Buffer.from(dataBase64, 'base64');
    if (bytes.length === 0) return fail(reply, 'EMPTY_UPLOAD', 'No bytes received');
    return { data: await mediaService.ingest((req.params as { id: string }).id, bytes, mime) };
  } catch (e: unknown) { return fail(reply, 'INGEST_FAILED', (e as Error).message); }
});
// Asset status polling — clients (e.g. KYC doc uploads) poll until the
// moderation scan settles so they know when an asset is safe to submit.
app.get('/v1/media/:id', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const asset = await mediaService.get((req.params as { id: string }).id);
  if (!asset) return fail(reply, 'NOT_FOUND', 'Asset not found', 404);
  return { data: { id: asset.id, status: asset.status, mime: asset.mime ?? null } };
});
// Signed file delivery. Local driver serves bytes; s3 driver redirects to the
// bucket-signed URL (Pxxl CDN Storage / R2 / MinIO).
app.get('/v1/media/:id/file', async (req, reply) => {
  // Signed media is embedded cross-origin (web <img> from the app origin);
  // helmet's default CORP same-origin makes Chromium block the render (the
  // request succeeds with 200 but the image never paints), so opt this route out.
  void reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
  const q = req.query as { exp?: string; sig?: string };
  const asset = await mediaService.get((req.params as { id: string }).id);
  if (!asset || asset.status !== 'clean' || !asset.url) return fail(reply, 'NOT_FOUND', 'Asset unavailable', 404);
  if (asset.url.startsWith('http')) return reply.redirect(asset.url);
  if (!q.exp || !q.sig || !objectStore.verifyLocalUrl(asset.id, q.exp, q.sig)) {
    return fail(reply, 'BAD_SIGNATURE', 'Invalid or expired signed URL', 403);
  }
  try {
    const { bytes, mime } = await mediaService.readAsset(asset.id);
    void reply.header('Content-Type', mime);
    void reply.header('Cache-Control', 'private, max-age=3600');
    return reply.send(bytes);
  } catch {
    return fail(reply, 'NOT_FOUND', 'Asset unavailable', 404);
  }
});

const port = Number(process.env.PORT ?? 3000);
// ---------- vendor platform: storefronts, trade rules, credentials, WhatsApp ----------
registerVendorRoutes(app, { authed: authed as never, fail: fail as never, providerActor });
if (process.env.NODE_ENV !== 'test') { startCompletionSweeper(); startReminderSweeper(); startBackupSweeper(); }
registerAdminOpsRoutes(app, { authed: authed as never, fail: fail as never });
registerEvidenceRoutes(app, { fail: fail as never, bookingParty: bookingParty as never, adminActor: adminActor as never });
registerEmailRoutes(app, { authed: authed as never, fail: fail as never });
registerOnboardingRoutes(app, { authed: authed as never, fail: fail as never });
registerKycAdminRoutes(app, { fail: fail as never, adminActor: adminActor as never });
registerVirtualAccountRoutes(app, { authed: authed as never, fail: fail as never, routeOther: routePagaCallback });
installVirtualAccountHooks(onEmit);
registerAdminConsoleRoutes(app, { fail: fail as never, adminActor: adminActor as never });
registerAdminPasswordRoutes(app, { fail: fail as never, adminActor: adminActor as never });
registerTierRoutes(app, { fail: fail as never, adminActor: adminActor as never, providerActor: providerActor as never, payments });
registerPricingSettingsRoutes(app, { fail: fail as never, adminActor: adminActor as never });
installAdminAlerts();
if (process.env.NODE_ENV !== 'test') startLifecycleSweeper();
Object.assign(ROUTE_POLICY, INVOICE_ROUTE_POLICY); registerInvoiceRoutes(app, { fail: fail as never, bookingParty: bookingParty as never, providerActor });
configureWhatsappBot({ createCheckout: (input) => payments.createCheckout(input) });

if (process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test') {
  // Hybrid dispatch SLA sweep: expire overdue offers and escalate to the next
  // eligible candidate (or fall through to customer-pick) every 60s.
  const sweepTimer = setInterval(() => { void dispatchSweep(); }, 60_000);
  sweepTimer.unref?.();
  app.listen({ port, host: '0.0.0.0' }).then(() => {
    const w = watchupClient as unknown as { enabled: boolean; environment: string; release: string };
    app.log.info(`kendibo-api :${port} (payments: paga ${payments.isConfigured() ? (process.env.PAGA_ENV === 'live' ? 'live' : 'sandbox') : 'NOT CONFIGURED'})`);
    startPaymentReconciler(settlement, { enabled: payments.isConfigured() });
    app.log.info(`watchup: ${w.enabled ? `enabled env=${w.environment} release=${w.release}` : 'disabled (no WATCHUP_API_KEY)'}`);
    if (w.enabled) observability.track('deploy.boot', { port, env: w.environment, release: w.release });
  });
}
export { app };
export { fraudService };
