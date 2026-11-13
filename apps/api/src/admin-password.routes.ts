// Admin console sign-in with email + password (email OTP does not reach admin
// inboxes reliably). Flow:
//   POST /v1/admin/login/password {email, password}
//     -> 2FA on:  { twoFactorRequired, challengeId } -> POST /v1/admin/login/2fa (existing)
//     -> 2FA off: session (same shape as /v1/auth/otp/verify)
//   POST /v1/admin/password {currentPassword?, newPassword}   (signed-in admin; sets or changes it)
//   GET  /v1/admin/password                                   -> { hasPassword, mustChange }
// First password for a seat: scripts/admin-set-password.ts on the server.
// Same lockout as OTP sign-in: 5 failures / 15 min per account and per IP.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { adminPassword, passwordProblem } from '../../../modules/identity/admin-password.js';
import { identityService } from '../../../modules/identity/identity.service.js';
import { adminLogin, sendLocked, clientIp } from './admin-console.routes.js';
import { auditService } from '../../../modules/audit/audit.service.js';
import { q } from '../../../packages/database/db.js';

type Fail = (reply: FastifyReply, code: string, message: string, status?: number, retryable?: boolean) => unknown;
interface Helpers {
  fail: Fail;
  adminActor: (req: never) => Promise<{ sub: string; role: string } | { denied: true } | null>;
}

export const ADMIN_PASSWORD_POLICY = {
  'POST /v1/admin/login/password': 'public', // credentials checked in the handler, with lockout
} as const;

const loginSchema = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(1).max(200),
  device: z.object({ fp: z.string().optional(), platform: z.string().optional(), model: z.string().optional(), os: z.string().optional(), appVersion: z.string().optional() }).optional(),
});

export function registerAdminPasswordRoutes(app: FastifyInstance, h: Helpers) {
  app.post('/v1/admin/login/password', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const body = loginSchema.safeParse(req.body ?? {});
    const wrong = () => h.fail(reply, 'BAD_CREDENTIALS', 'Email or password is not right.', 401);
    if (!body.success) return wrong();
    const ctx = { ip: clientIp(req as never), ua: req.headers['user-agent'] ? String(req.headers['user-agent']) : null };
    const seat = await adminPassword.find(body.data.email);
    if (seat) {
      const retry = await adminLogin.retryAfter(String(seat.user.id), ctx.ip);
      if (retry > 0) { await adminLogin.locked(String(seat.user.id), retry, ctx); return sendLocked(reply, h.fail, retry); }
    }
    const ok = await adminPassword.verify(body.data.email, body.data.password);
    if (!ok) {
      if (seat) {
        const locked = await adminLogin.failed(String(seat.user.id), 'password', ctx);
        if (locked > 0) return sendLocked(reply, h.fail, locked);
      }
      return wrong();
    }
    const device = { ...(body.data.device ?? {}), ip: ctx.ip ?? undefined, ua: ctx.ua ?? undefined };
    let gate;
    try { gate = await identityService.loginGate(ok.user, device); }
    catch (e) {
      if ((e as Error).message === 'ACCOUNT_SUSPENDED') return h.fail(reply, 'ACCOUNT_SUSPENDED', 'This account is suspended. Contact Kendibo support.', 403);
      throw e;
    }
    if (gate) {
      await adminLogin.succeeded(String(ok.user.id), gate, 'password', ctx);
      return { data: { ...gate, isNew: false, mustChangePassword: ok.mustChange } };
    }
    const s = await identityService.issueSession(ok.user, device);
    await adminLogin.succeeded(String(ok.user.id), s, 'password', ctx);
    return { data: { ...s, isNew: false, mustChangePassword: ok.mustChange } };
  });

  app.get('/v1/admin/password', async (req, reply) => {
    const a = await h.adminActor(req as never);
    if (!a || 'denied' in a) return h.fail(reply, 'FORBIDDEN', 'Admin sign-in required', 403);
    const r = await q<{ must_change: boolean }>(`SELECT must_change FROM identity.admin_credential WHERE user_id=$1`, [a.sub]);
    return { data: { hasPassword: Boolean(r[0]), mustChange: Boolean(r[0]?.must_change) } };
  });

  app.post('/v1/admin/password', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const a = await h.adminActor(req as never);
    if (!a || 'denied' in a) return h.fail(reply, 'FORBIDDEN', 'Admin sign-in required', 403);
    const body = z.object({ currentPassword: z.string().max(200).optional(), newPassword: z.string().max(200) }).safeParse(req.body ?? {});
    if (!body.success) return h.fail(reply, 'BAD_REQUEST', 'Send newPassword.', 400);
    const me = (await q<{ email: string | null }>(`SELECT email FROM identity.users WHERE id=$1`, [a.sub]))[0];
    if (await adminPassword.hasPassword(a.sub)) {
      if (!me?.email || !body.data.currentPassword || !(await adminPassword.verify(me.email, body.data.currentPassword))) {
        return h.fail(reply, 'BAD_CREDENTIALS', 'Your current password is not right.', 401);
      }
    }
    const problem = passwordProblem(body.data.newPassword, me?.email);
    if (problem) return h.fail(reply, 'WEAK_PASSWORD', problem, 400);
    await adminPassword.set(a.sub, body.data.newPassword, false);
    await auditService.log(a.sub, 'admin.password.changed', a.sub, { ip: clientIp(req as never), entityType: 'user' });
    return { data: { ok: true } };
  });
}
