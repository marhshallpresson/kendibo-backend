// KYC — independent provider-neutral port. No business code imports a vendor SDK.
// Active adapter selected by env: KYC_PROVIDER=stub (default) | dojah (disabled
// unless explicitly enabled with KYC_PROVIDER=dojah + DOJAH_API_KEY).
// The Dojah integration is fully implemented below but DISABLED by default.
import { q } from '../../packages/database/db.js';
import { emit } from '../../packages/observability/emit.js';

export type KycStatus = 'PENDING' | 'UNDER_REVIEW' | 'VERIFIED' | 'REJECTED';
export type KycDocumentKind = 'id_front' | 'id_back' | 'selfie' | 'cac' | 'other';
export interface KycDocument { id: string; assetId: string; kind: KycDocumentKind; createdAt: string }
export interface KycResult {
  providerId: string;
  status: KycStatus;
  checks: Record<string, boolean>;
  rejectionReason?: string | null;
  submittedAt?: string | null;
  documentCount?: number;
}
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
    // No fabrication: the stub cannot resolve bank ownership. Callers route
    // real resolution through /v1/payouts/resolve-account (Bachs); anything
    // that still lands here must see a negative result, never a fake name.
    void accountNumber;
    return { ok: false as const };
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
    const rows = await q<{
      kyc_status: string; kyc_rejection_reason: string | null;
      kyc_submitted_at: string | null; doc_count: string | number | null;
    }>(
      `SELECT p.kyc_status, p.kyc_rejection_reason, p.kyc_submitted_at,
              (SELECT COUNT(*) FROM kyc.submission_document d WHERE d.provider_id = p.id) AS doc_count
         FROM provider.provider p WHERE p.id=$1`,
      [providerId],
    );
    if (!rows[0]) return { providerId, status: 'PENDING', checks: {} };
    const s = (rows[0].kyc_status as KycStatus) ?? 'PENDING';
    return {
      providerId,
      status: (['PENDING', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED'] as string[]).includes(s) ? s : 'PENDING',
      checks: {},
      rejectionReason: rows[0].kyc_rejection_reason,
      submittedAt: rows[0].kyc_submitted_at,
      documentCount: Number(rows[0].doc_count ?? 0),
    };
  },
  /** Attach already-clean media assets to the provider's KYC application. */
  async attachDocuments(providerId: string, docs: Array<{ assetId: string; kind: KycDocumentKind }>): Promise<KycDocument[]> {
    for (const d of docs) {
      const asset = await q<{ status: string }>(`SELECT status FROM media.asset WHERE id=$1`, [d.assetId]);
      if (!asset[0]) throw new Error('ASSET_NOT_FOUND');
      if (String(asset[0].status) !== 'clean') throw new Error('ASSET_NOT_CLEAN');
      try {
        await q(`INSERT INTO kyc.submission_document (provider_id, asset_id, kind) VALUES ($1,$2,$3)`,
          [providerId, d.assetId, d.kind]);
      } catch { /* UNIQUE (provider_id, asset_id) — idempotent re-submit */ }
    }
    return this.documentsFor(providerId);
  },
  async documentsFor(providerId: string): Promise<KycDocument[]> {
    const rows = await q<{ id: string; asset_id: string; kind: string; created_at: string }>(
      `SELECT id, asset_id, kind, created_at FROM kyc.submission_document WHERE provider_id=$1 ORDER BY created_at ASC`,
      [providerId],
    );
    return rows.map((r) => ({
      id: String(r.id), assetId: String(r.asset_id), kind: r.kind as KycDocumentKind, createdAt: String(r.created_at),
    }));
  },
  /**
   * Full application received (docs and/or NIN/BVN) → queue for manual review.
   * This is the transition that makes the admin KYC queue reachable.
   */
  async submitForReview(providerId: string): Promise<KycResult> {
    await q(`UPDATE provider.provider SET kyc_status='UNDER_REVIEW', kyc_submitted_at=now(),
                    kyc_rejection_reason=NULL WHERE id=$1`, [providerId]);
    await q(`INSERT INTO audit.log (actor, action, entity_type, entity_id) VALUES ($1,$2,$3,$4)`,
      [providerId, 'kyc.submitted', 'provider', providerId]);
    emit('kyc.submitted', { providerId });
    return this.status(providerId);
  },
  /** Admin rejection: reason is mandatory so the provider can act on it. */
  async reject(providerId: string, reason: string, adminId: string): Promise<KycResult> {
    await q(`UPDATE provider.provider SET kyc_status='REJECTED', kyc_rejection_reason=$2,
                    kyc_reviewed_at=now(), kyc_reviewed_by=$3 WHERE id=$1`,
      [providerId, reason, adminId]);
    // verify_level back to pending so a resubmission can be approved cleanly.
    await q(`UPDATE provider.provider SET verify_level='pending' WHERE id=$1 AND verify_level<>'verified'`, [providerId]);
    await q(`INSERT INTO audit.log (actor, action, entity_type, entity_id, after) VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [adminId, 'kyc.rejected', 'provider', providerId, JSON.stringify({ reason })]);
    emit('kyc.completed', { providerId, status: 'REJECTED', reason });
    return this.status(providerId);
  },
  /** Admin approval timestamps alongside the verifyKyc status write. */
  async markApproved(providerId: string, adminId: string): Promise<void> {
    await q(`UPDATE provider.provider SET kyc_reviewed_at=now(), kyc_reviewed_by=$2,
                    kyc_rejection_reason=NULL WHERE id=$1`, [providerId, adminId]);
  },
};
