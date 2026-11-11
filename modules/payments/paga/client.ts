// Paga API clients (https://developer-docs.paga.com). Three products, three
// auth styles, one hash rule:
//   hash = lowercase hex SHA-512 of the endpoint's listed values concatenated
//          with no separator, hash key last. Each endpoint lists its own fields.
// - Collect   (payment requests, status, refunds, banks): Basic publicKey:secretKey + `hash` header
// - Business  (transfers, airtime/data, bills, balance):  `principal` + `credentials` + `hash` headers
// - Checkout  (verify a hosted-page charge):              Basic only, no hash
// Keys and the hash key stay on the server; they never go into app bundles.
import crypto from 'node:crypto';

export type PagaEnv = 'sandbox' | 'live';

const HOSTS: Record<PagaEnv, { collect: string; business: string; checkout: string }> = {
  sandbox: {
    collect: 'https://beta-collect.paga.com',
    business: 'https://beta.mypaga.com/paga-webservices/business-rest/secured',
    checkout: 'https://beta-checkout.paga.com',
  },
  live: {
    collect: 'https://collect.paga.com',
    business: 'https://www.mypaga.com/paga-webservices/business-rest/secured',
    checkout: 'https://checkout.paga.com',
  },
};

export interface PagaConfig {
  env: PagaEnv;
  publicKey: string;
  secretKey: string;
  hashKey: string;
  timeoutMs: number;
}

/** Live keys only when PAGA_ENV=live is set on purpose; everything else is sandbox. */
export function pagaConfig(): PagaConfig {
  return {
    env: process.env.PAGA_ENV === 'live' ? 'live' : 'sandbox',
    publicKey: process.env.PAGA_PUBLIC_KEY ?? '',
    secretKey: process.env.PAGA_SECRET_KEY ?? '',
    hashKey: process.env.PAGA_HASH_KEY ?? '',
    timeoutMs: Number(process.env.PAGA_TIMEOUT_MS || 15_000),
  };
}

export const pagaConfigured = (c = pagaConfig()) => Boolean(c.publicKey && c.secretKey && c.hashKey);

/** values concatenated in order, hash key last, SHA-512, lowercase hex. */
export function pagaHash(values: Array<string | number | null | undefined>, hashKey: string): string {
  const joined = values.map((v) => (v === null || v === undefined ? '' : String(v))).join('') + hashKey;
  return crypto.createHash('sha512').update(joined, 'utf8').digest('hex');
}

/** Constant-time compare of two hex hashes. */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(String(a).toLowerCase());
  const y = Buffer.from(String(b).toLowerCase());
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export class PagaError extends Error {
  constructor(public code: string, message: string, public status?: number, public data?: unknown) {
    super(`PAGA_${code}: ${message}`);
  }
}

type Fetch = typeof fetch;

export class PagaClient {
  constructor(private cfg: PagaConfig = pagaConfig(), private doFetch: Fetch = fetch) {}

  get env(): PagaEnv { return this.cfg.env; }
  get publicKey(): string { return this.cfg.publicKey; }
  hash(values: Array<string | number | null | undefined>): string { return pagaHash(values, this.cfg.hashKey); }

  private ensure() {
    if (!pagaConfigured(this.cfg)) throw new PagaError('NOT_CONFIGURED', 'Paga keys are not set (PAGA_PUBLIC_KEY, PAGA_SECRET_KEY, PAGA_HASH_KEY)');
  }

  private async send(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
    let res: Response;
    try {
      res = await this.doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (e) {
      // Timeouts are "unknown outcome": callers must check status with the SAME reference.
      throw new PagaError('TIMEOUT', (e as Error).message);
    }
    const json = await res.json().catch(() => ({}));
    if (res.status === 401) throw new PagaError('UNAUTHORIZED', 'keys rejected or not for this environment', 401, json);
    if (res.status === 403) throw new PagaError('IP_NOT_WHITELISTED', 'server IP is not whitelisted at Paga', 403, json);
    if (res.status === 400) throw new PagaError('BAD_REQUEST', String((json as any)?.statusMessage ?? (json as any)?.message ?? 'validation failed (often the hash)'), 400, json);
    if (!res.ok) throw new PagaError(`HTTP_${res.status}`, 'Paga error', res.status, json);
    return json;
  }

  /** Collect API: Basic auth + hash header. */
  async collect(path: string, body: Record<string, unknown>, hashValues: Array<string | number | null | undefined>): Promise<any> {
    this.ensure();
    const auth = Buffer.from(`${this.cfg.publicKey}:${this.cfg.secretKey}`).toString('base64');
    return this.send(`${HOSTS[this.cfg.env].collect}${path}`, { Authorization: `Basic ${auth}`, hash: this.hash(hashValues) }, body);
  }

  /** Business API: principal + credentials + hash headers. */
  async business(method: string, body: Record<string, unknown>, hashValues: Array<string | number | null | undefined>): Promise<any> {
    this.ensure();
    return this.send(`${HOSTS[this.cfg.env].business}/${method}`, {
      principal: this.cfg.publicKey, credentials: this.cfg.secretKey, hash: this.hash(hashValues),
    }, body);
  }

  /** Checkout verify: Basic auth only. */
  async checkoutVerify(body: Record<string, unknown>): Promise<any> {
    this.ensure();
    const auth = Buffer.from(`${this.cfg.publicKey}:${this.cfg.secretKey}`).toString('base64');
    return this.send(`${HOSTS[this.cfg.env].checkout}/checkout/transaction/verify`, { Authorization: `Basic ${auth}` }, body);
  }
}

/** Kobo (bigint) → naira number for Paga bodies, e.g. 1250050n → 12500.5 */
export const koboToNaira = (kobo: bigint): number => Number(kobo) / 100;
/** Kobo → Paga Business "amount" string with two decimals, e.g. "12500.50" */
export const koboToNairaString = (kobo: bigint): string => {
  const neg = kobo < 0n; const abs = neg ? -kobo : kobo;
  return `${neg ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
};
/** Paga naira amount (number or string) → kobo, rounding half-kobo artefacts away. */
export const nairaToKobo = (n: number | string): bigint => BigInt(Math.round(Number(n) * 100));
