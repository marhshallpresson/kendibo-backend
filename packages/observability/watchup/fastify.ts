// Fastify tracing plugin — method/route/status/duration traces + error capture.
// Never attaches bodies, headers, cookies, query strings (privacy posture).
import type { FastifyInstance } from 'fastify';
import { watchup } from '../watchup.adapter.js';

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
      });
    } catch { /* fail open */ }
  });
  app.setErrorHandler(async (err, req, reply) => {
    try {
      watchup.captureException(err, { route: req.url.split('?')[0], request_id: req.id });
    } catch { /* fail open */ }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    const code = status === 500 ? 'INTERNAL' : 'BAD_REQUEST';
    void reply.code(status).send({ error: { code, message: status === 500 ? 'Something went wrong.' : (err as Error).message, requestId: req.id, retryable: status >= 500 } });
  });
}
