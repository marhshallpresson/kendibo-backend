// Fastify tracing plugin — method/route/status/duration traces + error capture.
// Never attaches bodies, headers, cookies, query strings (privacy posture).
// User identification: verified JWT sub attached per request (no global
// mutation — safe under concurrent users).
import type { FastifyInstance } from 'fastify';
import { verifyAccess } from '../../auth/auth.js';
import { watchup } from '../watchup.adapter.js';

function requestUser(req: { headers: Record<string, string | undefined> }): { id: string } | undefined {
  try {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return undefined;
    const v = verifyAccess(h.slice(7));
    return v ? { id: v.sub } : undefined;
  } catch {
    return undefined;
  }
}

export async function watchupTracing(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (req) => {
    (req as unknown as {wuStart?: bigint}).wuStart = process.hrtime.bigint();
  });
  app.addHook('onResponse', async (req, reply) => {
    try {
      const start = (req as unknown as { wuStart?: bigint }).wuStart;
      if (!start) return;
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const route = req.routeOptions?.url ?? req.url.split('?')[0];
      watchup.trace(`${req.method} ${route}`, ms, reply.statusCode, {
        request_id: req.id,
        route, method: req.method, status: reply.statusCode,
        user: requestUser(req as never),
      });
    } catch { /* fail open */ }
  });
  app.setErrorHandler(async (err, req, reply) => {
    try {
      watchup.captureException(err, { route: req.url.split('?')[0], request_id: req.id });
      watchup.captureLog('error', `5xx ${req.method} ${req.url.split('?')[0]}: ${String((err as Error).message).slice(0, 200)}`, {
        route: req.url.split('?')[0], request_id: req.id,
      });
    } catch { /* fail open */ }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    const code = status === 500 ? 'INTERNAL' : 'BAD_REQUEST';
    void reply.code(status).send({ error: { code, message: status === 500 ? 'Something went wrong.' : (err as Error).message, requestId: req.id, retryable: status >= 500 } });
  });
}
