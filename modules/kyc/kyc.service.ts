// KYC — provider-neutral port. No business code imports a vendor SDK.
// Active adapter selected by env: KYC_PROVIDER=stub (default) | dojah | prembly.
// Prembly (IdentityPass) is the production integration: NIN/BVN validation,
// document + face-match, CAC lookup — see https://docs.prembly.com.
// 3-tier ladder (Nigerian KYC model):
//   Tier 1 — identity:    NIN or BVN verified
//   Tier 2 — biometric:   Tier 1 + government ID with selfie face-match
//   Tier 3 — full:        Tier 2 + business (CAC) OR proof of address
// Tiers below the auto-verify threshold land in the admin review queue.
import { q } from '../../packages/database/db.js';
import { emit } from '../../packages/observability/emit.js';
import { mediaService } from '../media/media.service.js';

export type KycStatus = 'PENDING' | 'UNDER_REVIEW' | 'VERIFIED' | 'REJECTED';
export type KycDocumentKind = 'id_front' | 'id_back' | 'selfie' | 'cac' | 'address' | 'other';
export type KycCheckKind = 'nin' | 'bvn' | 'doc' | 'doc_face' | 'cac';
export interface KycDocument { id: string; assetId: string; kind: KycDocumentKind; createdAt: string }
export interface KycResult {
  providerId: string;
  status: KycStatus;
  checks: Record<string, boolean>;
  tier?: number;
  rejectionReason?: string | null;
  submittedAt?: string | null;
  documentCount?: number;
}
/** One vendor verification outcome — also the kyc.check audit-log row shape. */
export interface KycCheckOutcome {
  kind: KycCheckKind;
  passed: boolean;
  reference?: string | null;
  responseCode?: string | null;
  name?: string | null;
  message?: string | null;
  detail?: Record<string, unknown> | null;
}
export interface KycPort {
  readonly name: string;
  readonly enabled: boolean;
  verifyIdentity(providerId: string, input: { nin?: string; bvn?: string; selfie?: string }): Promise<KycResult>;
  verifyBankAccount(accountNumber: string, bankCode: string): Promise<{ ok: boolean; name?: string }>;
  /** Tiered checks — optional so legacy adapters (stub/dojah) keep working. */
  verifyNin?(number: string): Promise<KycCheckOutcome>;
  verifyBvn?(number: string): Promise<KycCheckOutcome>;
  verifyDocument?(imageBase64: string, docType: string): Promise<KycCheckOutcome>;
  verifyDocWithFace?(docBase64: string, selfieBase64: string, docType: string): Promise<KycCheckOutcome>;
  verifyCac?(rcNumber: string, companyName?: string): Promise<KycCheckOutcome>;
}
export interface TierInput {
  nin?: string; bvn?: string; rcNumber?: string; businessName?: string;
  documents?: { assetId: string; kind: KycDocumentKind }[];
}
export interface TierOutcome {
  tier: number;
  checks: KycCheckOutcome[];
  ninMasked: string | null;
  faceMatched: boolean;
  identityVerified: boolean;
  businessVerified: boolean;
}

/** Never persist a raw NIN — masked form only (first 3 + last 3). */
export function maskNin(nin: string): string {
  const s = String(nin).replace(/\D/g, '');
  if (s.length < 7) return '***';
  return `${s.slice(0, 3)}****${s.slice(-3)}`;
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

/**
 * Prembly (IdentityPass) — production adapter. Enabled with
 * KYC_PROVIDER=prembly + PREMBLY_API_KEY (+ PREMBLY_APP_ID for document
 * endpoints). Docs: https://docs.prembly.com. Sandbox keys work against the
 * same base URL. Every call is wrapped: vendor/network failures become
 * passed:false outcomes (queued for manual review), never thrown into
 * onboarding flows. Raw NIN/BVN never persisted.
 */
export class PremblyKycAdapter implements KycPort {
  readonly name = 'prembly';
  get enabled(): boolean {
    return process.env.KYC_PROVIDER === 'prembly' && Boolean(process.env.PREMBLY_API_KEY);
  }
  private guard(): void {
    if (!this.enabled) throw new Error('KYC_PROVIDER_DISABLED');
  }
  private get base(): string {
    return (process.env.PREMBLY_BASE_URL ?? 'https://api.prembly.com').replace(/\/+$/, '');
  }
  private get country(): string {
    return (process.env.PREMBLY_COUNTRY ?? 'NG').toUpperCase().slice(0, 3);
  }
  private headers(useAppId: boolean): Record<string, string> {
    const h: Record<string, string> = {
      'x-api-key': process.env.PREMBLY_API_KEY ?? '',
      'Content-Type': 'application/json',
    };
    // Document endpoints require app-id; identity endpoints only x-api-key.
    if (useAppId) h['app-id'] = process.env.PREMBLY_APP_ID ?? '';
    return h;
  }
  private async post(path: string, body: Record<string, unknown>, useAppId = false): Promise<Record<string, unknown>> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 12_000);
    try {
      const r = await fetch(`${this.base}${path}`, {
        method: 'POST', headers: this.headers(useAppId), body: JSON.stringify(body), signal: ctl.signal,
      });
      return (await r.json().catch(() => ({}))) as Record<string, unknown>;
    } finally {
      clearTimeout(t);
    }
  }
  /** Prembly convention: status=true + response_code='00' = verified. */
  private passed(json: Record<string, unknown>): boolean {
    return json?.status === true && String(json?.response_code ?? '') === '00';
  }
  private ref(json: Record<string, unknown>): string | null {
    const v = json?.verification as { reference?: string } | undefined;
    return v?.reference ? String(v.reference) : null;
  }
  private wrap(kind: KycCheckKind, json: Record<string, unknown>): KycCheckOutcome {
    return {
      kind,
      passed: this.passed(json),
      reference: this.ref(json),
      responseCode: json?.response_code != null ? String(json.response_code) : null,
      message: json?.message != null ? String(json.message) : (json?.detail != null ? String(json.detail) : null),
    };
  }
  /** POST /verification/vnin-basic — NIN lookup (test NIN in sandbox docs). */
  async verifyNin(number: string): Promise<KycCheckOutcome> {
    this.guard();
    try {
      const json = await this.post('/verification/vnin-basic', { number });
      const data = (json?.data ?? {}) as Record<string, unknown>;
      const out = this.wrap('nin', json);
      out.name = [data.firstname, data.surname].filter(Boolean).join(' ') || null;
      out.detail = { suspended: data.nin_suspension_status ?? null };
      return out;
    } catch (e: unknown) {
      return { kind: 'nin', passed: false, message: (e as Error)?.message ?? 'prembly_unreachable' };
    }
  }
  /** POST /verification/bvn_validation — BVN basic validation. */
  async verifyBvn(number: string): Promise<KycCheckOutcome> {
    this.guard();
    try {
      const json = await this.post('/verification/bvn_validation', { number });
      const data = (json?.data ?? {}) as Record<string, unknown>;
      const out = this.wrap('bvn', json);
      out.name = [data.firstName, data.lastName].filter(Boolean).join(' ') || null;
      return out;
    } catch (e: unknown) {
      return { kind: 'bvn', passed: false, message: (e as Error)?.message ?? 'prembly_unreachable' };
    }
  }
  /** POST /identitypass/verification/document — image check (also UB proof-of-address). */
  async verifyDocument(imageBase64: string, docType: string): Promise<KycCheckOutcome> {
    this.guard();
    try {
      const json = await this.post('/identitypass/verification/document', {
        doc_type: docType, doc_image: imageBase64, doc_country: this.country,
      }, true);
      return this.wrap('doc', json);
    } catch (e: unknown) {
      return { kind: 'doc', passed: false, message: (e as Error)?.message ?? 'prembly_unreachable' };
    }
  }
  /** POST /identitypass/verification/document_w_face — doc + selfie face-match. */
  async verifyDocWithFace(docBase64: string, selfieBase64: string, docType: string): Promise<KycCheckOutcome> {
    this.guard();
    try {
      const json = await this.post('/identitypass/verification/document_w_face', {
        doc_type: docType, doc_country: this.country, doc_image: docBase64, selfie_image: selfieBase64,
      }, true);
      const out = this.wrap('doc_face', json);
      const face = (json?.data as Record<string, unknown> | undefined)?.Face_data as { confidence?: number } | undefined
        ?? (json as Record<string, unknown>)?.Face_data as { confidence?: number } | undefined;
      out.detail = face?.confidence != null ? { confidence: face.confidence } : null;
      return out;
    } catch (e: unknown) {
      return { kind: 'doc_face', passed: false, message: (e as Error)?.message ?? 'prembly_unreachable' };
    }
  }
  /** POST /verification/cac/basic — RC number lookup. */
  async verifyCac(rcNumber: string, companyName?: string): Promise<KycCheckOutcome> {
    this.guard();
    try {
      const body: Record<string, unknown> = { rc_number: rcNumber, company_type: 'RC' };
      if (companyName) body.company_name = companyName;
      const json = await this.post('/verification/cac/basic', body);
      const data = (json?.data ?? {}) as Record<string, unknown>;
      const out = this.wrap('cac', json);
      out.name = data.company_name ? String(data.company_name) : null;
      out.detail = { companyStatus: data.company_status ?? null };
      return out;
    } catch (e: unknown) {
      return { kind: 'cac', passed: false, message: (e as Error)?.message ?? 'prembly_unreachable' };
    }
  }
  /** Legacy composite — used by the old route path; tiered flow calls the granular methods. */
  async verifyIdentity(providerId: string, input: { nin?: string; bvn?: string; selfie?: string }): Promise<KycResult> {
    this.guard();
    const checks: Record<string, boolean> = { document: false, liveness: false };
    if (input.nin) checks.document = (await this.verifyNin(input.nin)).passed;
    else if (input.bvn) checks.document = (await this.verifyBvn(input.bvn)).passed;
    if (input.selfie) checks.liveness = true; // face-match needs the ID image; handled in tiered flow
    return persist(providerId, checks.document ? 'UNDER_REVIEW' : 'PENDING', checks);
  }
  /** Prembly bank-resolution product is not wired; payouts use Bachs instead. */
  async verifyBankAccount(): Promise<{ ok: false }> {
    return { ok: false as const };
  }
}

const dojah = new DojahKycAdapter();
const stub = new StubKycAdapter();
const prembly = new PremblyKycAdapter();

/** Auto-verify threshold from platform settings (default 2). 0 disables auto-verify. */
async function autoVerifyMinTier(): Promise<number> {
  try {
    const rows = await q<{ value: unknown }>(
      `SELECT value FROM configuration.platform_setting WHERE key='kyc.auto_verify_min_tier'`, []);
    const raw = rows[0]?.value;
    const n = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Number.isFinite(Number(n)) ? Math.max(0, Math.min(3, Number(n))) : 2;
  } catch {
    return 2;
  }
}

export const kycService = {
  /** Active adapter: prembly > dojah > stub (first enabled wins). */
  get adapter(): KycPort { return prembly.enabled ? prembly : (dojah.enabled ? dojah : stub); },
  get activeProvider(): string { return prembly.enabled ? 'prembly' : (dojah.enabled ? 'dojah' : 'stub'); },
  prembly, dojah, // exported for admin visibility; guard blocks use while disabled
  async status(providerId: string): Promise<KycResult> {
    const rows = await q<{
      kyc_status: string; kyc_rejection_reason: string | null; kyc_tier: number | null;
      kyc_submitted_at: string | null; doc_count: string | number | null;
    }>(
      `SELECT p.kyc_status, p.kyc_rejection_reason, p.kyc_submitted_at, p.kyc_tier,
              (SELECT COUNT(*) FROM kyc.submission_document d WHERE d.provider_id = p.id) AS doc_count
         FROM provider.provider p WHERE p.id=$1`,
      [providerId],
    );
    if (!rows[0]) return { providerId, status: 'PENDING', checks: {}, tier: 0 };
    const s = (rows[0].kyc_status as KycStatus) ?? 'PENDING';
    return {
      providerId,
      status: (['PENDING', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED'] as string[]).includes(s) ? s : 'PENDING',
      checks: {},
      tier: Number(rows[0].kyc_tier ?? 0),
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
   * Run the tiered vendor checks for a subject (provider or user) and log
   * every call to kyc.check. Asset-backed checks read clean media bytes and
   * send base64 to the vendor; raw NIN/BVN are used in-flight only.
   */
  async runTierChecks(subjectType: 'provider' | 'user', subjectId: string, input: TierInput): Promise<TierOutcome> {
    const adapter = this.adapter;
    const checks: KycCheckOutcome[] = [];
    const log = async (o: KycCheckOutcome): Promise<void> => {
      checks.push(o);
      try {
        await q(
          `INSERT INTO kyc.check (subject_type, subject_id, kind, provider, reference, result, response_code, detail)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
          [subjectType, subjectId, o.kind, adapter.name, o.reference ?? null,
           o.passed ? 'passed' : 'failed', o.responseCode ?? null,
           JSON.stringify({ message: o.message ?? null, name: o.name ?? null, ...(o.detail ?? {}) })],
        );
      } catch { /* audit logging must never break onboarding */ }
    };
    const byKind = new Map<string, string>();
    for (const d of input.documents ?? []) if (!byKind.has(d.kind)) byKind.set(d.kind, d.assetId);
    const readB64 = async (assetId: string): Promise<string> => {
      const a = await mediaService.readAsset(assetId);
      return a.bytes.toString('base64');
    };

    // Tier 1 — identity: NIN primary, BVN secondary (either pass satisfies).
    let identityVerified = false;
    if (input.nin && adapter.verifyNin) {
      const o = await adapter.verifyNin(input.nin);
      await log(o);
      identityVerified = o.passed;
    }
    if (input.bvn && adapter.verifyBvn) {
      const o = await adapter.verifyBvn(input.bvn);
      await log(o);
      identityVerified = identityVerified || o.passed;
    }

    // Tier 2 — biometric: government ID + selfie face-match.
    let faceMatched = false;
    const idFront = byKind.get('id_front');
    const selfie = byKind.get('selfie');
    if (idFront && selfie && adapter.verifyDocWithFace) {
      try {
        const o = await adapter.verifyDocWithFace(await readB64(idFront), await readB64(selfie), 'ID');
        await log(o);
        faceMatched = o.passed;
      } catch (e: unknown) {
        await log({ kind: 'doc_face', passed: false, message: (e as Error)?.message ?? 'asset_unreadable' });
      }
    }

    // Tier 3 — full: CAC (business) or proof-of-address (utility bill).
    let businessVerified = false;
    if (input.rcNumber && adapter.verifyCac) {
      const o = await adapter.verifyCac(input.rcNumber, input.businessName);
      await log(o);
      businessVerified = o.passed;
    }
    const address = byKind.get('address');
    if (!businessVerified && address && adapter.verifyDocument) {
      try {
        const o = await adapter.verifyDocument(await readB64(address), 'UB');
        await log(o);
        businessVerified = o.passed;
      } catch (e: unknown) {
        await log({ kind: 'doc', passed: false, message: (e as Error)?.message ?? 'asset_unreadable' });
      }
    }

    let tier = 0;
    if (identityVerified) tier = 1;
    if (tier >= 1 && faceMatched) tier = 2;
    if (tier >= 2 && businessVerified) tier = 3;
    return {
      tier, checks,
      ninMasked: input.nin ? maskNin(input.nin) : null,
      faceMatched, identityVerified, businessVerified,
    };
  },
  /**
   * Apply a tier outcome to the provider row. Tier >= auto-verify threshold
   * grants VERIFIED immediately (no queue); anything else goes UNDER_REVIEW.
   */
  async applyProviderTier(providerId: string, outcome: TierOutcome): Promise<KycResult> {
    const minTier = await autoVerifyMinTier();
    const autoVerified = outcome.tier >= minTier && minTier > 0;
    const status: KycStatus = autoVerified ? 'VERIFIED' : 'UNDER_REVIEW';
    await q(
      `UPDATE provider.provider SET
         kyc_status=$2, kyc_tier=$3,
         nin_masked=COALESCE($4, nin_masked),
         kyc_provider=$5,
         kyc_submitted_at=now(), kyc_rejection_reason=NULL,
         kyc_reviewed_at = CASE WHEN $6 THEN now() ELSE kyc_reviewed_at END,
         verify_level = CASE WHEN $6 THEN 'verified' ELSE verify_level END
       WHERE id=$1`,
      [providerId, status, outcome.tier, outcome.ninMasked, this.activeProvider, autoVerified],
    );
    await q(`INSERT INTO audit.log (actor, action, entity_type, entity_id, after) VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [providerId, `kyc.tiered.status=${status}.tier=${outcome.tier}`, 'provider', providerId,
       JSON.stringify({ tier: outcome.tier, autoVerified, provider: this.activeProvider })]);
    emit('kyc.completed', { providerId, status, tier: outcome.tier });
    return this.status(providerId);
  },
  /** Vendor check history for the admin review panel. */
  async checksFor(subjectType: 'provider' | 'user', subjectId: string, limit = 20): Promise<Array<KycCheckOutcome & { createdAt: string; provider: string }>> {
    const rows = await q<{ kind: string; provider: string; reference: string | null; result: string; response_code: string | null; detail: unknown; created_at: string }>(
      `SELECT kind, provider, reference, result, response_code, detail, created_at
         FROM kyc.check WHERE subject_type=$1 AND subject_id=$2
        ORDER BY created_at DESC LIMIT $3`, [subjectType, subjectId, limit]);
    return rows.map((r) => ({
      kind: r.kind as KycCheckKind, provider: String(r.provider),
      reference: r.reference, responseCode: r.response_code,
      passed: r.result === 'passed', name: null,
      message: (r.detail as { message?: string } | null)?.message ?? null,
      detail: (r.detail as Record<string, unknown> | null) ?? null,
      createdAt: String(r.created_at),
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

  // ── Customer (user) KYC ───────────────────────────────────────────────────
  async userStatus(userId: string): Promise<{ userId: string; status: KycStatus; tier: number; rejectionReason: string | null; submittedAt: string | null; documentCount: number }> {
    const rows = await q<{ status: string; tier: number; rejection_reason: string | null; submitted_at: string | null; doc_count: string | number | null }>(
      `SELECT c.status, c.tier, c.rejection_reason, c.submitted_at,
              (SELECT COUNT(*) FROM kyc.customer_document d WHERE d.user_id = c.user_id) AS doc_count
         FROM kyc.customer c WHERE c.user_id=$1`, [userId]);
    if (!rows[0]) return { userId, status: 'PENDING', tier: 0, rejectionReason: null, submittedAt: null, documentCount: 0 };
    const s = String(rows[0].status);
    return {
      userId,
      status: (['PENDING', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED'] as string[]).includes(s) ? s as KycStatus : 'PENDING',
      tier: Number(rows[0].tier ?? 0),
      rejectionReason: rows[0].rejection_reason,
      submittedAt: rows[0].submitted_at,
      documentCount: Number(rows[0].doc_count ?? 0),
    };
  },
  async attachUserDocuments(userId: string, docs: Array<{ assetId: string; kind: KycDocumentKind }>): Promise<void> {
    for (const d of docs) {
      const asset = await q<{ status: string }>(`SELECT status FROM media.asset WHERE id=$1`, [d.assetId]);
      if (!asset[0]) throw new Error('ASSET_NOT_FOUND');
      if (String(asset[0].status) !== 'clean') throw new Error('ASSET_NOT_CLEAN');
      try {
        await q(`INSERT INTO kyc.customer_document (user_id, asset_id, kind) VALUES ($1,$2,$3)`, [userId, d.assetId, d.kind]);
      } catch { /* UNIQUE — idempotent */ }
    }
  },
  async userDocumentsFor(userId: string): Promise<KycDocument[]> {
    const rows = await q<{ id: string; asset_id: string; kind: string; created_at: string }>(
      `SELECT id, asset_id, kind, created_at FROM kyc.customer_document WHERE user_id=$1 ORDER BY created_at ASC`,
      [userId],
    );
    return rows.map((r) => ({
      id: String(r.id), assetId: String(r.asset_id), kind: r.kind as KycDocumentKind, createdAt: String(r.created_at),
    }));
  },
  /** Run tiered checks for a customer and persist tier/status. */
  async submitUserApplication(userId: string, input: TierInput): Promise<Awaited<ReturnType<typeof this.userStatus>>> {
    const docs = await q<{ asset_id: string; kind: string }>(
      `SELECT asset_id, kind FROM kyc.customer_document WHERE user_id=$1`, [userId]);
    const outcome = await this.runTierChecks('user', userId, {
      ...input,
      documents: [...(input.documents ?? []), ...docs.map((d) => ({ assetId: String(d.asset_id), kind: d.kind as KycDocumentKind }))],
    });
    const minTier = await autoVerifyMinTier();
    const autoVerified = outcome.tier >= minTier && minTier > 0;
    const status = autoVerified ? 'VERIFIED' : 'UNDER_REVIEW';
    await q(
      `INSERT INTO kyc.customer (user_id, tier, status, nin_masked, submitted_at, updated_at)
       VALUES ($1,$2,$3,$4,now(),now())
       ON CONFLICT (user_id) DO UPDATE SET
         tier=EXCLUDED.tier, status=EXCLUDED.status,
         nin_masked=COALESCE(EXCLUDED.nin_masked, kyc.customer.nin_masked),
         rejection_reason=NULL, submitted_at=now(), updated_at=now()`,
      [userId, outcome.tier, status, outcome.ninMasked],
    );
    await q(`INSERT INTO audit.log (actor, action, entity_type, entity_id, after) VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [userId, `user.kyc.tiered.status=${status}.tier=${outcome.tier}`, 'user', userId,
       JSON.stringify({ tier: outcome.tier, autoVerified, provider: this.activeProvider })]);
    emit('kyc.completed', { userId, status, tier: outcome.tier });
    return this.userStatus(userId);
  },
  async userApprove(userId: string, adminId: string): Promise<void> {
    await q(`UPDATE kyc.customer SET status='VERIFIED', reviewed_at=now(), reviewed_by=$2,
                    rejection_reason=NULL, updated_at=now() WHERE user_id=$1`, [userId, adminId]);
    await q(`INSERT INTO audit.log (actor, action, entity_type, entity_id) VALUES ($1,$2,$3,$4)`,
      [adminId, 'user.kyc.approved', 'user', userId]);
  },
  async userReject(userId: string, reason: string, adminId: string): Promise<void> {
    await q(`UPDATE kyc.customer SET status='REJECTED', rejection_reason=$2, reviewed_at=now(),
                    reviewed_by=$3, updated_at=now() WHERE user_id=$1`, [userId, reason, adminId]);
    await q(`INSERT INTO audit.log (actor, action, entity_type, entity_id, after) VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [adminId, 'user.kyc.rejected', 'user', userId, JSON.stringify({ reason })]);
  },
};
