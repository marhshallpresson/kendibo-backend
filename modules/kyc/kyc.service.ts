// KYC — independent provider-neutral port. No business code imports a vendor SDK.
// Active adapter selected by env: KYC_PROVIDER=stub (default) | dojah (disabled
// unless explicitly enabled with KYC_PROVIDER=dojah + DOJAH_API_KEY).
// The Dojah integration is fully implemented below but DISABLED by default.
import { q } from '../../packages/database/db.js';
import { emit } from '../../packages/observability/emit.js';

export type KycStatus = 'PENDING' | 'UNDER_REVIEW' | 'VERIFIED' | 'REJECTED';
export interface KycResult { providerId: string; status: KycStatus; checks: Record<string, boolean> }
export interface KycPort {
  readonly name: string;
  readonly enabled: boolean;
  verifyIdentity(providerId: string, input: { nin?: string; bvn?: string; selfie?: string }): Promise<KycResult>;
  verifyBankAccount(accountNumber: string, bankCode: string): Promise<{ ok: boolean; name?: string }>;
}

async function persist(providerId: string, status: KycStatus, checks: Record<string, boolean>): Promise<KycResult> {
  await q(`UPDATE provider.provider SET kyc_status=$1 WHERE id=$2`, [status, providerId]);
  await q(`INSERT INTO audit.log (actor, action, entity_type, entity_id) VALUES ($1,$2,$3,$4)`,
    [providerId, `kyc.completed.status=${status}`, 'provider', providerId]);
  emit('kyc.completed', { providerId, status });
  return { providerId, status, checks };
}

/** Default: in-house manual-review flow. NIN/BVN presence -> UNDER_REVIEW for ops. */
export class StubKycAdapter implements KycPort {
  readonly name = 'stub';
  readonly enabled = true;
  async verifyIdentity(providerId: string, input: { nin?: string; bvn?: string }): Promise<KycResult> {
    const hasId = Boolean(input.nin || input.bvn);
    return persist(providerId, hasId ? 'UNDER_REVIEW' : 'PENDING', { document: hasId, liveness: false, manualReview: true });
  }
  async verifyBankAccount(accountNumber: string, _bankCode: string) {
    return { ok: accountNumber.length === 10, name: 'Unverified (stub)' };
  }
}

/**
 * Dojah integration — DISABLED unless KYC_PROVIDER=dojah AND DOJAH_API_KEY is set.
 * Kept in-tree so enabling is a config change, not a code change.
 * Docs: https://docs.dojah.io. Endpoints used when enabled:
 *   POST /api/v1/kyc/nin/verify, /bvn/verify, /selfie/verify, /bank/resolve
 */
export class DojahKycAdapter implements KycPort {
  readonly name = 'dojah';
  get enabled(): boolean {
    return process.env.KYC_PROVIDER === 'dojah' && Boolean(process.env.DOJAH_API_KEY);
  }
  private guard(): void {
    if (!this.enabled) throw new Error('KYC_PROVIDER_DISABLED');
  }
  private get base(): string { return process.env.DOJAH_BASE_URL ?? 'https://api.dojah.io'; }
  private get headers(): Record<string, string> {
    return { Authorization: `Bearer ${process.env.DOJAH_API_KEY ?? ''}`, 'Content-Type': 'application/json' };
  }
  async verifyIdentity(providerId: string, input: { nin?: string; bvn?: string; selfie?: string }): Promise<KycResult> {
    this.guard();
    const checks: Record<string, boolean> = { document: false, liveness: false, bank: false };
    try {
      if (input.nin) {
        const r = await fetch(`${this.base}/api/v1/kyc/nin/verify`, {
          method: 'POST', headers: this.headers, body: JSON.stringify({ nin: input.nin }),
        });
        checks.document = r.ok;
      } else if (input.bvn) {
        const r = await fetch(`${this.base}/api/v1/kyc/bvn/verify`, {
          method: 'POST', headers: this.headers, body: JSON.stringify({ bvn: input.bvn }),
        });
        checks.document = r.ok;
      }
      if (input.selfie) {
        const r = await fetch(`${this.base}/api/v1/kyc/selfie/verify`, {
          method: 'POST', headers: this.headers, body: JSON.stringify({ image: input.selfie }),
        });
        checks.liveness = r.ok;
      }
    } catch { /* network failure -> PENDING, ops retries; never throw into onboarding */ }
    const ok = checks.document;
    return persist(providerId, ok ? 'UNDER_REVIEW' : 'PENDING', checks);
  }
  async verifyBankAccount(accountNumber: string, bankCode: string) {
    this.guard();
    try {
      const r = await fetch(`${this.base}/api/v1/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`, {
        headers: this.headers,
      });
      if (!r.ok) return { ok: false };
      const j = (await r.json()) as { data?: { account_name?: string } };
      return { ok: true, name: j.data?.account_name };
    } catch {
      return { ok: false };
    }
  }
}

const dojah = new DojahKycAdapter();
const stub = new StubKycAdapter();

export const kycService = {
  /** Active adapter: dojah only when explicitly enabled, else independent stub. */
  get adapter(): KycPort { return dojah.enabled ? dojah : stub; },
  get activeProvider(): string { return dojah.enabled ? 'dojah' : 'stub'; },
  dojah, // exported for admin visibility; guard blocks use while disabled
  async status(providerId: string): Promise<KycResult> {
    const rows = await q<{ kyc_status: string }>(`SELECT kyc_status FROM provider.provider WHERE id=$1`, [providerId]);
    const s = (rows[0]?.kyc_status as KycStatus) ?? 'PENDING';
    return { providerId, status: ['PENDING', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED'].includes(s) ? s : 'PENDING', checks: {} };
  },
};
