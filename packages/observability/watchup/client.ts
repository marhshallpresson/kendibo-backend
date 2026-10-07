// WatchUp Node client — errors, traces, events, user context, feature flags.
// Fail-open everywhere: no key / no network / bad payload must never break
// payment, booking or dispatch paths. Mirrors official SDK semantics:
// background flush every 5s, <=100 items/batch, queue cap 1000 (oldest drop),
// flags refresh every 30s with deterministic local evaluation.
import {
  DEFAULT_BASE_URL, MAX_BATCH_ITEMS, MAX_QUEUE_ITEMS,
  envelope, truncateUtf8, sanitize, type Item, type ErrorItem, type TraceItem,
} from './contract.js';
import { Transport } from './transport.js';

export interface WatchupOptions {
  apiKey?: string;
  baseUrl?: string;
  environment?: string;
  release?: string;
  service?: string;
  sampleRate?: number;
  flushIntervalMs?: number;
  flagRefreshMs?: number;
}
export interface WatchupUser { id: string; email?: string; name?: string }

interface FlagRule { key: string; enabled: boolean; rollout?: number; variants?: { name: string; weight: number }[] }

function hashBucket(key: string, id: string): number {
  let h = 2166136261;
  for (const c of `${key}:${id}`) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 100;
}

export class Watchup {
  private transport: Transport | null = null;
  private queue: Item[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flagTimer: ReturnType<typeof setInterval> | null = null;
  private flags = new Map<string, FlagRule>();
  private user: WatchupUser | null = null;
  private flushing = false;
  readonly environment: string;
  readonly release: string;
  readonly service: string;
  private sampleRate: number;

  constructor(opts: WatchupOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.WATCHUP_API_KEY ?? '';
    const baseUrl = opts.baseUrl ?? process.env.WATCHUP_BASE_URL ?? DEFAULT_BASE_URL;
    this.environment = opts.environment ?? process.env.WATCHUP_ENV ?? 'development';
    this.release = opts.release ?? process.env.WATCHUP_RELEASE ?? 'dev';
    this.service = opts.service ?? 'api';
    this.sampleRate = opts.sampleRate ?? 1;
    if (apiKey) this.transport = new Transport(baseUrl, apiKey);
    const flushMs = opts.flushIntervalMs ?? 5000;
    this.timer = setInterval(() => void this.flush(), flushMs);
    this.timer.unref?.();
    const flagMs = opts.flagRefreshMs ?? 30000;
    if (flagMs > 0) {
      void this.refreshFlags();
      this.flagTimer = setInterval(() => void this.refreshFlags(), flagMs);
      this.flagTimer.unref?.();
    }
  }

  get enabled(): boolean { return this.transport !== null; }
  get queueDepth(): number { return this.queue.length; }
  get lastFlush(): { at: string | null; ok: boolean | null } { return { ...this.lastFlushState }; }
  private lastFlushState: { at: string | null; ok: boolean | null } = { at: null, ok: null };

  setUser(user: WatchupUser | null): void { this.user = user; }

  private push(item: Item): void {
    try {
      if (this.queue.length >= MAX_QUEUE_ITEMS) this.queue.shift(); // oldest drop
      this.queue.push(item);
    } catch { /* never throw */ }
  }

  captureException(err: unknown, ctx?: Record<string, unknown>, level: ErrorItem['level'] = 'error'): void {
    try {
      if (!this.transport) return;
      const e = err as { message?: string; name?: string; stack?: string };
      this.push({
        kind: 'error',
        message: truncateUtf8(String(e?.message ?? err), 8192),
        level,
        timestamp: new Date().toISOString(),
        type: e?.name,
        stack: e?.stack ? truncateUtf8(e.stack, 32768) : undefined,
        context: ctx ? (sanitize(ctx) as Record<string, unknown>) : undefined,
        environment: this.environment, release: this.release, service: this.service,
        user: this.user ?? undefined,
      });
    } catch { /* fail open */ }
  }

  captureMessage(message: string, ctx?: Record<string, unknown>, level: ErrorItem['level'] = 'info'): void {
    try {
      if (!this.transport) return;
      this.push({
        kind: 'error', message: truncateUtf8(message, 8192), level,
        timestamp: new Date().toISOString(),
        context: ctx ? (sanitize(ctx) as Record<string, unknown>) : undefined,
        environment: this.environment, release: this.release, service: this.service,
        user: this.user ?? undefined,
      });
    } catch { /* fail open */ }
  }

  /** Custom business event (booking.created, payment.failed, ...). */
  track(name: string, properties?: Record<string, unknown>): void {
    try {
      if (!this.transport) return;
      this.push({
        kind: 'event', name, occurred_at: new Date().toISOString(),
        properties: properties ? (sanitize({ ...properties, environment: this.environment, release: this.release, service: this.service }) as Record<string, unknown>) : undefined,
      });
    } catch { /* fail open */ }
  }

  /** Server request trace. Bodies/headers/cookies never attached. */
  trace(span: string, ms: number, statusCode: number, meta?: Record<string, unknown>): void {
    try {
      if (!this.transport || Math.random() > this.sampleRate) return;
      this.push({
        kind: 'trace', span, ms: Math.round(ms * 100) / 100, status_code: statusCode,
        status: statusCode >= 500 ? 'err' : statusCode >= 400 ? 'warn' : 'ok',
        timestamp: new Date().toISOString(),
        environment: this.environment, release: this.release, service: this.service,
        meta: meta ? (sanitize(meta) as Record<string, unknown>) : undefined,
      });
    } catch { /* fail open */ }
  }

  /** Feature flag: deterministic bucketing by hash(flag key, user id). */
  isEnabled(key: string, userId?: string, fallback = false): boolean {
    try {
      const rule = this.flags.get(key);
      if (!rule || !rule.enabled) return rule?.enabled ?? fallback;
      if (!rule.rollout || rule.rollout >= 100) return true;
      if (!userId) return fallback;
      return hashBucket(key, userId) < rule.rollout;
    } catch { return fallback; }
  }

  getVariant(key: string, userId?: string): string | null {
    try {
      const rule = this.flags.get(key);
      const variants = rule?.variants;
      if (!rule?.enabled || !variants?.length) return null;
      const total = variants.reduce((s, v) => s + v.weight, 0) || 1;
      let bucket = hashBucket(key, userId ?? 'anon') % 100;
      void total;
      for (const v of variants) { if ((bucket -= v.weight) < 0) return v.name; }
      return variants[0].name;
    } catch { return null; }
  }

  private async refreshFlags(): Promise<void> {
    try {
      if (!this.transport) return;
      const base = (process.env.WATCHUP_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(`${base}/api/v1/flags`, {
        headers: { Authorization: `Bearer ${process.env.WATCHUP_API_KEY ?? ''}`, 'X-Api-Key': process.env.WATCHUP_API_KEY ?? '' },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!res.ok) return;
      const json = (await res.json()) as { flags?: FlagRule[] };
      for (const f of json.flags ?? []) this.flags.set(f.key, f);
    } catch { /* flags stay cached; fail open */ }
  }

  async flush(): Promise<void> {
    if (this.flushing || !this.transport || this.queue.length === 0) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, MAX_BATCH_ITEMS);
        const body = JSON.stringify(envelope(this.service, batch));
        const r = await this.transport.send(body);
        this.lastFlushState = { at: new Date().toISOString(), ok: r.ok };
        if (!r.ok && r.retryable) {
          this.queue.unshift(...batch.slice(-50)); // requeue newest 50 only
          break;
        }
      }
    } catch { /* fail open */ }
    finally { this.flushing = false; }
  }

  async shutdown(): Promise<void> {
    try { if (this.timer) clearInterval(this.timer); } catch { /* ignore */ }
    try { if (this.flagTimer) clearInterval(this.flagTimer); } catch { /* ignore */ }
    await this.flush();
  }
}

export type { TraceItem };
