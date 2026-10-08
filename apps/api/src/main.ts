import 'dotenv/config'; // must stay first: loads .env (gitignored) before any env read
import { config as appConfig } from '../../../packages/config/env.js'; // validates; refuses prod boot on missing secrets
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import { PaymentService } from '../../../modules/payments/payment.service.js';
import { postCollection, postSettlement, trialBalance, openPeriod } from '../../../modules/ledger/ledger.service.js';
import { transition, type JobStatus } from '../../../modules/job-engine/job.machine.js';
import { observability } from '../../../packages/observability/watchup.adapter.js';
import { identityService } from '../../../modules/identity/identity.service.js';
import { authorize, type Permission } from '../../../modules/authorization/rbac.js';
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
import { disputeService, reviewService } from '../../../modules/disputes/trust.service.js';
import { messagingService } from '../../../modules/messaging/messaging.service.js';
import { notificationService, TEMPLATES } from '../../../modules/notifications/notification.service.js';
import { mediaService } from '../../../modules/media/media.service.js';
import { kycService } from '../../../modules/kyc/kyc.service.js';
import { fraudService } from '../../../modules/fraud/fraud.service.js';
import { configurationService } from '../../../modules/configuration/config.service.js';
import { auditService } from '../../../modules/audit/audit.service.js';
import { verifyAccess } from '../../../packages/auth/auth.js';
import { verificationService, qualityService, checklistService, emergencyService } from '../../../modules/providers/quality.service.js';
import { warrantyService as fullWarranty, supportService, earningsService } from '../../../modules/warranties/warranty.service.js';
import { b2bService } from '../../../modules/b2b/b2b.service.js';
import { cityService, makerChecker, analyticProps } from '../../../modules/configuration/cities.service.js';
import { historyService, reminderService, recurringService } from '../../../modules/properties/history.service.js';
import { evaluateCancellation, markFailed } from '../../../modules/bookings/cancellation.js';
import { reschedule, rescheduleHistory, flag as flagJob, flagsOf } from '../../../modules/job-engine/job.machine.js';
import { deviceService } from '../../../modules/devices/device.service.js';
import { objectStore } from '../../../packages/storage/object.store.js';
import { q } from '../../../packages/database/db.js';
import { maps } from '../../../modules/geo/maps.port.js';
import { requestService } from '../../../modules/requests/request.service.js';
import { surfaceFor } from '../../../packages/shared/clients.js';
void surfaceFor;
import { Writable } from 'node:stream';
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
  logger: { stream: logStream },
  genReqId: () => `req_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`,
  trustProxy: PROD, // Pxxl edge terminates TLS ahead of the container
});
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';

void app.register(helmet, {
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }, // Strict encrypted rails
  contentSecurityPolicy: PROD,
});
void app.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
  errorResponseBuilder: () => ({ error: { code: 'RATE_LIMIT', message: 'Too many requests' } }),
});

// Prod CORS: explicit allowlist only (Pxxl dashboard CORS_ORIGINS + deployed app).
// Dev: permissive + Expo running URLs (Metro bundler on localhost/LAN, legacy
// devtools ports). Native apps (Expo Go, EAS builds) send no Origin header
// and are always allowed; Expo web sends its https origin (must allowlist).
const allowedOrigins = appConfig.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
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
    if (allowedOrigins.includes(origin)) return cb(null, true);
    // Expo dev surfaces (Metro localhost/LAN, devtools ports) are loopback-only
    // and safe in every environment — demos run Expo web dev against prod.
    if (expoOriginAllowed(origin)) return cb(null, true);
    return cb(new Error('CORS blocked'), false);
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
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
void app.addHook('preSerialization', async (_req, _reply, payload) => ser(payload));
const payments = new PaymentService((globalThis as Record<string, unknown>).__PSP__ as never);
void app.register(watchupTracing);
process.on('unhandledRejection', (err) => observability.captureException(err, { source: 'unhandledRejection' }));
process.on('SIGTERM', () => void (watchupClient as unknown as { shutdown?: () => Promise<void> }).shutdown?.());
void openPeriod('2026-10');
// Local DB (pg-mem) when no DATABASE_URL — same SQL, same constraints as Pxxl Postgres.
if (!process.env.DATABASE_URL) {
  void import('../../../packages/database/local.js').then((m) => m.localDb());
}

function fail(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, code: string, message: string, status = 400, retryable = false) {
  return reply.code(status).send({ error: { code, message, retryable } });
}
function authed(req: { headers: Record<string, string | undefined> }): { sub: string; permissions: string[] } | null {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return null;
  return verifyAccess(h.slice(7));
}

// ---------- health ----------
// GET / answers platform probes + humans (Pxxl health checks default to /).
app.get('/', async () => ({
  ok: true, service: 'kendibo-api', version: '0.1.0',
  docs: 'GET /health/live, /health/ready, /health/dependencies, /v1/mobile/config',
}));
app.get('/health/live', async () => ({ ok: true }));
app.get('/health/ready', async () => ({ ok: true, db: process.env.DATABASE_URL ? 'postgres' : 'local', redis: process.env.REDIS_URL ? 'redis' : 'memory', storage: objectStore.driver }));
app.get('/health/dependencies', async () => {
  const w = watchupClient as unknown as { enabled: boolean; environment: string; release: string; queueDepth: number };
  return {
    bachs: 'sandbox', flutterwave: 'fallback', maps: 'adapter', kyc: 'adapter',
    sms: 'termii', email: 'smtp', push: 'fcm', storage: objectStore.driver,
    watchup: w.enabled
      ? { status: 'enabled', environment: w.environment, release: w.release, queueDepth: w.queueDepth }
      : { status: 'disabled', hint: 'set WATCHUP_API_KEY and redeploy' },
  };
});
app.get('/v1/admin/monitoring', async (req, reply) => {
  const a = authed(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
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
app.post('/v1/auth/otp/request', async (req, reply) => {
  try {
    const { channel, identity } = z.object({ channel: z.enum(['phone', 'email']), identity: z.string() }).parse(req.body);
    const r = await identityService.requestOtp(channel, identity);
    return { data: { sent: true, devCode: r.devCode } };
  } catch (e: unknown) {
    const msg = (e as Error).message;
    if (msg === 'BAD_IDENTITY') return fail(reply, 'BAD_IDENTITY', 'Enter a valid phone number or email address.');
    if (msg === 'SEND_FAILED') return fail(reply, 'SEND_FAILED', 'Could not deliver the code. Try again.', 502, true);
    throw e;
  }
});
app.post('/v1/auth/otp/verify', async (req) => {
  const { channel, identity, code, device } = z.object({
    channel: z.enum(['phone', 'email']), identity: z.string(), code: z.string(),
    device: z.object({
      fp: z.string().optional(), platform: z.string().optional(), model: z.string().optional(),
      os: z.string().optional(), appVersion: z.string().optional(), city: z.string().optional(),
    }).optional(),
  }).parse(req.body);
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip;
  const s = await identityService.verifyOtp(channel, identity, code, { ...device, ip });
  if (!s) return { error: { code: 'BAD_OTP', message: 'Invalid or expired code', retryable: false } };
  observability.track('auth.verified', { channel });
  return { data: s };
});
// Login button pre-check: normalised identity -> existence only (constant-time body).
app.post('/v1/auth/account-exists', async (req, reply) => {
  const t0 = Date.now();
  try {
    const { identity } = z.object({ identity: z.string() }).parse(req.body);
    const r = await identityService.accountExists(identity);
    observability.track('auth.account_checked', { channel: r.channel, exists: r.exists });
    await new Promise((res) => setTimeout(res, Math.max(0, 300 - (Date.now() - t0))));
    return { data: r };
  } catch {
    await new Promise((res) => setTimeout(res, Math.max(0, 300 - (Date.now() - t0))));
    return fail(reply, 'BAD_IDENTITY', 'Enter a valid phone number or email address.');
  }
});
// Google SSO (in-app browser now, native SDK later — same endpoint either way).
app.post('/v1/auth/google', async (req, reply) => {
  const { idToken, device } = z.object({
    idToken: z.string(),
    device: z.object({
      fp: z.string().optional(), platform: z.string().optional(), model: z.string().optional(),
      os: z.string().optional(), appVersion: z.string().optional(), city: z.string().optional(),
    }).optional(),
  }).parse(req.body);
  try {
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip;
    const s = await identityService.googleVerify(idToken, { ...device, ip });
    observability.track('auth.google_verified', { isNew: s.isNew });
    return { data: s };
  } catch (e: unknown) {
    const code = String((e as Error).message);
    if (['BAD_GOOGLE_TOKEN', 'BAD_GOOGLE_AUDIENCE', 'GOOGLE_TOKEN_EXPIRED', 'GOOGLE_UNVERIFIED'].includes(code)) {
      return fail(reply, 'GOOGLE_REJECTED', 'Google sign-in failed. Try again.', 401);
    }
    return fail(reply, 'GOOGLE_FAILED', 'Google sign-in unavailable. Try OTP instead.', 502, true);
  }
});
app.post('/v1/auth/refresh', async (req) => {
  const { refresh } = z.object({ refresh: z.string() }).parse(req.body);
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
app.post('/v1/properties/:id/assets', async (req) => {
  const { kind, brand } = z.object({ kind: z.string(), brand: z.string().optional() }).parse(req.body);
  return { data: await propertyService.addAsset((req.params as { id: string }).id, kind, brand) };
});
app.get('/v1/properties/:id/assets', async (req) => ({ data: await propertyService.assetsOf((req.params as { id: string }).id) }));

// ---------- catalog / pricing ----------
app.get('/v1/categories', async () => ({ data: await catalogService.categories() }));
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
      const candidates = await dispatchService.findCandidates({ serviceId: body.serviceId, lat: address.latitude, lng: address.longitude });
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

  const cands = await dispatchService.findCandidates({ serviceId: b.serviceId, lat, lng });
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
  const cands = await dispatchService.findCandidates({ serviceId: b.serviceId, lat: Number(addr[0].lat), lng: Number(addr[0].lng) });
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
app.post('/v1/quotes', async (req) => {
  const { bookingId, amountKobo, notes } = z.object({ bookingId: z.string(), amountKobo: z.string(), notes: z.string().optional() }).parse(req.body);
  return { data: await quoteService.propose(bookingId, { amountKobo: BigInt(amountKobo), providerNotes: notes }) };
});
app.post('/v1/quotes/:bookingId/accept', async (req) => {
  const { version } = z.object({ version: z.number() }).parse(req.body);
  return { data: await quoteService.accept((req.params as { bookingId: string }).bookingId, version) };
});

// ---------- payments (Bachs primary, Flutterwave fallback) ----------
app.post('/v1/bookings/:id/payments', async (req, reply) => {
  const idem = req.headers['idempotency-key'];
  if (typeof idem !== 'string') return fail(reply, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key header required');
  const { amountKobo, email } = z.object({ amountKobo: z.string(), email: z.string().email() }).parse(req.body);
  try {
    const session = await payments.createCheckout({
      bookingId: (req.params as { id: string }).id, amountKobo: BigInt(amountKobo),
      customerEmail: email, reference: `bk_${(req.params as { id: string }).id}_${idem.slice(0, 24)}`, idempotencyKey: idem,
    });
    observability.track('booking.payment_initiated', { psp: session.psp });
    return { data: session };
  } catch (e: unknown) { observability.captureException(e); return fail(reply, 'PSP_UNAVAILABLE', 'Provider unavailable', 502, true); }
});
import fastifyRawBody from 'fastify-raw-body';
void app.register(fastifyRawBody, { global: false });

for (const psp of ['bachs', 'flutterwave'] as const) {
  app.post(`/webhooks/payments/${psp}`, { config: { rawBody: true } }, async (req, reply) => {
    try {
      const raw = Buffer.from((req as unknown as { rawBody?: string }).rawBody || JSON.stringify(req.body ?? {}));
      const result = await payments.handleWebhook(psp, raw, req.headers as Record<string, string>);
      if (!result.ok) return fail(reply, 'BAD_SIGNATURE', 'Invalid webhook signature', 401);
      if (result.notFound) return fail(reply, 'UNKNOWN_CHARGE', 'Charge not found', 404);
      if (result.amountMismatch) {
        observability.captureMessage?.(`webhook.amount_mismatch psp=${psp}`);
        return fail(reply, 'AMOUNT_MISMATCH', 'Amount does not match recorded payment', 409);
      }
      if (result.verified?.status === 'successful') {
        if (result.verified.reference.startsWith('wt_')) {
          const userId = result.verified.reference.split('_')[1];
          try { await walletService.credit(userId, Number(result.verified.amountKobo), result.verified.reference, 'topup'); } catch (e) { observability.captureException(e); }
          observability.track('wallet.topup_succeeded', { psp, reference: result.verified.reference });
        } else {
          try { await postCollection(result.verified.reference, result.verified.amountKobo, '2026-10'); } catch (e) { observability.captureException(e); }
          observability.track('booking.payment_succeeded', { psp, reference: result.verified.reference });
        }
      }
      return { ok: true };
    } catch (e) {
      observability.captureException(e);
      app.log.error({ err: e, psp }, 'webhook processing failed');
      return fail(reply, 'WEBHOOK_ERROR', 'Webhook processing failed', 500);
    }
  });
}
app.post('/v1/refunds', async (req) => {
  const { bookingId, amountKobo, reason } = z.object({ bookingId: z.string(), amountKobo: z.string(), reason: z.string() }).parse(req.body);
  return { data: await refundService.request(bookingId, BigInt(amountKobo), reason) };
});

// ---------- wallet (minimal per-user ledger; mock-gateway topups) ----------
// NOTE: payment webhooks and POST /v1/refunds are NOT hooked into the wallet:
// webhooks carry no authenticated user (booking->user attribution + double-spend
// semantics need a wallet design pass), and /v1/refunds is unauthenticated.
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
  const ref = `wt_${a.sub}_${idem.slice(0, 16)}`;
  try {
    const session = await payments.createCheckout({
      bookingId: 'wallet_topup', amountKobo: BigInt(parsed.data.amountKobo),
      customerEmail: user?.email || 'user@kendibo.com', reference: ref, idempotencyKey: idem,
    });
    observability.track('wallet.topup_initiated', { psp: session.psp });
    return { data: session };
  } catch (e: unknown) { observability.captureException(e); return fail(reply, 'PSP_UNAVAILABLE', 'Provider unavailable', 502, true); }
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
app.post('/v1/provider/kyc', async (req) => {
  const { providerId, nin, bvn } = z.object({ providerId: z.string(), nin: z.string().optional(), bvn: z.string().optional() }).parse(req.body);
  return { data: await kycService.adapter.verifyIdentity(providerId, { nin, bvn }) };
});
app.post('/v1/provider/skills', async (req) => {
  const { providerId, skill } = z.object({ providerId: z.string(), skill: z.string() }).parse(req.body);
  return { data: await providerService.addSkill(providerId, skill) };
});
app.post('/v1/provider/online', async (req) => {
  const { providerId, online, lat, lng } = z.object({ providerId: z.string(), online: z.boolean(), lat: z.number().optional(), lng: z.number().optional() }).parse(req.body);
  return { data: await providerService.setOnline(providerId, online, lat, lng) };
});
app.get('/v1/provider/offers', async (req) => ({ data: await providerService.offersFor((req.query as { providerId: string }).providerId) }));
app.post('/v1/provider/offers/:id/respond', async (req, reply) => {
  const { accept } = z.object({ accept: z.boolean() }).parse(req.body);
  let result: Record<string, unknown>;
  try {
    result = (await providerService.respondToOffer((req.params as { id: string }).id, accept)) as Record<string, unknown>;
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
app.post('/v1/provider/sync', async (req) => {
  const { commands } = z.object({ commands: z.array(z.object({ clientEventId: z.string(), command: z.string(), jobId: z.string() })) }).parse(req.body);
  return { data: { results: await providerService.sync(commands) } };
});
app.post('/v1/provider/location', async (req) => {
  const { providerId, lat, lng } = z.object({ providerId: z.string(), lat: z.number(), lng: z.number() }).parse(req.body);
  return { data: await providerService.updateLocation(providerId, lat, lng) };
});
app.get('/v1/dispatch/candidates', async (req) => {
  const q = req.query as { serviceId: string; lat: string; lng: string };
  return { data: await dispatchService.findCandidates({ serviceId: q.serviceId, lat: Number(q.lat), lng: Number(q.lng) }) };
});
app.post('/v1/dispatch/assign', async (req, reply) => {
  const a = authed(req as never);
  if (!a || !authorize('DISPATCHER', 'booking:override')) return fail(reply, 'FORBIDDEN', 'Dispatcher role required', 403);
  const { jobId, providerId } = z.object({ jobId: z.string(), providerId: z.string() }).parse(req.body);
  return { data: await dispatchService.assign(jobId, providerId) };
});
app.post('/v1/jobs/:id/transition', async (req, reply) => {
  const { from, to, actor } = z.object({ from: z.string(), to: z.string(), actor: z.string().optional() }).parse(req.body);
  try { return await transition((req.params as { id: string }).id, from as JobStatus, to as JobStatus, actor ?? 'system'); }
  catch (e: unknown) { return fail(reply, 'ILLEGAL_TRANSITION', (e as Error).message, 409); }
});
app.post('/v1/jobs/:id/settle', async (req) => {
  const { totalKobo, providerKobo } = z.object({ totalKobo: z.string(), providerKobo: z.string() }).parse(req.body);
  const j = await postSettlement(`settle_${(req.params as { id: string }).id}`, BigInt(totalKobo), BigInt(providerKobo), '2026-10');
  const tb = await trialBalance();
  return { data: { balanced: tb.balanced, journal: j.reference } };
});
app.get('/v1/bookings/:id/eta', async (req, reply) => {
  const b = await bookingService.get((req.params as { id: string }).id);
  if (!b) return fail(reply, 'NOT_FOUND', 'Booking not found', 404);
  const minutes = await geoService.etaMinutes(b.id, b.addressId);
  return { data: { minutes } };
});

// ---------- messaging / notifications / media ----------
app.get('/v1/jobs/:id/messages', async (req) => ({ data: await messagingService.list((req.params as { id: string }).id) }));
app.post('/v1/jobs/:id/messages', async (req) => {
  const { from, body } = z.object({ from: z.string(), body: z.string() }).parse(req.body);
  return { data: await messagingService.send((req.params as { id: string }).id, from, body) };
});
app.post('/v1/notify', async (req, reply) => {
  const { template, to, vars } = z.object({ template: z.enum(TEMPLATES as unknown as [string, ...string[]]), to: z.object({ push: z.string().optional(), phone: z.string().optional() }), vars: z.record(z.string(), z.string()).optional() }).parse(req.body);
  return await notificationService.dispatch(template as (typeof TEMPLATES)[number], to, vars as Record<string, string>);
});
app.post('/v1/media/presign', async (req) => {
  const { kind } = z.object({ kind: z.enum(['avatar', 'photo', 'video', 'doc']) }).parse(req.body);
  return { data: await mediaService.presign(kind) };
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
    const { assetId } = await mediaService.presign(kind);
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
app.post('/v1/payouts', async (req, reply) => {
  const a = authed(req as never);
  if (!a || !authorize('FINANCE', 'payout:approve')) return fail(reply, 'FORBIDDEN', 'Finance approval required', 403);
  const { providerId, amountKobo, reference } = z.object({ providerId: z.string(), amountKobo: z.string(), reference: z.string() }).parse(req.body);
  try { return { data: await payoutService.create(providerId, BigInt(amountKobo), reference) }; }
  catch (e: unknown) { return fail(reply, 'PAYOUT_BLOCKED', (e as Error).message, 409); }
});
app.post('/v1/disputes', async (req, reply) => {
  try {
    const { bookingId, raisedBy, reason, description } = z.object({ bookingId: z.string(), raisedBy: z.enum(['customer', 'provider']), reason: z.string(), description: z.string().optional() }).parse(req.body);
    return { data: await disputeService.open(bookingId, raisedBy, reason, description) };
  } catch (e: unknown) { return fail(reply, 'BAD_DISPUTE', (e as Error).message); }
});
app.post('/v1/warranties', async (req) => {
  const { bookingId, days } = z.object({ bookingId: z.string(), days: z.number() }).parse(req.body);
  return { data: await fullWarranty.activate(bookingId, days) };
});
app.post('/v1/reviews', async (req, reply) => {
  try {
    const { bookingId, rating, tags, comment } = z.object({ bookingId: z.string(), rating: z.number(), tags: z.array(z.string()), comment: z.string().optional() }).parse(req.body);
    return { data: await reviewService.add(bookingId, { provider: rating, quality: rating, punctuality: rating, professionalism: rating, result: rating }, tags, comment) };
  } catch { return fail(reply, 'BAD_RATING', 'Rating 1-5 required'); }
});

// ---------- admin (audited) ----------
app.get('/v1/admin/dispatch/live', async (req, reply) => {
  const a = authed(req as never);
  if (!a || !authorize('OPERATIONS', 'booking:view:any')) return fail(reply, 'FORBIDDEN', 'Operations required', 403);
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
app.delete('/v1/me', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  return { data: await identityService.deactivate(a.sub) };
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
app.get('/v1/bookings/:id/reschedules', async (req) => ({ data: await rescheduleHistory((req.params as { id: string }).id) }));
app.post('/v1/bookings/:id/confirm', async (req, reply) => {
  try { return { data: await bookingService.setStatus((req.params as { id: string }).id, 'CONFIRMED', 'customer') }; }
  catch (e: unknown) { return fail(reply, 'ILLEGAL_TRANSITION', (e as Error).message, 409); }
});
app.post('/v1/bookings/:id/fail', async (req) => {
  const { code } = z.object({ code: z.string() }).parse(req.body);
  const a = authed(req as never);
  return { data: await markFailed((req.params as { id: string }).id, code as never, a?.sub ?? 'ops') };
});
app.get('/v1/bookings/:id/cancel-quote', async (req) => {
  const b = await bookingService.get((req.params as { id: string }).id);
  if (!b) return { error: { code: 'NOT_FOUND', message: 'Missing', retryable: false } };
  return { data: evaluateCancellation(b.status) };
});
// ---- USER APP: quote-requests + approve/reject + change orders (PRD §23-25) ----
app.post('/v1/quote-requests', async (req) => {
  const { bookingId, issueSummary, attachments } = z.object({ bookingId: z.string(), issueSummary: z.string(), attachments: z.array(z.string()).optional() }).parse(req.body);
  const q = await quoteService.propose(bookingId, { issueSummary, attachments });
  try { await bookingService.setStatus(bookingId, 'QUOTE_PENDING', 'customer'); } catch { /* already there */ }
  return { data: q };
});
app.get('/v1/quotes/:bookingId', async (req) => ({ data: await quoteService.revisions((req.params as { bookingId: string }).bookingId) }));
app.post('/v1/quotes/:bookingId/approve', async (req, reply) => {
  try {
    const { version } = z.object({ version: z.number() }).parse(req.body);
    const q = await quoteService.accept((req.params as { bookingId: string }).bookingId, version);
    observability.track('quote.approved', analyticProps({ bookingId: (req.params as { bookingId: string }).bookingId }));
    return { data: q };
  } catch (e: unknown) { return fail(reply, 'QUOTE_GONE', (e as Error).message, 409); }
});
app.post('/v1/quotes/:bookingId/change-orders', async (req) => {
  const { quoteId, reason, amountKobo, evidence } = z.object({ quoteId: z.string(), reason: z.string(), amountKobo: z.string(), evidence: z.array(z.string()).optional() }).parse(req.body);
  return { data: await quoteService.requestChange((req.params as { bookingId: string }).bookingId, quoteId, reason, BigInt(amountKobo), evidence) };
});
app.post('/v1/change-orders/:id/approve', async (req) => {
  const { approve, approver } = z.object({ approve: z.boolean(), approver: z.string() }).parse(req.body);
  return { data: await quoteService.decideChange((req.params as { id: string }).id, approve, approver) };
});
app.get('/v1/payments/:reference', async (req, reply) => {
  const rows = await q<Record<string, unknown>>(`SELECT * FROM payment.payment WHERE reference=$1`, [(req.params as { reference: string }).reference]);
  const p = rows[0];
  if (!p) return fail(reply, 'NOT_FOUND', 'Payment not found', 404);
  return { data: { reference: String(p.reference), psp: String(p.psp), amountKobo: String(p.amount_kobo), currency: 'NGN', status: String(p.status) } };
});
app.post('/v1/payments/:reference/verify', async (req, reply) => {
  const ref = (req.params as { reference: string }).reference;
  const rows = await q<Record<string, unknown>>(`SELECT * FROM payment.payment WHERE reference=$1`, [ref]);
  const p = rows[0];
  if (!p) return fail(reply, 'NOT_FOUND', 'Payment not found', 404);
  try {
    const v = await payments.verify(String(p.psp) as never, String(p.charge_id || ref));
    return { data: { ...v, amountKobo: String(v.amountKobo) } };
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
app.get('/v1/provider/kyc/status', async (req) => {
  const query = req.query as { providerId?: string };
  if (!query.providerId) return { error: { code: 'BAD_REQUEST', message: 'providerId required', retryable: false } };
  return { data: { ...(await kycService.status(query.providerId)), provider: kycService.activeProvider } };
});
// ---- ON-DEMAND service requests (Bolt-style broadcast + accept) ----
app.post('/v1/service-requests', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const idem = req.headers['idempotency-key'];
  if (typeof idem !== 'string') return fail(reply, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key header required');
  const body = z.object({
    serviceId: z.string().optional(), title: z.string(), details: z.string().optional(),
    urgency: z.enum(['emergency', 'today', 'this_week']).optional(),
    addressId: z.string().optional(), lat: z.number().optional(), lng: z.number().optional(),
    contactName: z.string().optional(), contactPhone: z.string().optional(), contactEmail: z.string().optional(),
    notes: z.string().optional(), smsUpdates: z.boolean().optional(),
    scheduledDate: z.string().optional(), timeWindow: z.string().optional(),
  }).parse(req.body);
  return { data: await requestService.create(a.sub, { ...body, idempotencyKey: idem }) };
});
app.get('/v1/service-requests', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  return { data: await requestService.list(a.sub) };
});
app.get('/v1/service-requests/:id', async (req, reply) => {
  const a = authed(req as never);
  try { return { data: await requestService.get((req.params as { id: string }).id, a?.sub) }; }
  catch { return fail(reply, 'FORBIDDEN', 'Not your request', 403); }
});
app.get('/v1/service-requests/:id/matches', async (req) => {
  return { data: await requestService.matches((req.params as { id: string }).id) };
});
app.post('/v1/service-requests/:id/broadcast', async (req, reply) => {
  const a = authed(req as never);
  if (!a || !authorize('DISPATCHER', 'booking:override')) return fail(reply, 'FORBIDDEN', 'Dispatcher required', 403);
  const { limit } = z.object({ limit: z.number().optional() }).parse(req.body ?? {});
  auditService.log(a.sub, `request.${(req.params as { id: string }).id}.broadcast`);
  return { data: await requestService.broadcast((req.params as { id: string }).id, limit ?? 5) };
});
app.post('/v1/service-requests/:id/cancel', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  try { return { data: await requestService.cancel((req.params as { id: string }).id, a.sub) }; }
  catch { return fail(reply, 'CANCEL_BLOCKED', 'Request can no longer be cancelled', 409); }
});
app.post('/v1/service-requests/:id/convert', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  try { return { data: await requestService.convert((req.params as { id: string }).id, a.sub) }; }
  catch (e: unknown) { return fail(reply, 'CONVERT_BLOCKED', (e as Error).message, 409); }
});
app.get('/v1/provider/requests', async (req, reply) => {
  const providerId = (req.query as { providerId?: string }).providerId;
  if (!providerId) return fail(reply, 'BAD_REQUEST', 'providerId required');
  return { data: await requestService.incoming(providerId) };
});
app.get('/v1/provider/bookings', async (req, reply) => {
  const providerId = (req.query as { providerId?: string }).providerId;
  if (!providerId) return fail(reply, 'BAD_REQUEST', 'providerId required');
  return { data: await bookingService.listForProvider(providerId) };
});
app.post('/v1/provider/requests/:id/respond', async (req, reply) => {
  const { accept } = z.object({ accept: z.boolean() }).parse(req.body);
  try { return { data: await requestService.respondOffer((req.params as { id: string }).id, accept) }; }
  catch (e: unknown) { return fail(reply, 'OFFER_GONE', (e as Error).message, 409); }
});
// ---- USER APP: warranty claims + property history/reminders/recurring ----
app.get('/v1/jobs/:id/warranty', async (req) => ({ data: await fullWarranty.getWarranty((req.params as { id: string }).id) }));
app.post('/v1/warranties/:id/claims', async (req, reply) => {
  try {
    const { reason, description, evidence } = z.object({ reason: z.string(), description: z.string(), evidence: z.array(z.string()).optional() }).parse(req.body);
    return { data: await fullWarranty.claim((req.params as { id: string }).id, reason, description, evidence) };
  } catch (e: unknown) { return fail(reply, 'WARRANTY_GONE', (e as Error).message, 409); }
});
app.get('/v1/warranty-claims/:id', async (req) => ({ data: await fullWarranty.getClaim((req.params as { id: string }).id) }));
app.get('/v1/properties/:id/history', async (req) => ({ data: await historyService.timeline((req.params as { id: string }).id) }));
app.get('/v1/properties/:id/reminders', async (req) => ({ data: await reminderService.due((req.params as { id: string }).id) }));
app.post('/v1/recurring', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const body = z.object({ propertyId: z.string(), serviceId: z.string(), frequency: z.enum(['weekly', 'biweekly', 'monthly', 'quarterly']), startDate: z.string(), endDate: z.string().optional(), timeWindow: z.string(), paymentMethod: z.string() }).parse(req.body);
  return { data: await recurringService.create(a.sub, body) };
});
// ---- USER APP: support tickets ----
app.post('/v1/support/tickets', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const { reason, jobId } = z.object({ reason: z.string(), jobId: z.string().optional() }).parse(req.body);
  return { data: await supportService.open(a.sub, reason, jobId) };
});
app.get('/v1/support/tickets', async (req) => ({ data: await supportService.list((req.query as { cursor?: string }).cursor) }));
app.post('/v1/support/tickets/:id/messages', async (req) => {
  const { from, body } = z.object({ from: z.string(), body: z.string() }).parse(req.body);
  return { data: await supportService.message((req.params as { id: string }).id, from, body) };
});
app.get('/v1/cities', async () => ({ data: await cityService.list() }));

// ---- PROVIDER/B2B APP: job execution (PRD App C) ----
for (const step of [['accept', 'PROVIDER_ACCEPTED'], ['arrive', 'ARRIVED'], ['start', 'IN_PROGRESS'], ['complete', 'COMPLETED']] as const) {
  app.post(`/v1/provider/jobs/:id/${step[0]}`, async (req, reply) => {
    const { from, actor } = z.object({ from: z.string(), actor: z.string().optional() }).parse(req.body ?? {});
    try { return await transition((req.params as { id: string }).id, from as JobStatus, step[1] as JobStatus, actor ?? 'provider'); }
    catch (e: unknown) { return fail(reply, 'ILLEGAL_TRANSITION', (e as Error).message, 409); }
  });
}
app.post('/v1/provider/jobs/:id/decline', async (req) => {
  const { offerId } = z.object({ offerId: z.string() }).parse(req.body);
  return { data: await providerService.respondToOffer(offerId, false) };
});
app.post('/v1/provider/jobs/:id/evidence', async (req, reply) => {
  const { kind } = z.object({ kind: z.enum(['avatar', 'photo', 'video', 'doc']) }).parse(req.body);
  return { data: await mediaService.presign(kind) };
});
app.post('/v1/provider/jobs/:id/quote', async (req) => {
  const { amountKobo, diagnosis } = z.object({ amountKobo: z.string(), diagnosis: z.string().optional() }).parse(req.body);
  return { data: await quoteService.propose((req.params as { id: string }).id, { amountKobo: BigInt(amountKobo), diagnosis }) };
});
app.get('/v1/provider/earnings', async (req) => ({ data: earningsService.forProvider((req.query as { providerId: string }).providerId) }));
app.get('/v1/provider/payouts', async (req) => ({ data: await payoutService.get((req.query as { id: string }).id) }));
app.post('/v1/provider/verify-level', async (req, reply) => {
  const a = authed(req as never);
  if (!a || !authorize('TRUST_SAFETY', 'provider:verify')) return fail(reply, 'FORBIDDEN', 'Trust & Safety required', 403);
  const { providerId, level } = z.object({ providerId: z.string(), level: z.string() }).parse(req.body);
  const v = await verificationService.set(providerId, level as never);
  await auditService.log(a.sub, `provider.${providerId}.level=${level}`);
  return { data: v };
});
app.get('/v1/checklists/:category', async (req) => ({ data: await checklistService.forCategory((req.params as { category: string }).category) }));
app.post('/v1/emergency', async (req) => {
  const { jobId, kind } = z.object({ jobId: z.string(), kind: z.string() }).parse(req.body);
  return { data: await emergencyService.create(jobId, kind) };
});
// ---- PROVIDER/B2B APP: B2B work orders ----
app.post('/v1/b2b/organisations', async (req) => {
  const { name, type } = z.object({ name: z.string(), type: z.string() }).parse(req.body);
  return { data: await b2bService.createOrg(name, type) };
});
app.post('/v1/b2b/work-orders', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  const { orgId, propertyId, title, amountKobo } = z.object({ orgId: z.string(), propertyId: z.string(), title: z.string(), amountKobo: z.string() }).parse(req.body);
  const role = await b2bService.memberRole(orgId, a.sub);
  if (!role) return fail(reply, 'FORBIDDEN', 'Not an org member', 403);
  return { data: await b2bService.createWorkOrder(orgId, propertyId, title, BigInt(amountKobo)) };
});
app.get('/v1/b2b/work-orders', async (req) => ({ data: await b2bService.list((req.query as { orgId: string }).orgId) }));
app.post('/v1/b2b/work-orders/:id/approve', async (req, reply) => {
  const { role, by } = z.object({ role: z.string(), by: z.string() }).parse(req.body);
  try { return { data: await b2bService.approve((req.params as { id: string }).id, role, by) }; }
  catch (e: unknown) { return fail(reply, 'APPROVAL_BLOCKED', (e as Error).message, 409); }
});
app.post('/v1/b2b/invoices', async (req) => {
  const { orgId, workOrderId } = z.object({ orgId: z.string(), workOrderId: z.string() }).parse(req.body);
  return { data: await b2bService.invoice(orgId, workOrderId) };
});
app.get('/v1/b2b/reports', async (req) => ({ data: await b2bService.report((req.query as { orgId: string }).orgId) }));

// ---- ADMIN CONSOLE: full ops (PRD §54 + App C) ----
app.get('/v1/admin/jobs', async (req, reply) => {
  const a = authed(req as never);
  if (!a || !authorize('OPERATIONS', 'booking:view:any')) return fail(reply, 'FORBIDDEN', 'Operations required', 403);
  return { data: await bookingService.list((req.query as { userId?: string }).userId ?? '') };
});
app.post('/v1/admin/jobs/:id/assign', async (req, reply) => {
  const a = authed(req as never);
  if (!a || !authorize('DISPATCHER', 'booking:override')) return fail(reply, 'FORBIDDEN', 'Dispatcher required', 403);
  const { providerId } = z.object({ providerId: z.string() }).parse(req.body);
  await auditService.log(a.sub, `job.${(req.params as { id: string }).id}.assign=${providerId}`);
  return { data: await dispatchService.assign((req.params as { id: string }).id, providerId) };
});
app.post('/v1/admin/jobs/:id/flag', async (req, reply) => {
  const a = authed(req as never);
  if (!a || !authorize('OPERATIONS', 'booking:override')) return fail(reply, 'FORBIDDEN', 'Operations required', 403);
  const { flag: f, reason } = z.object({ flag: z.string(), reason: z.string().optional() }).parse(req.body);
  await auditService.log(a.sub, `job.${(req.params as { id: string }).id}.flag=${f}`);
  return { data: await flagJob((req.params as { id: string }).id, f as never, a.sub, reason) };
});
app.get('/v1/admin/jobs/:id/flags', async (req) => ({ data: await flagsOf((req.params as { id: string }).id) }));
app.post('/v1/admin/providers/:id/approve', async (req, reply) => {
  const a = authed(req as never);
  if (!a || !authorize('TRUST_SAFETY', 'provider:verify')) return fail(reply, 'FORBIDDEN', 'Trust & Safety required', 403);
  await auditService.log(a.sub, `provider.${(req.params as { id: string }).id}.approve`);
  await providerService.verifyKyc((req.params as { id: string }).id);
  return { data: await verificationService.set((req.params as { id: string }).id, 'verified') };
});
app.post('/v1/admin/providers/:id/suspend', async (req, reply) => {
  const a = authed(req as never);
  if (!a || !authorize('TRUST_SAFETY', 'provider:suspend')) return fail(reply, 'FORBIDDEN', 'Trust & Safety required', 403);
  const mc = await makerChecker.submit('suspension', (req.params as { id: string }).id, a.sub);
  await auditService.log(a.sub, `provider.${(req.params as { id: string }).id}.suspend.queued=${mc.id}`);
  const v = await verificationService.set((req.params as { id: string }).id, 'suspended');
  return { data: { ...v, checkerId: mc.id } };
});
app.get('/v1/admin/disputes', async (req, reply) => {
  const a = authed(req as never);
  if (!a || !authorize('CUSTOMER_SUPPORT', 'booking:view:any')) return fail(reply, 'FORBIDDEN', 'Support required', 403);
  return { data: await disputeService.get((req.query as { id: string }).id) };
});
app.post('/v1/admin/refunds', async (req, reply) => {
  const a = authed(req as never);
  if (!a || !authorize('FINANCE', 'payment:refund')) return fail(reply, 'FORBIDDEN', 'Finance required', 403);
  const { id, status } = z.object({ id: z.string(), status: z.string() }).parse(req.body);
  const mc = await makerChecker.submit('refund', id, a.sub);
  await auditService.log(a.sub, `refund.${id}=${status} checker=${mc.id}`);
  return { data: await refundService.mark(id, status as never) };
});
app.get('/v1/admin/ledger', async (req, reply) => {
  const a = authed(req as never);
  if (!a || !authorize('FINANCE', 'ledger:view')) return fail(reply, 'FORBIDDEN', 'Finance required', 403);
  return { data: await trialBalance() };
});
app.get('/v1/admin/checker', async (req, reply) => {
  const a = authed(req as never);
  if (!a || !authorize('FINANCE', 'payout:approve')) return fail(reply, 'FORBIDDEN', 'Finance required', 403);
  return { data: makerChecker.pending() };
});
app.get('/v1/admin/analytics', async (req, reply) => {
  const a = authed(req as never);
  if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  return { data: analyticProps({ surface: 'admin' }) };
});
app.get('/v1/admin/audit', async (req, reply) => {
  const a = authed(req as never);
  if (!a || !authorize('TRUST_SAFETY', 'audit:view')) return fail(reply, 'FORBIDDEN', 'Audit view required', 403);
  return { data: await auditService.list() };
});
app.post('/v1/admin/flags', async (req, reply) => {
  const a = authed(req as never);
  if (!a || !authorize('SUPER_ADMIN', 'configuration:edit')) return fail(reply, 'FORBIDDEN', 'Super admin required', 403);
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
    surfaces: ['user_app', 'provider_b2b_app', 'admin_console'],
  },
}));
// Blueprint §14 device sessions (push targets for channel router).
app.post('/v1/devices', async (req) => {
  const { userId, platform, pushToken, channel } = z.object({ userId: z.string(), platform: z.enum(['android', 'ios', 'web']), pushToken: z.string(), channel: z.string().optional() }).parse(req.body);
  return { data: await deviceService.register(userId, platform, pushToken, channel) };
});
app.delete('/v1/devices/:id', async (req) => ({ data: { removed: await deviceService.remove((req.params as { id: string }).id) } }));
app.get('/v1/me/sessions', async (req, reply) => {
  const a = authed(req as never); if (!a) return fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
  return { data: await deviceService.sessionsFor(a.sub) };
});
// Throttled batch ingest from the Android tracker hook.
app.post('/v1/provider/location/batch', async (req, reply) => {
  try {
    const { providerId, points } = z.object({ providerId: z.string(), points: z.array(z.object({ lat: z.number(), lng: z.number(), at: z.string() })) }).parse(req.body);
    return { data: await geoService.ingestBatch(providerId, points) };
  } catch (e: unknown) { return fail(reply, 'BAD_BATCH', (e as Error).message); }
});
// Media ingest writes through the object store (quarantine -> promote).
// Preferred mobile flow is direct PUT to the presigned uploadUrl.
app.post('/v1/media/:id/ingest', async (req, reply) => {
  try {
    const { dataBase64, mime } = z.object({ dataBase64: z.string(), mime: z.string() }).parse(req.body);
    const bytes = Buffer.from(dataBase64, 'base64');
    if (bytes.length === 0) return fail(reply, 'EMPTY_UPLOAD', 'No bytes received');
    return { data: await mediaService.ingest((req.params as { id: string }).id, bytes, mime) };
  } catch (e: unknown) { return fail(reply, 'INGEST_FAILED', (e as Error).message); }
});
// Signed file delivery. Local driver serves bytes; s3 driver redirects to the
// bucket-signed URL (Pxxl CDN Storage / R2 / MinIO).
app.get('/v1/media/:id/file', async (req, reply) => {
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
if (process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test') {
  // Hybrid dispatch SLA sweep: expire overdue offers and escalate to the next
  // eligible candidate (or fall through to customer-pick) every 60s.
  const sweepTimer = setInterval(() => { void dispatchSweep(); }, 60_000);
  sweepTimer.unref?.();
  app.listen({ port, host: '0.0.0.0' }).then(() => {
    const w = watchupClient as unknown as { enabled: boolean; environment: string; release: string };
    app.log.info(`kendibo-api :${port} (bachs primary, flutterwave fallback)`);
    app.log.info(`watchup: ${w.enabled ? `enabled env=${w.environment} release=${w.release}` : 'disabled (no WATCHUP_API_KEY)'}`);
    if (w.enabled) observability.track('deploy.boot', { port, env: w.environment, release: w.release });
  });
}
export { app };
export { fraudService };
