// Customer account numbers (Paga Subsidiary Accounts), see
// modules/payments/paga/virtual-accounts.ts.
//   GET  /v1/wallet/virtual-account          the user's account number (created on first view once KYC is verified)
//   POST /v1/wallet/virtual-account/rotate   new number; balance moves across; old number disabled (once per 24h)
//   GET  /v1/wallet/virtual-account/fundings transfers received, with who sent them
//   GET  /v1/admin/virtual-accounts?filter=  who has a number, who has paid in, who has not (payment:view)
//   POST /v1/admin/virtual-accounts/backfill  { limit? } give numbers to verified users without one (configuration:edit)
//   POST /webhooks/paga/subsidiary           The one Paga callback URL: account funding / charge / top-up notifications here;
//                                            checkout and payout notifications are handed to main.ts (routeOther)
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  accountView, rotate, fundingsFor, adminList, handleSubsidiaryNotification, VaError, backfillVirtualAccounts,
} from '../../../modules/payments/paga/virtual-accounts.js';
import { observability } from '../../../packages/observability/watchup.adapter.js';

interface Helpers {
  authed: (req: never) => { sub: string } | null;
  fail: (reply: FastifyReply, code: string, message: string, status?: number, retryable?: boolean) => unknown;
  /** Checkout / payout notifications arriving on the one Paga URL. Returns undefined when the body is not theirs. */
  routeOther?: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown | undefined>;
}

export const VIRTUAL_ACCOUNT_ROUTE_POLICY = {
  'POST /webhooks/paga/subsidiary': 'public', // x-paga-hash-v3 / body hash checked; money only moves after Paga confirms
  'GET /v1/admin/virtual-accounts': 'payment:view',
  'POST /v1/admin/virtual-accounts/backfill': 'configuration:edit', // creates Paga accounts
} as const;

const rotateLimiter = new Map<string, number>(); // in-process guard against double taps; the DB enforces the 24h rule

export function registerVirtualAccountRoutes(app: FastifyInstance, h: Helpers) {
  app.get('/v1/wallet/virtual-account', async (req, reply) => {
    const a = h.authed(req as never); if (!a) return h.fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
    return { data: await accountView(a.sub) };
  });

  app.post('/v1/wallet/virtual-account/rotate', async (req, reply) => {
    const a = h.authed(req as never); if (!a) return h.fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
    const last = rotateLimiter.get(a.sub) ?? 0;
    if (Date.now() - last < 10_000) return h.fail(reply, 'ROTATE_IN_PROGRESS', 'Please wait a moment and try again', 429);
    rotateLimiter.set(a.sub, Date.now());
    try {
      const fresh = await rotate(a.sub);
      return { data: { status: 'active', accountNumber: fresh.account_number, accountName: fresh.account_name, bankName: fresh.bank_name, sandbox: fresh.env === 'sandbox' } };
    } catch (e) {
      if (e instanceof VaError) return h.fail(reply, e.code, e.message, e.status, e.status >= 500);
      observability.captureException(e);
      return h.fail(reply, 'ROTATE_FAILED', 'Could not change your account number right now', 500, true);
    } finally {
      if (rotateLimiter.size > 5000) rotateLimiter.clear();
    }
  });

  app.get('/v1/wallet/virtual-account/fundings', async (req, reply) => {
    const a = h.authed(req as never); if (!a) return h.fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
    return { data: await fundingsFor(a.sub) };
  });

  // Behind the admin gate in main.ts (route policy payment:view).
  app.get('/v1/admin/virtual-accounts', async (req) => {
    const { filter, limit } = z.object({
      filter: z.enum(['all', 'funded', 'never_funded', 'unconfirmed']).optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
    }).parse(req.query ?? {});
    return { data: await adminList({ filter, limit }) };
  });

  app.post('/v1/admin/virtual-accounts/backfill', async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }).parse(req.body ?? {});
    return { data: await backfillVirtualAccounts(limit ?? 50) };
  });

  app.post('/webhooks/paga/subsidiary', { config: { rawBody: true } }, async (req, reply) => {
    const other = h.routeOther ? await h.routeOther(req, reply) : undefined;
    if (other !== undefined) return other;
    const raw = String((req as unknown as { rawBody?: string }).rawBody || JSON.stringify(req.body ?? {}));
    try {
      await handleSubsidiaryNotification(raw, req.headers as Record<string, string | string[] | undefined>);
    } catch (e) {
      // Ask Paga to retry only on our own failure; nothing was credited.
      observability.captureException(e);
      throw e;
    }
    return { status: 'SUCCESS' };
  });
}
