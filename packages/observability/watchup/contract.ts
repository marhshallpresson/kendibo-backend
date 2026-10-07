// WatchUp ingest contract — mirrored from the official SDK
// (watchup 2.1.0, https://docs.bachs.io-style docs at watchup.site/docs).
// Base: https://api.watchup.site | POST /api/v1/ingest/batch
// Auth: Authorization: Bearer <key> + X-Api-Key: <key> + Idempotency-Key.
// Kinds: errors | traces | events. Batched <=100 items, redaction +
// truncation client-side, backoff retries. Never throws into app code.
import { randomUUID } from 'node:crypto';

export const CONTRACT_VERSION = 1;
export const INGEST_PATH = '/api/v1/ingest/batch';
export const DEFAULT_BASE_URL = 'https://api.watchup.site';
export const SDK_NAME = 'kendibo-watchup-node';
export const SDK_VERSION = '1.0.0';
export const MAX_BATCH_ITEMS = 100;
export const MAX_QUEUE_ITEMS = 1000;
export const MAX_ATTEMPTS = 5;
export const BASE_BACKOFF_MS = 1000;
export const MAX_BACKOFF_MS = 30000;
export const REDACTED = '[REDACTED]';

const SENSITIVE_KEYS = new Set([
  'password', 'passwd', 'secret', 'api_key', 'apikey', 'access_token', 'refresh_token',
  'refreshToken', 'authorization', 'auth', 'token', 'otp', 'pin', 'card', 'cvv',
  'bvn', 'nin', 'account_number', 'accountNumber', 'cookie', 'cookies', 'set-cookie',
  'x-api-key', 'private_key', 'client_secret',
]);

export function redactKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase());
}

export function truncateUtf8(value: string, maxBytes: number): string {
  const raw = Buffer.from(value, 'utf-8');
  if (raw.length <= maxBytes) return value;
  return raw.subarray(0, maxBytes).toString('utf-8') + `…[truncated ${raw.length - maxBytes} bytes]`;
}

export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 10 || value === null || value === undefined) return value;
  if (typeof value === 'string') return truncateUtf8(value, 8192);
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => sanitize(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (n++ >= 200) break;
      out[k] = redactKey(k) ? REDACTED : sanitize(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface ErrorItem {
  kind: 'error';
  message: string;
  level: 'debug' | 'info' | 'warning' | 'error' | 'fatal';
  timestamp: string;
  type?: string;
  route?: string;
  stack?: string;
  context?: Record<string, unknown>;
  environment?: string;
  release?: string;
  service?: string;
  user?: { id: string; email?: string; name?: string };
}
export interface TraceItem {
  kind: 'trace';
  span: string;
  ms: number;
  status_code: number;
  status: 'ok' | 'warn' | 'err';
  timestamp: string;
  environment?: string;
  release?: string;
  service?: string;
  meta?: Record<string, unknown>;
  user?: { id: string };
}
export interface EventItem {
  kind: 'event';
  name: string;
  occurred_at: string;
  properties?: Record<string, unknown>;
}
export type Item = ErrorItem | TraceItem | EventItem;

export function envelope(service: string, items: Item[]): object {
  return {
    contract_version: CONTRACT_VERSION,
    sdk: { name: SDK_NAME, version: SDK_VERSION },
    service,
    items: items.map((i) => ({ ...sanitize(i) as object, kind: i.kind })),
  };
}

export function idempotencyKey(): string { return randomUUID(); }
export function backoffMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs) return Math.min(retryAfterMs, 60000);
  return Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
}
