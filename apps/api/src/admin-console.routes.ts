// Admin console API: user & provider management, category catalogue
// management, admin 2FA (TOTP) and admin login protection, audit trail.
//
// Access: ADMIN_CONSOLE_POLICY is merged into the deny-by-default gate in
// main.ts (admin seat + named permission, role read from identity.users).
// Routes not in the map still need an admin seat (every /v1/admin/* does);
// user list/detail accept any of booking:view:any | provider:verify |
// provider:suspend (support, ops and trust & safety all look people up).
// The 2FA routes need only an admin seat. Every mutating call writes audit.log
// with actor, action, entity, reason, ip and user agent.
//
// accountGate() runs from the main.ts onRequest hook for every authenticated
// request: suspended accounts get 403 ACCOUNT_SUSPENDED, tokens issued before
// an admin "sign out" get 401 SESSION_REVOKED, and admin requests are checked
// for idle timeout (ADMIN_IDLE_TIMEOUT_MIN, default 30) and 2FA
// (ADMIN_2FA_REQUIRED=true forces enrollment; default false).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ADMIN_ROLES, adminCan, isAdminRole, type Permission } from '../../../modules/authorization/rbac.js';
import { q } from '../../../packages/database/db.js';
import { revokeAll, refreshSubject, verifyAccess, type AccessClaims } from '../../../packages/auth/auth.js';
import { auditService, type AuditContext } from '../../../modules/audit/audit.service.js';
import { identityService } from '../../../modules/identity/identity.service.js';
import {
  adminTwoFactor, adminLoginChallenge, adminLoginLock, adminSessions, lockKeys, adminTwoFactorRequired,
} from '../../../modules/identity/admin-security.service.js';
import { walletService } from '../../../modules/wallet/wallet.service.js';
import { verificationService } from '../../../modules/providers/quality.service.js';
import { mergeCategory, slugify } from '../../../modules/vendors/category-rules.service.js';
import { toKeywords } from '../../../modules/catalog/catalog.service.js';

export const ADMIN_CONSOLE_POLICY: Record<string, 'public' | Permission> = {
  'POST /v1/admin/login/2fa': 'public', // second factor; the challenge id is the credential
  'POST /v1/admin/users/:id/suspend': 'provider:suspend',
  'POST /v1/admin/users/:id/reactivate': 'provider:suspend',
  'POST /v1/admin/users/:id/signout': 'provider:suspend',
  'POST /v1/admin/users/:id/erase': 'configuration:edit',
  'POST /v1/admin/providers/:id/reactivate': 'provider:suspend',
  'POST /v1/admin/providers/:id/revoke-verification': 'provider:verify',
  'GET /v1/admin/categories': 'provider:verify',
  'POST /v1/admin/categories': 'configuration:edit',
  'PATCH /v1/admin/categories/:id': 'configuration:edit',
  'POST /v1/admin/categories/:id/disable': 'configuration:edit',
  'POST /v1/admin/categories/:id/enable': 'configuration:edit',
  'POST /v1/admin/categories/:id/merge': 'configuration:edit',
  'GET /v1/admin/category-groups': 'provider:verify',
  'POST /v1/admin/category-groups': 'configuration:edit',
  'PATCH /v1/admin/category-groups/:id': 'configuration:edit',
  'GET /v1/admin/audit': 'audit:view',
};
const USER_READ_PERMS: Permission[] = ['booking:view:any', 'provider:verify', 'provider:suspend'];

type Fail = (reply: FastifyReply, code: string, message: string, status?: number, retryable?: boolean) => unknown;
interface Helpers {
  fail: Fail;
  adminActor: (req: never) => Promise<{ sub: string; role: string } | { denied: true } | null>;
}

// ── request context ──────────────────────────────────────────────────────────
// req.ip honours trustProxy (on in production behind the edge), so a client
// can't pick its own address to dodge the per-IP lockout.
export function clientIp(req: { headers: Record<string, unknown>; ip?: string }): string | null {
  return req.ip || (String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim()) || null;
}
const reqCtx = (req: FastifyRequest, extra: AuditContext = {}): AuditContext => ({
  ip: clientIp(req as never), ua: req.headers['user-agent'] ? String(req.headers['user-agent']) : null, ...extra,
});
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── central account / admin-session gate (called from main.ts onRequest) ────
export interface GateFailure { code: string; message: string; status: number }
export async function accountGate(claims: AccessClaims, opts: { url: string; adminRoute: boolean }): Promise<GateFailure | null> {
  const rows = await q<{ role: string | null; status: string | null; sessions_revoked_at: string | null }>(
    `SELECT role, status, sessions_revoked_at FROM identity.users WHERE id=$1`, [claims.sub],
  ).catch(() => []);
  const u = rows[0];
  if (!u) return null; // unknown identity: the existing per-route checks answer
  if (String(u.status ?? '') === 'suspended') {
    return { code: 'ACCOUNT_SUSPENDED', message: 'This account is suspended. Contact Kendibo support.', status: 403 };
  }
  if (u.sessions_revoked_at) {
    const rv = u.sessions_revoked_at as unknown;
    const revokedMs = rv instanceof Date ? rv.getTime() : new Date(String(rv)).getTime(); // String(Date) drops ms
    // ts (ms) when present; otherwise the whole iat second counts as before.
    const issuedMs = claims.ts ?? (claims.iat != null ? claims.iat * 1000 + 999 : null);
    if (issuedMs != null && issuedMs <= revokedMs) return { code: 'SESSION_REVOKED', message: 'You were signed out. Sign in again.', status: 401 };
  }
  const role = String(u.role ?? '').toUpperCase();
  if (!opts.adminRoute || !isAdminRole(role)) return null;
  let mfa = false;
  if (claims.sid) {
    const s = await adminSessions.touch(claims.sub, claims.sid);
    if (s.state === 'idle') {
      await adminSessions.revokeSid(claims.sub, claims.sid);
      return { code: 'SESSION_IDLE_TIMEOUT', message: 'Signed out after inactivity. Sign in again.', status: 401 };
    }
    mfa = s.mfa;
  }
  if (opts.url.startsWith('/v1/admin/2fa/')) return null;
  const enabled = await adminTwoFactor.enabled(claims.sub);
  if (enabled && !mfa) return { code: 'TWO_FACTOR_REQUIRED', message: 'Sign in again with your authenticator code.', status: 403 };
  if (!enabled && adminTwoFactorRequired()) return { code: 'TWO_FACTOR_REQUIRED', message: 'Set up two-factor authentication (POST /v1/admin/2fa/enroll) to use the admin console.', status: 403 };
  return null;
}

/** Before rotating a refresh token: suspended accounts and idle admin sessions are refused. */
export async function refreshGate(token: string): Promise<GateFailure | null> {
  const subj = refreshSubject(token);
  if (!subj) return null; // rotateRefresh rejects it
  const rows = await q<{ role: string | null; status: string | null }>(`SELECT role, status FROM identity.users WHERE id=$1`, [subj.sub]).catch(() => []);
  if (!rows[0]) return null;
  if (String(rows[0].status ?? '') === 'suspended') return { code: 'ACCOUNT_SUSPENDED', message: 'This account is suspended. Contact Kendibo support.', status: 403 };
  if (isAdminRole(rows[0].role) && subj.deviceId && await adminSessions.idle(subj.sub, subj.deviceId)) {
    await adminSessions.revokeSid(subj.sub, subj.deviceId);
    return { code: 'SESSION_IDLE_TIMEOUT', message: 'Signed out after inactivity. Sign in again.', status: 401 };
  }
  return null;
}

// ── admin login protection (used by the OTP / Google routes in main.ts) ─────
export const adminLogin = {
  /** The admin user behind an OTP identity, or null when it is not an admin seat. */
  async target(channel: 'phone' | 'email', identity: string): Promise<string | null> {
    let norm;
    try { norm = identityService.normalizeIdentity(identity); } catch { return null; }
    if (norm.channel !== channel) return null;
    const rows = await q<{ id: string; role: string }>(`SELECT id, role FROM identity.users WHERE ${norm.channel === 'phone' ? 'phone' : 'email'}=$1`, [norm.value]);
    return rows[0] && isAdminRole(rows[0].role) ? String(rows[0].id) : null;
  },
  async retryAfter(adminId: string, ip: string | null) {
    return adminLoginLock.retryAfter(lockKeys(adminId, ip));
  },
  /** Failure: counted on the account and the IP; returns the lockout in seconds (0 = not locked). */
  async failed(adminId: string, factor: string, ctx: AuditContext) {
    const locked = await adminLoginLock.fail(lockKeys(adminId, ctx.ip ?? null));
    await auditService.log(adminId, 'admin.login.failed', adminId, { ...ctx, entityType: 'user', meta: { factor, lockedForSec: locked } });
    return locked;
  },
  async locked(adminId: string, retryAfter: number, ctx: AuditContext) {
    await auditService.log(adminId, 'admin.login.locked', adminId, { ...ctx, entityType: 'user', meta: { retryAfterSec: retryAfter } });
  },
  async succeeded(adminId: string, s: object, factor: string, ctx: AuditContext) {
    if ('twoFactorRequired' in s) {
      await auditService.log(adminId, 'admin.login.challenge', adminId, { ...ctx, entityType: 'user', meta: { factor } });
      return;
    }
    await adminLoginLock.clear(adminId);
    await auditService.log(adminId, 'admin.login.success', adminId, { ...ctx, entityType: 'user', meta: { factor } });
  },
};
export const sendLocked = (reply: FastifyReply, fail: Fail, retryAfter: number) => {
  void reply.header('Retry-After', String(retryAfter));
  return fail(reply, 'ADMIN_LOGIN_LOCKED', `Too many failed sign-in attempts. Try again in ${Math.ceil(retryAfter / 60)} minutes.`, 429, true);
};

// ── shapes ───────────────────────────────────────────────────────────────────
const consoleRole = (r: unknown) => {
  const role = String(r ?? 'CUSTOMER').toUpperCase();
  return isAdminRole(role) ? 'admin' : role === 'PROVIDER' ? 'provider' : 'customer';
};
const str = (v: unknown) => (v == null ? null : String(v));
const inList = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => `$${i + 1 + offset}`).join(',');

async function enrichUsers(rows: Record<string, unknown>[]) {
  const ids = rows.map((r) => String(r.id));
  if (!ids.length) return [];
  const providers = await q<Record<string, unknown>>(`SELECT id, user_id, kyc_status, online, kyc_tier, status, verify_level FROM provider.provider WHERE user_id IN (${inList(ids.length)})`, ids).catch(() => []);
  const kyc = await q<Record<string, unknown>>(`SELECT user_id, status FROM kyc.customer WHERE user_id IN (${inList(ids.length)})`, ids).catch(() => []);
  const seen = await q<{ user_id: string; last: string }>(`SELECT user_id, MAX(last_seen) AS last FROM identity.device_session WHERE user_id IN (${inList(ids.length)}) GROUP BY user_id`, ids).catch(() => []);
  const pBy = new Map(providers.map((p) => [String(p.user_id), p]));
  const kBy = new Map(kyc.map((k) => [String(k.user_id), k]));
  const sBy = new Map(seen.map((s) => [String(s.user_id), s.last]));
  return rows.map((r) => {
    const id = String(r.id);
    const p = pBy.get(id);
    const provider = p ? { id: String(p.id), kycStatus: String(p.kyc_status ?? 'PENDING'), online: p.online === true, verifiedTier: Number(p.kyc_tier ?? 0), status: str(p.status), verifyLevel: str(p.verify_level) } : null;
    return {
      id, name: str(r.name), email: str(r.email), phone: str(r.phone),
      role: consoleRole(r.role), adminRole: isAdminRole(String(r.role ?? '').toUpperCase()) ? String(r.role).toUpperCase() : null,
      status: String(r.status ?? 'active'), createdAt: String(r.created_at),
      lastSeenAt: sBy.get(id) ? String(sBy.get(id)) : null,
      kycStatus: provider ? provider.kycStatus : (kBy.get(id) ? String(kBy.get(id)!.status) : null),
      suspendedAt: str(r.suspended_at), suspendedReason: str(r.suspended_reason),
      provider,
    };
  });
}

const categorySchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,39}$/, 'id: lowercase letters, digits, - or _').optional(),
  name: z.string().trim().min(2).max(120),
  shortName: z.string().trim().min(1).max(24).optional(),
  description: z.string().trim().max(500).optional(),
  groupId: z.string().trim().min(1).max(60),
  kind: z.enum(['service', 'product']),
  iconName: z.string().trim().min(1).max(40).optional(),
  keywords: z.array(z.string().trim().min(1).max(60)).max(60).optional(),
  commissionBps: z.number().int().min(0).max(5000).optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
});
const groupSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,39}$/, 'id: lowercase letters, digits, - or _').optional(),
  name: z.string().trim().min(2).max(120),
  shortName: z.string().trim().min(1).max(40).optional(),
  kind: z.enum(['service', 'product']),
  iconName: z.string().trim().min(1).max(40).optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
});
const reasonSchema = z.object({ reason: z.string().trim().min(3).max(500) });
const optReasonSchema = z.object({ reason: z.string().trim().max(500).optional() });
const hyphenSlug = (s: string) => slugify(s).replace(/_/g, '-');

async function countBy(sql: string): Promise<Map<string, number>> {
  const rows = await q<{ k: string; n: string }>(sql).catch(() => []);
  return new Map(rows.map((r) => [String(r.k), Number(r.n)]));
}
async function categoryList(f: { kind?: string; group?: string; status?: string; id?: string } = {}) {
  const where: string[] = []; const vals: unknown[] = [];
  if (f.id) { vals.push(f.id); where.push(`c.id=$${vals.length}`); }
  if (f.kind) { vals.push(f.kind); where.push(`c.kind=$${vals.length}`); }
  if (f.group) { vals.push(f.group); where.push(`c.group_id=$${vals.length}`); }
  if (f.status === 'active') where.push('c.active = TRUE');
  if (f.status === 'inactive') where.push('c.active = FALSE');
  if (f.status === 'new') where.push('c.is_new = TRUE');
  const rows = await q<Record<string, unknown>>(
    `SELECT c.id, c.name, c.short_name, c.description, c.group_id, c.kind, c.icon_name, c.keywords, c.is_new, c.active, c.added_by_provider, c.sort_order, c.created_via
       FROM catalog.category c ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`, vals,
  );
  const groups = new Map((await q<{ id: string; name: string }>(`SELECT id, name FROM catalog.category_group`)).map((g) => [String(g.id), String(g.name)]));
  const offerings = await countBy(`SELECT category_id AS k, COUNT(*) AS n FROM provider.offering GROUP BY category_id`);
  const providers = await countBy(`SELECT category_id AS k, COUNT(*) AS n FROM provider.category_enrollment GROUP BY category_id`);
  const requests = await countBy(`SELECT category_id AS k, COUNT(*) AS n FROM booking.service_request GROUP BY category_id`);
  const rules = await countBy(`SELECT category_id AS k, commission_bps AS n FROM catalog.category_rule`);
  const out = rows.map((r) => {
    const id = String(r.id);
    return {
      id, name: String(r.name), shortName: String(r.short_name ?? r.name), description: str(r.description),
      groupId: str(r.group_id), groupName: r.group_id ? groups.get(String(r.group_id)) ?? null : null,
      kind: r.kind === 'product' ? 'product' : 'service', iconName: str(r.icon_name), keywords: toKeywords(r.keywords),
      isNew: r.is_new === true, active: r.active !== false, addedByProvider: str(r.added_by_provider),
      createdVia: str(r.created_via), sortOrder: Number(r.sort_order ?? 0),
      offeringsCount: offerings.get(id) ?? 0, providersCount: providers.get(id) ?? 0, requestsCount: requests.get(id) ?? 0,
      commissionBps: rules.get(id) ?? 1500,
    };
  });
  out.sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
  return out;
}
async function groupList(id?: string) {
  const rows = await q<Record<string, unknown>>(
    id ? `SELECT * FROM catalog.category_group WHERE id=$1` : `SELECT * FROM catalog.category_group`, id ? [id] : [],
  );
  const counts = await countBy(`SELECT group_id AS k, COUNT(*) AS n FROM catalog.category WHERE active GROUP BY group_id`);
  return rows.map((g) => ({
    id: String(g.id), name: String(g.name), shortName: str(g.short_name), kind: g.kind === 'product' ? 'product' : 'service',
    iconName: str(g.icon_name), sortOrder: Number(g.sort_order ?? 0), categoriesCount: counts.get(String(g.id)) ?? 0,
  })).sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
}

export function registerAdminConsoleRoutes(app: FastifyInstance, h: Helpers) {
  const actor = async (req: FastifyRequest) => {
    const a = await h.adminActor(req as never);
    return a && !('denied' in a) ? a : null;
  };

  // ── users ──────────────────────────────────────────────────────────────────
  app.get('/v1/admin/users', async (req, reply) => {
    const a = await actor(req);
    if (!a || !USER_READ_PERMS.some((p) => adminCan(a.role, p))) return h.fail(reply, 'FORBIDDEN', 'Insufficient permissions', 403);
    const f = z.object({
      q: z.string().trim().max(120).optional(),
      role: z.enum(['customer', 'provider', 'admin']).optional(),
      status: z.enum(['active', 'suspended', 'inactive', 'deleted']).optional(),
      limit: z.coerce.number().int().min(1).max(200).catch(50),
      offset: z.coerce.number().int().min(0).catch(0),
    }).parse(req.query ?? {});
    const where: string[] = []; const vals: unknown[] = [];
    if (f.q) {
      const like = `%${f.q.toLowerCase()}%`;
      vals.push(like);
      const ors = [`lower(COALESCE(name,'')) LIKE $${vals.length}`, `lower(COALESCE(email,'')) LIKE $${vals.length}`, `COALESCE(phone,'') LIKE $${vals.length}`];
      const digits = f.q.replace(/\D/g, '').replace(/^0/, '');
      if (digits.length >= 4) { vals.push(`%${digits}%`); ors.push(`COALESCE(phone,'') LIKE $${vals.length}`); }
      if (UUID_RE.test(f.q)) { vals.push(f.q); ors.push(`id=$${vals.length}`); }
      where.push(`(${ors.join(' OR ')})`);
    }
    if (f.role === 'customer') where.push(`upper(role)='CUSTOMER'`);
    if (f.role === 'provider') where.push(`upper(role)='PROVIDER'`);
    if (f.role === 'admin') where.push(`upper(role) IN (${ADMIN_ROLES.map((r) => `'${r}'`).join(',')})`);
    if (f.status) { vals.push(f.status); where.push(`status=$${vals.length}`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await q<{ n: string }>(`SELECT COUNT(*) AS n FROM identity.users ${w}`, vals);
    const rows = await q<Record<string, unknown>>(`SELECT * FROM identity.users ${w} ORDER BY created_at DESC LIMIT ${f.limit} OFFSET ${f.offset}`, vals);
    return { data: { items: await enrichUsers(rows), total: Number(total[0]?.n ?? 0), limit: f.limit, offset: f.offset } };
  });

  app.get('/v1/admin/users/:id', async (req, reply) => {
    const a = await actor(req);
    if (!a || !USER_READ_PERMS.some((p) => adminCan(a.role, p))) return h.fail(reply, 'FORBIDDEN', 'Insufficient permissions', 403);
    const id = String((req.params as { id: string }).id);
    if (!UUID_RE.test(id)) return h.fail(reply, 'NOT_FOUND', 'User not found', 404);
    const rows = await q<Record<string, unknown>>(`SELECT * FROM identity.users WHERE id=$1`, [id]);
    if (!rows[0]) return h.fail(reply, 'NOT_FOUND', 'User not found', 404);
    const [base] = await enrichUsers(rows);
    const bookings = await q<{ status: string }>(`SELECT status FROM booking.booking WHERE user_id=$1`, [id]).catch(() => []);
    const closed = ['COMPLETED', 'CANCELLED', 'CANCELED', 'REFUNDED', 'CLOSED', 'DECLINED', 'EXPIRED'];
    const devices = await q<Record<string, unknown>>(`SELECT * FROM identity.device_session WHERE user_id=$1 ORDER BY last_seen DESC LIMIT 20`, [id]).catch(() => []);
    const kycRow = (await q<Record<string, unknown>>(`SELECT * FROM kyc.customer WHERE user_id=$1`, [id]).catch(() => []))[0];
    const pRow = (await q<Record<string, unknown>>(`SELECT * FROM provider.provider WHERE user_id=$1`, [id]).catch(() => []))[0];
    const role = String(rows[0].role ?? '').toUpperCase();
    return {
      data: {
        ...base,
        bookingsCount: bookings.length,
        openBookings: bookings.filter((b) => !closed.includes(String(b.status).toUpperCase())).length,
        hasOpenBookings: await identityService.hasOpenBookings(id).catch(() => false),
        walletBalanceKobo: String(await walletService.getBalance(id).catch(() => 0)),
        devices: devices.map((d) => ({
          id: String(d.id), platform: str(d.platform), model: str(d.model), os: str(d.os), appVersion: str(d.app_version),
          ip: str(d.ip), city: str(d.city), lastSeenAt: str(d.last_seen), createdAt: str(d.created_at),
        })),
        kyc: kycRow ? {
          status: String(kycRow.status), tier: Number(kycRow.tier ?? 0), pendingReason: str(kycRow.pending_reason),
          rejectionReason: str(kycRow.rejection_reason), submittedAt: str(kycRow.submitted_at), reviewedAt: str(kycRow.reviewed_at),
          reviewedBy: str(kycRow.reviewed_by), ninMasked: str(kycRow.nin_masked),
        } : null,
        provider: pRow ? {
          id: String(pRow.id), businessName: str(pRow.business_name), status: str(pRow.status), kycStatus: String(pRow.kyc_status ?? 'PENDING'),
          verifyLevel: str(pRow.verify_level), online: pRow.online === true, verifiedTier: Number(pRow.kyc_tier ?? 0),
          rating: Number(pRow.rating ?? 0), pendingReason: str(pRow.kyc_pending_reason), rejectionReason: str(pRow.kyc_rejection_reason),
          kycSubmittedAt: str(pRow.kyc_submitted_at),
        } : null,
        twoFactorEnabled: isAdminRole(role) ? await adminTwoFactor.enabled(id) : null,
        recentAudit: (await auditService.query({ entityId: id, limit: 20 })).items,
      },
    };
  });

  /** Target checks shared by suspend / sign-out / erase. */
  async function loadTarget(req: FastifyRequest, reply: FastifyReply, a: { sub: string; role: string }, verb: string) {
    const id = String((req.params as { id: string }).id);
    if (!UUID_RE.test(id)) { void h.fail(reply, 'NOT_FOUND', 'User not found', 404); return null; }
    const rows = await q<Record<string, unknown>>(`SELECT id, role, status FROM identity.users WHERE id=$1`, [id]);
    if (!rows[0]) { void h.fail(reply, 'NOT_FOUND', 'User not found', 404); return null; }
    if (id === a.sub) { void h.fail(reply, 'CANNOT_TARGET_SELF', `You cannot ${verb} your own account.`, 409); return null; }
    if (isAdminRole(String(rows[0].role ?? '').toUpperCase()) && a.role !== 'SUPER_ADMIN') {
      void h.fail(reply, 'FORBIDDEN', `Only a super admin can ${verb} an admin.`, 403); return null;
    }
    return { id, role: String(rows[0].role ?? ''), status: String(rows[0].status ?? 'active') };
  }

  app.post('/v1/admin/users/:id/suspend', async (req, reply) => {
    const a = (await actor(req))!;
    const { reason } = reasonSchema.parse(req.body ?? {});
    const t = await loadTarget(req, reply, a, 'suspend');
    if (!t) return reply;
    if (t.status === 'deleted') return h.fail(reply, 'ACCOUNT_DELETED', 'This account was erased.', 409);
    const at = new Date().toISOString();
    await q(`UPDATE identity.users SET status='suspended', suspended_at=$2, suspended_reason=$3, suspended_by=$4, sessions_revoked_at=$2, updated_at=now() WHERE id=$1`,
      [t.id, at, reason, a.sub]);
    await revokeAll(t.id);
    await adminSessions.revokeUser(t.id);
    await q(`UPDATE provider.provider SET online=FALSE WHERE user_id=$1`, [t.id]).catch(() => undefined);
    await auditService.log(a.sub, 'admin.user.suspend', t.id, reqCtx(req, { entityType: 'user', reason, meta: { previousStatus: t.status } }));
    return { data: { id: t.id, status: 'suspended', suspendedAt: at, suspendedReason: reason } };
  });

  app.post('/v1/admin/users/:id/reactivate', async (req, reply) => {
    const a = (await actor(req))!;
    const { reason } = optReasonSchema.parse(req.body ?? {});
    const t = await loadTarget(req, reply, a, 'reactivate');
    if (!t) return reply;
    if (t.status !== 'suspended') return h.fail(reply, 'NOT_SUSPENDED', `This account is ${t.status}, not suspended.`, 409);
    await q(`UPDATE identity.users SET status='active', suspended_at=NULL, suspended_reason=NULL, suspended_by=NULL, updated_at=now() WHERE id=$1`, [t.id]);
    await auditService.log(a.sub, 'admin.user.reactivate', t.id, reqCtx(req, { entityType: 'user', reason: reason ?? null }));
    return { data: { id: t.id, status: 'active' } };
  });

  app.post('/v1/admin/users/:id/signout', async (req, reply) => {
    const a = (await actor(req))!;
    const t = await loadTarget(req, reply, a, 'sign out');
    if (!t) return reply;
    const { reason } = optReasonSchema.parse(req.body ?? {});
    const live = await q<{ n: string }>(`SELECT COUNT(*) AS n FROM identity.refresh_token WHERE user_id=$1 AND revoked=FALSE`, [t.id]);
    await revokeAll(t.id);
    await adminSessions.revokeUser(t.id);
    await q(`UPDATE identity.users SET sessions_revoked_at=$2 WHERE id=$1`, [t.id, new Date().toISOString()]);
    await auditService.log(a.sub, 'admin.user.signout', t.id, reqCtx(req, { entityType: 'user', reason: reason ?? null, meta: { revokedSessions: Number(live[0]?.n ?? 0) } }));
    return { data: { id: t.id, signedOut: true, revokedSessions: Number(live[0]?.n ?? 0) } };
  });

  app.post('/v1/admin/users/:id/erase', async (req, reply) => {
    const a = (await actor(req))!;
    const body = z.object({ reason: z.string().trim().min(3).max(500), confirm: z.string().optional() }).parse(req.body ?? {});
    if (body.confirm !== 'ERASE') return h.fail(reply, 'CONFIRM_REQUIRED', 'Send confirm: "ERASE" to erase this account.', 400);
    const t = await loadTarget(req, reply, a, 'erase');
    if (!t) return reply;
    if (isAdminRole(t.role.toUpperCase())) return h.fail(reply, 'CANNOT_ERASE_ADMIN', 'Remove the admin role before erasing this account.', 409);
    if (t.status === 'deleted') return h.fail(reply, 'ACCOUNT_DELETED', 'This account was already erased.', 409);
    // Same refusals as the user's own DELETE /v1/me.
    if (await identityService.hasOpenBookings(t.id)) return h.fail(reply, 'OPEN_BOOKINGS', 'This user has open bookings. Finish or cancel them before erasing the account.', 409);
    const balance = await walletService.getBalance(t.id).catch(() => 0);
    if (balance > 0) return h.fail(reply, 'WALLET_NOT_EMPTY', 'This user still has a wallet balance. Refund or settle it before erasing the account.', 409);
    await identityService.eraseAccount(t.id);
    await adminSessions.revokeUser(t.id);
    await q(`UPDATE identity.users SET sessions_revoked_at=$2 WHERE id=$1`, [t.id, new Date().toISOString()]);
    await auditService.log(a.sub, 'admin.user.erase', t.id, reqCtx(req, { entityType: 'user', reason: body.reason }));
    return { data: { id: t.id, status: 'deleted', erased: true } };
  });

  // ── providers ──────────────────────────────────────────────────────────────
  app.post('/v1/admin/providers/:id/reactivate', async (req, reply) => {
    const a = (await actor(req))!;
    const id = String((req.params as { id: string }).id);
    const { reason } = optReasonSchema.parse(req.body ?? {});
    const p = UUID_RE.test(id) ? (await q<Record<string, unknown>>(`SELECT id, status, kyc_status, verify_level FROM provider.provider WHERE id=$1`, [id]))[0] : undefined;
    if (!p) return h.fail(reply, 'NOT_FOUND', 'Provider not found', 404);
    const level = String(p.kyc_status) === 'VERIFIED' ? 'verified' : String(p.kyc_status) === 'UNDER_REVIEW' ? 'under_review' : 'pending';
    await q(`UPDATE provider.provider SET status='active' WHERE id=$1`, [id]);
    const v = await verificationService.set(id, level);
    const { vendorEligibilityService } = await import('../../../modules/vendors/eligibility.service.js');
    await vendorEligibilityService.refreshAll(id).catch(() => undefined);
    await auditService.log(a.sub, 'admin.provider.reactivate', id, reqCtx(req, { entityType: 'provider', reason: reason ?? null, meta: { previousStatus: str(p.status), previousLevel: str(p.verify_level) } }));
    return { data: { id, status: 'active', verifyLevel: v.level, kycStatus: String(p.kyc_status) } };
  });

  app.post('/v1/admin/providers/:id/revoke-verification', async (req, reply) => {
    const a = (await actor(req))!;
    const id = String((req.params as { id: string }).id);
    const { reason } = reasonSchema.parse(req.body ?? {});
    const p = UUID_RE.test(id) ? (await q<Record<string, unknown>>(`SELECT id, kyc_status, verify_level FROM provider.provider WHERE id=$1`, [id]))[0] : undefined;
    if (!p) return h.fail(reply, 'NOT_FOUND', 'Provider not found', 404);
    await q(`UPDATE provider.provider SET kyc_status='UNDER_REVIEW', kyc_pending_reason='admin_revoked', kyc_rejection_reason=$2,
               kyc_reviewed_at=now(), kyc_reviewed_by=$3, online=FALSE WHERE id=$1`, [id, reason, a.sub]);
    const v = await verificationService.set(id, 'under_review');
    const { vendorEligibilityService } = await import('../../../modules/vendors/eligibility.service.js');
    await vendorEligibilityService.refreshAll(id).catch(() => undefined);
    await auditService.log(a.sub, 'admin.provider.revoke_verification', id, reqCtx(req, { entityType: 'provider', reason, meta: { previousKycStatus: String(p.kyc_status) } }));
    return { data: { id, kycStatus: 'UNDER_REVIEW', pendingReason: 'admin_revoked', verifyLevel: v.level, online: false } };
  });

  // ── categories ─────────────────────────────────────────────────────────────
  app.get('/v1/admin/categories', async (req) => {
    const f = z.object({
      kind: z.enum(['service', 'product']).optional(),
      group: z.string().trim().max(60).optional(),
      status: z.enum(['active', 'inactive', 'new']).optional(),
    }).parse(req.query ?? {});
    return { data: await categoryList(f) };
  });

  app.post('/v1/admin/categories', async (req, reply) => {
    const a = (await actor(req))!;
    const b = categorySchema.parse(req.body ?? {});
    const id = b.id ?? hyphenSlug(b.name);
    if ((await q(`SELECT 1 FROM catalog.category WHERE id=$1`, [id]))[0]) return h.fail(reply, 'CATEGORY_EXISTS', `A category with id "${id}" already exists.`, 409);
    if (!(await q(`SELECT 1 FROM catalog.category_group WHERE id=$1`, [b.groupId]))[0]) return h.fail(reply, 'GROUP_NOT_FOUND', 'Unknown category group.', 400);
    const order = b.sortOrder ?? Number((await q<{ n: string }>(`SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM catalog.category`))[0]?.n ?? 999);
    await q(
      `INSERT INTO catalog.category (id, name, short_name, description, active, sort_order, icon_name, group_id, kind, keywords, is_new, created_via)
       VALUES ($1,$2,$3,$4,TRUE,$5,$6,$7,$8,$9,FALSE,'admin')`,
      [id, b.name, b.shortName ?? b.name.slice(0, 24), b.description ?? null, order, b.iconName ?? 'Wrench', b.groupId, b.kind,
        (b.keywords ?? [b.name]).map((k) => k.toLowerCase())],
    );
    await q(`INSERT INTO catalog.category_rule (category_id, commission_bps, updated_by) VALUES ($1,$2,$3)`, [id, b.commissionBps ?? 1500, a.sub]);
    await auditService.log(a.sub, 'admin.category.create', id, reqCtx(req, { entityType: 'category', meta: { name: b.name, groupId: b.groupId, kind: b.kind } }));
    reply.code(201);
    return { data: (await categoryList({ id }))[0] };
  });

  app.patch('/v1/admin/categories/:id', async (req, reply) => {
    const a = (await actor(req))!;
    const id = String((req.params as { id: string }).id);
    const b = categorySchema.omit({ id: true }).partial().parse(req.body ?? {});
    if (!(await q(`SELECT 1 FROM catalog.category WHERE id=$1`, [id]))[0]) return h.fail(reply, 'NOT_FOUND', 'Category not found', 404);
    if (b.groupId && !(await q(`SELECT 1 FROM catalog.category_group WHERE id=$1`, [b.groupId]))[0]) return h.fail(reply, 'GROUP_NOT_FOUND', 'Unknown category group.', 400);
    const cols: [string, unknown][] = [];
    if (b.name !== undefined) cols.push(['name', b.name]);
    if (b.shortName !== undefined) cols.push(['short_name', b.shortName]);
    if (b.description !== undefined) cols.push(['description', b.description]);
    if (b.groupId !== undefined) cols.push(['group_id', b.groupId]);
    if (b.kind !== undefined) cols.push(['kind', b.kind]);
    if (b.iconName !== undefined) cols.push(['icon_name', b.iconName]);
    if (b.keywords !== undefined) cols.push(['keywords', b.keywords.map((k) => k.toLowerCase())]);
    if (b.sortOrder !== undefined) cols.push(['sort_order', b.sortOrder]);
    if (cols.length) await q(`UPDATE catalog.category SET ${cols.map(([c], i) => `${c}=$${i + 2}`).join(', ')} WHERE id=$1`, [id, ...cols.map(([, v]) => v)]);
    if (b.commissionBps !== undefined) {
      const has = await q(`SELECT 1 FROM catalog.category_rule WHERE category_id=$1`, [id]);
      if (has[0]) await q(`UPDATE catalog.category_rule SET commission_bps=$2, updated_by=$3, updated_at=now() WHERE category_id=$1`, [id, b.commissionBps, a.sub]);
      else await q(`INSERT INTO catalog.category_rule (category_id, commission_bps, updated_by) VALUES ($1,$2,$3)`, [id, b.commissionBps, a.sub]);
    }
    await auditService.log(a.sub, 'admin.category.update', id, reqCtx(req, { entityType: 'category', meta: { fields: Object.keys(b) } }));
    return { data: (await categoryList({ id }))[0] };
  });

  app.post('/v1/admin/categories/:id/disable', async (req, reply) => {
    const a = (await actor(req))!;
    const id = String((req.params as { id: string }).id);
    const { reason } = reasonSchema.parse(req.body ?? {});
    const rows = await q(`UPDATE catalog.category SET active=FALSE, is_new=FALSE WHERE id=$1 RETURNING id`, [id]);
    if (!rows[0]) return h.fail(reply, 'NOT_FOUND', 'Category not found', 404);
    await auditService.log(a.sub, 'admin.category.disable', id, reqCtx(req, { entityType: 'category', reason }));
    return { data: (await categoryList({ id }))[0] };
  });

  app.post('/v1/admin/categories/:id/enable', async (req, reply) => {
    const a = (await actor(req))!;
    const id = String((req.params as { id: string }).id);
    const { reason } = optReasonSchema.parse(req.body ?? {});
    const rows = await q(`UPDATE catalog.category SET active=TRUE WHERE id=$1 RETURNING id`, [id]);
    if (!rows[0]) return h.fail(reply, 'NOT_FOUND', 'Category not found', 404);
    await auditService.log(a.sub, 'admin.category.enable', id, reqCtx(req, { entityType: 'category', reason: reason ?? null }));
    return { data: (await categoryList({ id }))[0] };
  });

  // Same merge the proposal decide flow uses (category-rules.service mergeCategory).
  app.post('/v1/admin/categories/:id/merge', async (req, reply) => {
    const a = (await actor(req))!;
    const id = String((req.params as { id: string }).id);
    const { targetId, reason } = z.object({ targetId: z.string().trim().min(1).max(60), reason: z.string().trim().min(3).max(500) }).parse(req.body ?? {});
    if (targetId === id) return h.fail(reply, 'MERGE_INTO_SELF', 'Pick a different category to merge into.', 400);
    if (!(await q(`SELECT 1 FROM catalog.category WHERE id=$1`, [id]))[0]) return h.fail(reply, 'NOT_FOUND', 'Category not found', 404);
    const target = (await q<{ active: boolean }>(`SELECT active FROM catalog.category WHERE id=$1`, [targetId]))[0];
    if (!target) return h.fail(reply, 'MERGE_TARGET_NOT_FOUND', 'The target category does not exist.', 404);
    if (target.active === false) return h.fail(reply, 'MERGE_TARGET_INACTIVE', 'Enable the target category first.', 409);
    const before = (await categoryList({ id }))[0];
    await mergeCategory(id, targetId);
    // Open proposals that created the source are resolved by this merge.
    await q(`UPDATE catalog.category_proposal SET status='merged', resolved_category_id=$2, decided_by=$3, decision_note=$4, decided_at=now()
              WHERE resolved_category_id=$1 AND status='pending'`, [id, targetId, a.sub, reason]).catch(() => undefined);
    await auditService.log(a.sub, 'admin.category.merge', id, reqCtx(req, {
      entityType: 'category', reason,
      meta: { targetId, moved: { offerings: before?.offeringsCount ?? 0, providers: before?.providersCount ?? 0, requests: before?.requestsCount ?? 0 } },
    }));
    return { data: { from: (await categoryList({ id }))[0], into: (await categoryList({ id: targetId }))[0] } };
  });

  // ── category groups ───────────────────────────────────────────────────────
  app.get('/v1/admin/category-groups', async () => ({ data: await groupList() }));

  app.post('/v1/admin/category-groups', async (req, reply) => {
    const a = (await actor(req))!;
    const b = groupSchema.parse(req.body ?? {});
    const id = b.id ?? hyphenSlug(b.name);
    if ((await q(`SELECT 1 FROM catalog.category_group WHERE id=$1`, [id]))[0]) return h.fail(reply, 'GROUP_EXISTS', `A group with id "${id}" already exists.`, 409);
    const order = b.sortOrder ?? Number((await q<{ n: string }>(`SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM catalog.category_group WHERE sort_order < 99`))[0]?.n ?? 50);
    await q(`INSERT INTO catalog.category_group (id, name, short_name, sort_order, icon_name, kind) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, b.name, b.shortName ?? b.name.slice(0, 40), order, b.iconName ?? 'Sparkles', b.kind]);
    await auditService.log(a.sub, 'admin.category_group.create', id, reqCtx(req, { entityType: 'category_group', meta: { name: b.name, kind: b.kind } }));
    reply.code(201);
    return { data: (await groupList(id))[0] };
  });

  app.patch('/v1/admin/category-groups/:id', async (req, reply) => {
    const a = (await actor(req))!;
    const id = String((req.params as { id: string }).id);
    const b = groupSchema.omit({ id: true }).partial().parse(req.body ?? {});
    if (!(await q(`SELECT 1 FROM catalog.category_group WHERE id=$1`, [id]))[0]) return h.fail(reply, 'NOT_FOUND', 'Group not found', 404);
    const cols: [string, unknown][] = [];
    if (b.name !== undefined) cols.push(['name', b.name]);
    if (b.shortName !== undefined) cols.push(['short_name', b.shortName]);
    if (b.kind !== undefined) cols.push(['kind', b.kind]);
    if (b.iconName !== undefined) cols.push(['icon_name', b.iconName]);
    if (b.sortOrder !== undefined) cols.push(['sort_order', b.sortOrder]);
    if (cols.length) await q(`UPDATE catalog.category_group SET ${cols.map(([c], i) => `${c}=$${i + 2}`).join(', ')} WHERE id=$1`, [id, ...cols.map(([, v]) => v)]);
    await auditService.log(a.sub, 'admin.category_group.update', id, reqCtx(req, { entityType: 'category_group', meta: { fields: Object.keys(b) } }));
    return { data: (await groupList(id))[0] };
  });

  // ── admin 2FA ──────────────────────────────────────────────────────────────
  app.get('/v1/admin/2fa/status', async (req) => {
    const a = (await actor(req))!;
    const s = await adminTwoFactor.status(a.sub);
    return { data: { ...s, required: adminTwoFactorRequired() } };
  });

  app.post('/v1/admin/2fa/enroll', async (req, reply) => {
    const a = (await actor(req))!;
    const u = (await q<{ email: string | null; phone: string | null }>(`SELECT email, phone FROM identity.users WHERE id=$1`, [a.sub]))[0];
    try {
      const out = await adminTwoFactor.enroll(a.sub, String(u?.email ?? u?.phone ?? a.sub));
      await auditService.log(a.sub, 'admin.2fa.enroll', a.sub, reqCtx(req, { entityType: 'user' }));
      return { data: out };
    } catch (e) {
      if ((e as Error).message === 'TWO_FACTOR_ALREADY_ENABLED') return h.fail(reply, 'TWO_FACTOR_ALREADY_ENABLED', 'Two-factor is already on. Disable it first to enroll a new device.', 409);
      throw e;
    }
  });

  app.post('/v1/admin/2fa/verify', async (req, reply) => {
    const a = (await actor(req))!;
    const { code } = z.object({ code: z.string().trim().min(6).max(8) }).parse(req.body ?? {});
    let ok: boolean;
    try { ok = await adminTwoFactor.confirm(a.sub, code); } catch { return h.fail(reply, 'NO_PENDING_ENROLLMENT', 'Start with POST /v1/admin/2fa/enroll.', 409); }
    if (!ok) {
      await auditService.log(a.sub, 'admin.2fa.verify_failed', a.sub, reqCtx(req, { entityType: 'user' }));
      return h.fail(reply, 'BAD_TWO_FACTOR_CODE', 'That code is not right. Check the time on your phone and try the newest code.', 400);
    }
    // The session that proved the code counts as 2FA-verified.
    const bearer = String(req.headers.authorization ?? '');
    const claims = bearer.startsWith('Bearer ') ? verifyAccess(bearer.slice(7)) : null;
    if (claims?.sid) await adminSessions.markMfa(claims.sid);
    await auditService.log(a.sub, 'admin.2fa.enable', a.sub, reqCtx(req, { entityType: 'user' }));
    return { data: { enabled: true } };
  });

  app.post('/v1/admin/2fa/disable', async (req, reply) => {
    const a = (await actor(req))!;
    const { code } = z.object({ code: z.string().trim().min(6).max(8) }).parse(req.body ?? {});
    if (!(await adminTwoFactor.enabled(a.sub))) return h.fail(reply, 'TWO_FACTOR_NOT_ENABLED', 'Two-factor is not on.', 409);
    if (!(await adminTwoFactor.check(a.sub, code))) {
      await auditService.log(a.sub, 'admin.2fa.disable_failed', a.sub, reqCtx(req, { entityType: 'user' }));
      return h.fail(reply, 'BAD_TWO_FACTOR_CODE', 'That code is not right.', 400);
    }
    await adminTwoFactor.disable(a.sub);
    await auditService.log(a.sub, 'admin.2fa.disable', a.sub, reqCtx(req, { entityType: 'user' }));
    return { data: { enabled: false } };
  });

  // Second step of an admin login: the challenge from /v1/auth/otp/verify (or
  // /v1/auth/google) plus the current authenticator code -> session.
  app.post('/v1/admin/login/2fa', async (req, reply) => {
    const body = z.object({ challengeId: z.string().trim().min(1).max(64), code: z.string().trim().min(1).max(12) }).safeParse(req.body ?? {});
    if (!body.success) return h.fail(reply, 'BAD_REQUEST', 'Send challengeId and code.', 400);
    const ctx = reqCtx(req);
    const ch = await adminLoginChallenge.open(body.data.challengeId);
    if (!ch) return h.fail(reply, 'CHALLENGE_INVALID', 'This sign-in has expired. Start again.', 401);
    const retry = await adminLogin.retryAfter(ch.userId, ctx.ip ?? null);
    if (retry > 0) { await adminLogin.locked(ch.userId, retry, ctx); return sendLocked(reply, h.fail, retry); }
    const user = (await q<Record<string, unknown>>(`SELECT * FROM identity.users WHERE id=$1`, [ch.userId]))[0];
    if (!user) return h.fail(reply, 'CHALLENGE_INVALID', 'This sign-in has expired. Start again.', 401);
    if (String(user.status ?? '') === 'suspended') return h.fail(reply, 'ACCOUNT_SUSPENDED', 'This account is suspended. Contact Kendibo support.', 403);
    if (!(await adminTwoFactor.check(ch.userId, body.data.code))) {
      await adminLoginChallenge.failedAttempt(ch.id);
      const locked = await adminLogin.failed(ch.userId, 'totp', ctx);
      if (locked > 0) return sendLocked(reply, h.fail, locked);
      return h.fail(reply, 'BAD_TWO_FACTOR_CODE', 'That code is not right. Try the newest code from your authenticator app.', 401);
    }
    if (!(await adminLoginChallenge.consume(ch.id))) return h.fail(reply, 'CHALLENGE_INVALID', 'This sign-in has expired. Start again.', 401);
    const s = await identityService.issueSession(user, { ...(ch.device as Record<string, string>), ip: ctx.ip ?? undefined }, { mfa: true });
    await adminLogin.succeeded(ch.userId, s, 'otp+totp', ctx);
    return { data: { ...s, isNew: false } };
  });
}

/** GET /v1/admin/audit filters (handler stays in main.ts for older clients). */
export const auditQuerySchema = z.object({
  entity: z.string().trim().max(60).optional(),
  entityId: z.string().trim().max(120).optional(),
  actor: z.string().trim().max(120).optional(),
  action: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).catch(50),
  offset: z.coerce.number().int().min(0).catch(0),
});
