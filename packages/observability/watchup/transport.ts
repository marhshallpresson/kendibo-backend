// WatchUp HTTP transport — one batch POST, never raises. Failures return
// results so the queue decides retries. Mirrors the official SDK transport.
import { INGEST_PATH, idempotencyKey, backoffMs, MAX_ATTEMPTS } from './contract.js';

export interface SendResult { ok: boolean; status?: number; retryable: boolean; retryAfterMs?: number }

export class Transport {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private timeoutMs = 8000,
  ) {}

  private url(): string { return `${this.baseUrl.replace(/\/+$/, '')}${INGEST_PATH}`; }
  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      'X-Api-Key': this.apiKey,
      'Idempotency-Key': idempotencyKey(),
      'User-Agent': 'kendibo-watchup-node/1.0.0',
    };
  }

  async send(body: string): Promise<SendResult> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await fetch(this.url(), { method: 'POST', headers: this.headers(), body, signal: ctrl.signal });
        clearTimeout(timer);
        if (res.ok) return { ok: true, status: res.status, retryable: false };
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable || attempt === MAX_ATTEMPTS - 1) {
          return { ok: false, status: res.status, retryable };
        }
        const ra = res.headers.get('retry-after');
        await sleep(backoffMs(attempt, ra ? Number(ra) * 1000 : undefined));
      } catch {
        clearTimeout(timer);
        if (attempt === MAX_ATTEMPTS - 1) return { ok: false, retryable: true };
        await sleep(backoffMs(attempt));
      }
    }
    return { ok: false, retryable: true };
  }
}
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
