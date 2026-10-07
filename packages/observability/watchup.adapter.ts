// ObservabilityPort — WatchUp is the app-level surface (errors/traces/business events),
// Sentry pattern = error capture, PostHog pattern = product events/flags, Datadog pattern = infra metrics.
// Telemetry NEVER throws into payment/booking/dispatch paths (Rule 12: fail open).
export interface ObservabilityPort {
  captureException(err: unknown, ctx?: Record<string, unknown>): void;
  captureMessage(msg: string, ctx?: Record<string, unknown>): void;
  track(event: string, props?: Record<string, unknown>): void;
  setContext(ctx: Record<string, unknown>): void;
}

const BERNOULLI = (p = 1) => Math.random() < p;
const REDACT = new Set(['otp', 'authorization', 'refreshToken', 'secret', 'card', 'bvn', 'accountNumber']);
function sanitize(props: Record<string, unknown> = {}) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) out[k] = REDACT.has(k) ? '[REDACTED]' : v;
  return out;
}

export class WatchupAdapter implements ObservabilityPort {
  constructor(private opts = { sample: 1 }) {}
  captureException(err: unknown, ctx?: Record<string, unknown>): void {
    try {
      if (!process.env.WATCHUP_API_KEY) return; // not configured -> no-op
      if (!BERNOULLI(this.opts.sample)) return;
      // POST to WatchUp ingest (Node middleware/request tracing + error capture)
      void fetch('https://watchup.site/api/ingest/errors', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.WATCHUP_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: String(err), context: sanitize(ctx), env: process.env.WATCHUP_ENV, release: process.env.WATCHUP_RELEASE }),
      }).catch(() => {});
    } catch { /* fail open */ }
  }
  captureMessage(msg: string, ctx?: Record<string, unknown>): void {
    try {
      if (!process.env.WATCHUP_API_KEY) return;
      void fetch('https://watchup.site/api/ingest/events', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.WATCHUP_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: msg, props: sanitize(ctx) }),
      }).catch(() => {});
    } catch { /* fail open */ }
  }
  track(event: string, props?: Record<string, unknown>): void { this.captureMessage(event, props); }
  setContext(_ctx: Record<string, unknown>): void { /* release/env/user tagging */ }
}

export const observability: ObservabilityPort = new WatchupAdapter();
