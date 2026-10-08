// ObservabilityPort — WatchUp is the app-level surface (errors/traces/business events).
// Backed by the real WatchUp ingest client (packages/observability/watchup/).
// Telemetry NEVER throws into payment/booking/dispatch paths (fail open).
import { Watchup } from './watchup/client.js';

export interface ObservabilityPort {
  captureException(err: unknown, ctx?: Record<string, unknown>): void;
  captureMessage(msg: string, ctx?: Record<string, unknown>): void;
  captureLog(level: 'debug' | 'info' | 'warning' | 'error' | 'fatal', msg: string, ctx?: Record<string, unknown>): void;
  track(event: string, props?: Record<string, unknown>): void;
  setContext(ctx: Record<string, unknown>): void;
}

const client = new Watchup({ service: process.env.WATCHUP_SERVICE ?? 'api' });

export const watchup = client;

export class WatchupAdapter implements ObservabilityPort {
  captureException(err: unknown, ctx?: Record<string, unknown>): void { client.captureException(err, ctx); }
  captureMessage(msg: string, ctx?: Record<string, unknown>): void { client.captureMessage(msg, ctx); }
  captureLog(level: 'debug' | 'info' | 'warning' | 'error' | 'fatal', msg: string, ctx?: Record<string, unknown>): void {
    client.captureLog(level, msg, ctx);
  }
  track(event: string, props?: Record<string, unknown>): void { client.track(event, props); }
  setContext(ctx: Record<string, unknown>): void {
    const id = ctx.userId ?? ctx.user_id;
    if (id) client.setUser({ id: String(id) });
  }
}

export const observability: ObservabilityPort = new WatchupAdapter();
