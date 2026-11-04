// KYC & KYB Compliance Engine — Prembly (IdentityPass) + Prembly MCP Server
// + Mandatory CAC Corporate Affairs Commission Verification + Biometric Face
// Verification + Strict Identity <-> Contact <-> CAC <-> Bank Name Alignment.
//
// Tier ladder:
//   Tier 0 — unverified
//   Tier 1 — NIN (11 digits) and/or BVN (11 digits) verified against NIMC/NIBSS via Prembly
//   Tier 2 — Tier 1 + Government ID + Live Camera Selfie Face Match / Liveness
//   Tier 3 — Tier 2 + Mandatory CAC (RC / BN / IT) + Office Location + Bank Name Alignment
//
// Sensitive PII: raw NIN/BVN are NEVER stored — only a masked form (`123****8901`)
// and verified legal/corporate names for strict payout alignment.
import { q } from '../../packages/database/db.js';
import { emit } from '../../packages/observability/emit.js';
import { getSetting } from '../settings/settings.service.js';
import { mediaService } from '../media/media.service.js';
import { guardKycAdapter } from './kyc-cost.guard.js';

export type KycStatus = 'PENDING' | 'UNDER_REVIEW' | 'VERIFIED' | 'REJECTED';
export type KycSubject = 'provider' | 'user';
export type KycDocKind = 'id_front' | 'id_back' | 'selfie' | 'cac' | 'address' | 'other';
export const KYC_DOC_KINDS: readonly KycDocKind[] = [
  'id_front', 'id_back', 'selfie', 'cac', 'address', 'other',
] as const;

export interface KycDocument {
  id: string;
  assetId: string;
  kind: KycDocKind;
  createdAt: string;
}

export interface KycCheckResult {
  passed: boolean;
  provider: string;
  confidence?: number;
  reference?: string;
  reason?: string;
  verifiedName?: string;
  verifiedPhone?: string;
  companyName?: string;
  rcNumber?: string;
  raw?: Record<string, unknown>;
}

export interface NameAlignmentInput {
  submittedName?: string | null;
  businessName?: string | null;
  ninLegalName?: string | null;
  bvnLegalName?: string | null;
  cacCompanyName?: string | null;
  bankAccountName?: string | null;
}

export interface NameAlignmentResult {
  aligned: boolean;
  score: number;
  personalAligned: boolean;
  cacAligned: boolean;
  bankAligned: boolean;
  verifiedLegalName: string | null;
  verifiedCacName: string | null;
  matchedTokens: string[];
  mismatchReason: string | null;
}

export interface KycAdapter {
  readonly name: string;
  verifyNin(nin: string): Promise<KycCheckResult>;
  verifyNinWithFace?(nin: string, selfieBase64: string): Promise<KycCheckResult>;
  verifyBvn(bvn: string): Promise<KycCheckResult>;
  verifyBvnWithFace?(bvn: string, selfieBase64: string): Promise<KycCheckResult>;
  verifyDocAndFace(idImageBase64: string, selfieBase64: string): Promise<KycCheckResult>;
  verifyFaceLiveness?(selfieBase64: string): Promise<KycCheckResult>;
  verifyCac(rcNumber: string, businessName?: string): Promise<KycCheckResult>;
  verifyBankAccount?(accountNumber: string, bankCode: string): Promise<KycCheckResult>;
}

const NIN_RE = /^\d{11}$/;
const BVN_RE = /^\d{11}$/;
const RC_RE = /^(RC|BN|IT)?[-/\s]?[A-Z0-9]{4,14}$/i;

export function maskId(raw: string): string {
  const clean = raw.replace(/\s+/g, '');
  if (clean.length < 7) return '***';
  return `${clean.slice(0, 3)}****${clean.slice(-4)}`;
}

export function normalizeCacNumber(raw: string): { prefix: 'RC' | 'BN' | 'IT'; digits: string; formatted: string } {
  const trimmed = raw.trim().toUpperCase().replace(/[\s\-/]+/g, '');
  const match = trimmed.match(/^(RC|BN|IT)?([A-Z0-9]+)$/);
  const prefix = (match?.[1] as 'RC' | 'BN' | 'IT' | undefined) ?? 'RC';
  const digits = match?.[2] ?? trimmed;
  return { prefix, digits, formatted: `${prefix}${digits}` };
}

// ── Nigerian Personal & Corporate Name Alignment Engine ─────────────────────
const STOP_WORDS = new Set([
  'MR', 'MRS', 'MISS', 'MS', 'DR', 'ENGR', 'CHIEF', 'ALHAJI', 'HAJIA', 'PASTOR', 'BARR',
  'LTD', 'LIMITED', 'PLC', 'NIG', 'NIGERIA', 'ENTERPRISE', 'ENTERPRISES', 'VENTURE',
  'VENTURES', 'SERVICES', 'SERVICE', 'COMPANY', 'CO', 'GLOBAL', 'SOLUTIONS', 'CONCEPTS',
  'INTEGRATED', 'TECHNICAL', 'AND', 'THE', 'OF',
]);

function tokenizeName(raw?: string | null): string[] {
  if (!raw) return [];
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

function tokenOverlapScore(aTokens: string[], bTokens: string[]): { score: number; matched: string[] } {
  if (aTokens.length === 0 || bTokens.length === 0) return { score: 0, matched: [] };
  const matched: string[] = [];
  for (const a of aTokens) {
    if (
      bTokens.some(
        (b) =>
          b === a ||
          (a.length >= 4 && b.startsWith(a)) ||
          (b.length >= 4 && a.startsWith(b)),
      )
    ) {
      matched.push(a);
    }
  }
  const minLen = Math.min(aTokens.length, bTokens.length);
  const ratio = matched.length / Math.max(1, minLen);
  return { score: Math.min(100, Math.round(ratio * 100)), matched };
}

export function verifyNameAlignment(input: NameAlignmentInput): NameAlignmentResult {
  const submittedTokens = tokenizeName(input.submittedName);
  const businessTokens = tokenizeName(input.businessName);
  const ninTokens = tokenizeName(input.ninLegalName);
  const bvnTokens = tokenizeName(input.bvnLegalName);
  const cacTokens = tokenizeName(input.cacCompanyName);
  const bankTokens = tokenizeName(input.bankAccountName);

  const verifiedLegalName = input.ninLegalName || input.bvnLegalName || null;
  const verifiedCacName = input.cacCompanyName || null;
  const legalTokens = tokenizeName(verifiedLegalName);

  const matchedSet = new Set<string>();

  // 1) Personal alignment: submittedName vs NIN/BVN legal name (if both exist)
  let personalAligned = false;
  let personalScore = 0;
  if (submittedTokens.length > 0 && (ninTokens.length > 0 || bvnTokens.length > 0)) {
    const refTokens = ninTokens.length > 0 ? ninTokens : bvnTokens;
    const cmp = tokenOverlapScore(submittedTokens, refTokens);
    personalScore = cmp.score;
    cmp.matched.forEach((t) => matchedSet.add(t));
    // Also check if NIN and BVN align with each other when both are supplied
    if (ninTokens.length > 0 && bvnTokens.length > 0) {
      const ninBvn = tokenOverlapScore(ninTokens, bvnTokens);
      personalScore = Math.min(personalScore, ninBvn.score);
    }
    personalAligned = personalScore >= 50;
  }

  // 2) Corporate (CAC) alignment: businessName vs cacCompanyName (or proprietor legal name)
  let cacAligned = true;
  let cacScore = 100;
  if (cacTokens.length > 0 && (businessTokens.length > 0 || legalTokens.length > 0)) {
    const bizCmp = businessTokens.length > 0 ? tokenOverlapScore(businessTokens, cacTokens) : { score: 0, matched: [] };
    const propCmp = legalTokens.length > 0 ? tokenOverlapScore(legalTokens, cacTokens) : { score: 0, matched: [] };
    cacScore = Math.max(bizCmp.score, propCmp.score);
    bizCmp.matched.forEach((t) => matchedSet.add(t));
    propCmp.matched.forEach((t) => matchedSet.add(t));
    cacAligned = cacScore >= 50;
  }

  // 3) Bank Account alignment: bankAccountName must align with verifiedLegalName OR verifiedCacName OR businessName
  let bankAligned = true;
  let bankScore = 100;
  if (bankTokens.length > 0) {
    const candidates = [legalTokens, cacTokens, businessTokens, submittedTokens].filter((t) => t.length > 0);
    if (candidates.length > 0) {
      let best = 0;
      for (const cand of candidates) {
        const cmp = tokenOverlapScore(bankTokens, cand);
        if (cmp.score > best) best = cmp.score;
        cmp.matched.forEach((t) => matchedSet.add(t));
      }
      bankScore = best;
      bankAligned = bankScore >= 50;
    }
  }

  const scores = [personalScore, cacScore, bankScore];
  const score = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const aligned = personalAligned && cacAligned && bankAligned;

  let mismatchReason: string | null = null;
  if (!personalAligned) {
    mismatchReason = ninTokens.length === 0 && bvnTokens.length === 0
      ? 'A verified NIN/BVN legal name is required for name alignment.'
      : 'Submitted profile name does not match NIN/BVN legal name.';
  } else if (!cacAligned) {
    mismatchReason = 'Entered business name does not match CAC registered company name.';
  } else if (!bankAligned) {
    mismatchReason = 'Bank account name does not match your verified legal name or CAC business name.';
  }

  return {
    aligned,
    score,
    personalAligned,
    cacAligned,
    bankAligned,
    verifiedLegalName,
    verifiedCacName,
    matchedTokens: Array.from(matchedSet),
    mismatchReason,
  };
}

// ── Prembly IdentityPass adapter ────────────────────────────────────────────
// Current API reference uses only X-API-Key for server calls. The public key
// belongs to client widgets; no App ID is required for these API endpoints.
class PremblyKycAdapter implements KycAdapter {
  readonly name = 'prembly';
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = process.env.PREMBLY_BASE_URL || 'https://api.prembly.com',
  ) {}

  private async post(path: string, body: Record<string, unknown>, fallbackPath?: string): Promise<Record<string, unknown>> {
    const base = this.baseUrl.replace(/\/$/, '').replace(/\/identitypass$/, '');
    const urlsFor = (candidatePath: string) => {
      if (candidatePath.startsWith('/api/v1/')) return [`${base}${candidatePath}`];
      const cleanPath = candidatePath.replace(/^\/identitypass/, '');
      return [`${base}/identitypass${cleanPath}`, `${base}${cleanPath}`];
    };
    const candidateUrls = urlsFor(path);
    if (fallbackPath) {
      candidateUrls.push(...urlsFor(fallbackPath));
    }

    let lastStatus = 0;
    for (const url of candidateUrls) {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-API-Key': this.apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        return (await res.json()) as Record<string, unknown>;
      }
      lastStatus = res.status;
      if (res.status !== 404) break;
    }
    throw new Error(`PREMBLY_HTTP_${lastStatus}`);
  }

  private extractLegalName(data: Record<string, unknown>): string | undefined {
    const parts = [
      data.firstname ?? data.firstName ?? data.first_name,
      data.middlename ?? data.middleName ?? data.middle_name,
      data.lastname ?? data.lastName ?? data.last_name ?? data.surname,
    ]
      .map((x) => (typeof x === 'string' ? x.trim() : ''))
      .filter(Boolean);
    if (parts.length > 0) return parts.join(' ');
    if (typeof data.fullName === 'string' && data.fullName.trim()) return data.fullName.trim();
    if (typeof data.name === 'string' && data.name.trim()) return data.name.trim();
    return undefined;
  }

  private interpret(r: Record<string, unknown>, extra?: Partial<KycCheckResult>): KycCheckResult {
    const v = (r.verification as Record<string, unknown> | undefined) ?? {};
    const data = ((r.data ?? r.nin_data ?? r.bvn_data ?? r.cac_data ?? {}) as Record<string, unknown>);
    const code = String(r.response_code ?? '');
    const vStatus = String(v.status ?? '').toUpperCase();
    const passed = Boolean(r.status) && code === '00' && (vStatus === 'VERIFIED' || !v.status);
    const conf = typeof r.confidence === 'number'
      ? r.confidence
      : typeof data.confidence === 'number'
        ? data.confidence
        : undefined;
    const verifiedName = extra?.verifiedName ?? this.extractLegalName(data);
    const companyName = extra?.companyName ?? (typeof data.company_name === 'string' ? data.company_name : typeof data.companyName === 'string' ? data.companyName : undefined);
    return {
      passed,
      provider: this.name,
      confidence: conf,
      reference: String(v.reference ?? r.reference ?? ''),
      reason: passed ? undefined : String(r.detail ?? r.message ?? `response_code=${code}`),
      verifiedName,
      companyName,
      ...extra,
    };
  }

  async verifyNin(nin: string): Promise<KycCheckResult> {
    if (!NIN_RE.test(nin)) return { passed: false, provider: this.name, reason: 'NIN_FORMAT' };
    try {
      const r = await this.post('/api/v1/verification/api/nin/', { number_nin: nin });
      return this.interpret(r);
    } catch (e) {
      return { passed: false, provider: this.name, reason: (e as Error).message };
    }
  }

  async verifyNinWithFace(nin: string, selfieBase64: string): Promise<KycCheckResult> {
    if (!NIN_RE.test(nin)) return { passed: false, provider: this.name, reason: 'NIN_FORMAT' };
    if (!selfieBase64) return { passed: false, provider: this.name, reason: 'SELFIE_MISSING' };
    try {
      const r = await this.post('/verification/nin_w_face', {
        number: nin,
        image: selfieBase64,
        face_confidence_threshold: 70,
      });
      return this.interpret(r);
    } catch (e) {
      return { passed: false, provider: this.name, reason: (e as Error).message };
    }
  }

  async verifyBvn(bvn: string): Promise<KycCheckResult> {
    if (!BVN_RE.test(bvn)) return { passed: false, provider: this.name, reason: 'BVN_FORMAT' };
    try {
      const r = await this.post('/api/v1/verification/api/bvn/', { number: bvn });
      return this.interpret(r);
    } catch (e) {
      return { passed: false, provider: this.name, reason: (e as Error).message };
    }
  }

  async verifyBvnWithFace(bvn: string, selfieBase64: string): Promise<KycCheckResult> {
    if (!BVN_RE.test(bvn)) return { passed: false, provider: this.name, reason: 'BVN_FORMAT' };
    if (!selfieBase64) return { passed: false, provider: this.name, reason: 'SELFIE_MISSING' };
    try {
      const r = await this.post('/verification/bvn_w_face', {
        number: bvn,
        image: selfieBase64,
        face_confidence_threshold: 70,
      });
      return this.interpret(r);
    } catch (e) {
      return { passed: false, provider: this.name, reason: (e as Error).message };
    }
  }

  async verifyDocAndFace(idImageBase64: string, selfieBase64: string): Promise<KycCheckResult> {
    if (!idImageBase64 || !selfieBase64) {
      return { passed: false, provider: this.name, reason: 'DOC_OR_SELFIE_MISSING' };
    }
    try {
      const r = await this.post('/verification/document_w_face', {
        doc_image: idImageBase64,
        selfie_image: selfieBase64,
        doc_type: 'ID_CARD',
        doc_country: 'NG',
      });
      const base = this.interpret(r);
      if (base.passed && typeof base.confidence === 'number' && base.confidence < 70) {
        return { ...base, passed: false, reason: `LOW_FACE_CONFIDENCE_${base.confidence}` };
      }
      return base;
    } catch (e) {
      return { passed: false, provider: this.name, reason: (e as Error).message };
    }
  }

  async verifyFaceLiveness(selfieBase64: string): Promise<KycCheckResult> {
    if (!selfieBase64) return { passed: false, provider: this.name, reason: 'SELFIE_MISSING' };
    try {
      const r = await this.post('/verification/biometrics/face-liveliness', { image: selfieBase64 });
      const base = this.interpret(r);
      return base;
    } catch (e) {
      return { passed: false, provider: this.name, reason: (e as Error).message };
    }
  }

  async verifyCac(rcNumber: string, businessName?: string): Promise<KycCheckResult> {
    if (!RC_RE.test(rcNumber.trim())) {
      return { passed: false, provider: this.name, reason: 'RC_FORMAT' };
    }
    const norm = normalizeCacNumber(rcNumber);
    try {
      const r = await this.post(
        '/verification/cac/basic',
        {
          rc_number: norm.digits,
          company_type: norm.prefix,
          type: norm.prefix,
          company_name: businessName,
        },
        '/verification/cac',
      );
      return this.interpret(r, { rcNumber: norm.formatted });
    } catch (e) {
      return { passed: false, provider: this.name, reason: (e as Error).message };
    }
  }

  async verifyBankAccount(accountNumber: string, bankCode: string): Promise<KycCheckResult> {
    if (!/^\d{10}$/.test(accountNumber)) {
      return { passed: false, provider: this.name, reason: 'ACCOUNT_NUMBER_FORMAT' };
    }
    try {
      const r = await this.post(
        '/verification/bank_account/basic',
        {
          number: accountNumber,
          bank_code: bankCode,
        },
        '/verification/bank_account',
      );
      const data = ((r.data ?? r.account_data ?? {}) as Record<string, unknown>);
      const accountName = String(data.account_name ?? data.accountName ?? '');
      return this.interpret(r, { verifiedName: accountName || undefined });
    } catch (e) {
      return { passed: false, provider: this.name, reason: (e as Error).message };
    }
  }
}

// ── Dojah Adapter (Secondary Fallback) ──────────────────────────────────────
class DojahKycAdapter implements KycAdapter {
  readonly name = 'dojah';
  constructor(
    private readonly secretKey: string,
    private readonly appId: string,
    private readonly baseUrl = process.env.DOJAH_BASE_URL || 'https://api.dojah.io',
  ) {}

  private async req(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': this.secretKey,
        'AppId': this.appId,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`DOJAH_HTTP_${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  async verifyNin(nin: string): Promise<KycCheckResult> {
    if (!NIN_RE.test(nin)) return { passed: false, provider: this.name, reason: 'NIN_FORMAT' };
    try {
      const r = await this.req('GET', `/api/v1/kyc/nin?nin=${encodeURIComponent(nin)}`);
      const entity = (r.entity as Record<string, unknown> | undefined) ?? {};
      const passed = Boolean(entity.nin || entity.firstname);
      const verifiedName = [entity.firstname, entity.middlename, entity.surname].filter(Boolean).join(' ') || undefined;
      return { passed, provider: this.name, reference: String(entity.nin ?? ''), verifiedName, reason: passed ? undefined : 'NOT_FOUND' };
    } catch (e) {
      return { passed: false, provider: this.name, reason: (e as Error).message };
    }
  }

  async verifyBvn(bvn: string): Promise<KycCheckResult> {
    if (!BVN_RE.test(bvn)) return { passed: false, provider: this.name, reason: 'BVN_FORMAT' };
    try {
      const r = await this.req('GET', `/api/v1/kyc/bvn/full?bvn=${encodeURIComponent(bvn)}`);
      const entity = (r.entity as Record<string, unknown> | undefined) ?? {};
      const passed = Boolean(entity.bvn || entity.first_name);
      const verifiedName = [entity.first_name, entity.middle_name, entity.last_name].filter(Boolean).join(' ') || undefined;
      return { passed, provider: this.name, reference: String(entity.bvn ?? ''), verifiedName, reason: passed ? undefined : 'NOT_FOUND' };
    } catch (e) {
      return { passed: false, provider: this.name, reason: (e as Error).message };
    }
  }

  async verifyDocAndFace(idImageBase64: string, selfieBase64: string): Promise<KycCheckResult> {
    if (!idImageBase64 || !selfieBase64) return { passed: false, provider: this.name, reason: 'DOC_OR_SELFIE_MISSING' };
    try {
      const r = await this.req('POST', '/api/v1/kyc/photoid/verify', {
        selfie_image: selfieBase64,
        photoid_image: idImageBase64,
      });
      const entity = (r.entity as Record<string, unknown> | undefined) ?? {};
      const selfie = (entity.selfie as Record<string, unknown> | undefined) ?? {};
      const conf = typeof selfie.confidence_value === 'number' ? selfie.confidence_value : 0;
      const passed = Boolean(selfie.match) && conf >= 70;
      return { passed, provider: this.name, confidence: conf, reason: passed ? undefined : `CONF_${conf}` };
    } catch (e) {
      return { passed: false, provider: this.name, reason: (e as Error).message };
    }
  }

  async verifyCac(rcNumber: string): Promise<KycCheckResult> {
    if (!RC_RE.test(rcNumber.trim())) return { passed: false, provider: this.name, reason: 'RC_FORMAT' };
    const norm = normalizeCacNumber(rcNumber);
    try {
      const r = await this.req('GET', `/api/v1/kyc/cac?rc_number=${encodeURIComponent(norm.digits)}`);
      const entity = (r.entity as Record<string, unknown> | undefined) ?? {};
      const passed = Boolean(entity.company_name || entity.rc_number);
      return {
        passed,
        provider: this.name,
        reference: String(entity.rc_number ?? norm.formatted),
        companyName: typeof entity.company_name === 'string' ? entity.company_name : undefined,
        rcNumber: norm.formatted,
        reason: passed ? undefined : 'NOT_FOUND',
      };
    } catch (e) {
      return { passed: false, provider: this.name, reason: (e as Error).message };
    }
  }
}

// ── Prembly Sandbox / Local Dev Adapter ─────────────────────────────────────
// When PREMBLY_API_KEY is unset:
// - If PREMBLY_STRICT_UNCONFIGURED === 'true', fails closed (`KYC_PROVIDER_UNCONFIGURED`).
// - Otherwise (default local/sandbox/QA mode), validates format rules strictly
//   (11-digit NIN/BVN not starting with `0000`, valid RC/BN/IT format, non-empty
//   clean base64 images) and returns deterministic Prembly-shaped verification
//   results so full flow-state onboarding works out-of-the-box in dev & QA.
class PremblySandboxAdapter implements KycAdapter {
  readonly name = 'prembly';

  private isStrictClosed(): boolean {
    return process.env.NODE_ENV === 'production' || process.env.PREMBLY_STRICT_UNCONFIGURED === 'true';
  }

  async verifyNin(nin: string): Promise<KycCheckResult> {
    if (this.isStrictClosed()) return { passed: false, provider: 'none', reason: 'KYC_PROVIDER_UNCONFIGURED' };
    if (!NIN_RE.test(nin)) return { passed: false, provider: this.name, reason: 'NIN_FORMAT' };
    if (nin.startsWith('0000')) return { passed: false, provider: this.name, reason: 'NIN_NOT_FOUND' };
    return {
      passed: true,
      provider: this.name,
      reference: `prembly_nin_${nin.slice(-4)}`,
      confidence: 98,
    };
  }

  async verifyNinWithFace(nin: string, selfieBase64: string): Promise<KycCheckResult> {
    if (this.isStrictClosed()) return { passed: false, provider: 'none', reason: 'KYC_PROVIDER_UNCONFIGURED' };
    if (!NIN_RE.test(nin)) return { passed: false, provider: this.name, reason: 'NIN_FORMAT' };
    if (nin.startsWith('0000')) return { passed: false, provider: this.name, reason: 'NIN_NOT_FOUND' };
    if (!selfieBase64 || selfieBase64.length < 8) return { passed: false, provider: this.name, reason: 'SELFIE_MISSING' };
    return {
      passed: true,
      provider: this.name,
      reference: `prembly_nin_face_${nin.slice(-4)}`,
      confidence: 96.4,
    };
  }

  async verifyBvn(bvn: string): Promise<KycCheckResult> {
    if (this.isStrictClosed()) return { passed: false, provider: 'none', reason: 'KYC_PROVIDER_UNCONFIGURED' };
    if (!BVN_RE.test(bvn)) return { passed: false, provider: this.name, reason: 'BVN_FORMAT' };
    if (bvn.startsWith('0000')) return { passed: false, provider: this.name, reason: 'BVN_NOT_FOUND' };
    return {
      passed: true,
      provider: this.name,
      reference: `prembly_bvn_${bvn.slice(-4)}`,
      confidence: 99,
    };
  }

  async verifyBvnWithFace(bvn: string, selfieBase64: string): Promise<KycCheckResult> {
    if (this.isStrictClosed()) return { passed: false, provider: 'none', reason: 'KYC_PROVIDER_UNCONFIGURED' };
    if (!BVN_RE.test(bvn)) return { passed: false, provider: this.name, reason: 'BVN_FORMAT' };
    if (bvn.startsWith('0000')) return { passed: false, provider: this.name, reason: 'BVN_NOT_FOUND' };
    if (!selfieBase64 || selfieBase64.length < 8) return { passed: false, provider: this.name, reason: 'SELFIE_MISSING' };
    return {
      passed: true,
      provider: this.name,
      reference: `prembly_bvn_face_${bvn.slice(-4)}`,
      confidence: 95.8,
    };
  }

  async verifyDocAndFace(idImageBase64: string, selfieBase64: string): Promise<KycCheckResult> {
    if (this.isStrictClosed()) return { passed: false, provider: 'none', reason: 'KYC_PROVIDER_UNCONFIGURED' };
    if (!idImageBase64 || !selfieBase64) return { passed: false, provider: this.name, reason: 'DOC_OR_SELFIE_MISSING' };
    return {
      passed: true,
      provider: this.name,
      confidence: 94.2,
      reference: `prembly_doc_face_${Date.now().toString(36)}`,
    };
  }

  async verifyFaceLiveness(selfieBase64: string): Promise<KycCheckResult> {
    if (this.isStrictClosed()) return { passed: false, provider: 'none', reason: 'KYC_PROVIDER_UNCONFIGURED' };
    if (!selfieBase64 || selfieBase64.length < 8) return { passed: false, provider: this.name, reason: 'SELFIE_MISSING' };
    return {
      passed: true,
      provider: this.name,
      confidence: 97.5,
      reference: `prembly_liveness_${Date.now().toString(36)}`,
    };
  }

  async verifyCac(rcNumber: string, businessName?: string): Promise<KycCheckResult> {
    if (this.isStrictClosed()) return { passed: false, provider: 'none', reason: 'KYC_PROVIDER_UNCONFIGURED' };
    if (!RC_RE.test(rcNumber.trim())) return { passed: false, provider: this.name, reason: 'RC_FORMAT' };
    const norm = normalizeCacNumber(rcNumber);
    if (norm.digits.startsWith('0000')) return { passed: false, provider: this.name, reason: 'CAC_NOT_FOUND' };
    return {
      passed: true,
      provider: this.name,
      reference: `prembly_cac_${norm.formatted}`,
      rcNumber: norm.formatted,
      companyName: businessName?.trim() || `Kendibo VERIFIED VENDOR (${norm.formatted}) LTD`,
    };
  }

  async verifyBankAccount(accountNumber: string, bankCode: string): Promise<KycCheckResult> {
    if (this.isStrictClosed()) return { passed: false, provider: 'none', reason: 'KYC_PROVIDER_UNCONFIGURED' };
    if (!/^\d{10}$/.test(accountNumber) || !bankCode) {
      return { passed: false, provider: this.name, reason: 'ACCOUNT_NUMBER_FORMAT' };
    }
    return {
      passed: true,
      provider: this.name,
      reference: `prembly_bank_${accountNumber.slice(-4)}`,
    };
  }
}

/** Prembly secret (private) key: PREMBLY_SECRET_KEY, or the legacy PREMBLY_API_KEY name. */
export const premblySecret = () => (process.env.PREMBLY_SECRET_KEY || process.env.PREMBLY_API_KEY || '').trim();

export function selectKycAdapter(): KycAdapter {
  const pref = (process.env.KYC_PROVIDER || 'prembly').toLowerCase();
  // An explicit stub means no provider calls at all, even when keys are present.
  if (pref === 'stub') return new PremblySandboxAdapter();
  if (pref === 'prembly' && premblySecret()) {
    return new PremblyKycAdapter(premblySecret());
  }
  if (pref === 'dojah' && process.env.DOJAH_SECRET_KEY) {
    return new DojahKycAdapter(process.env.DOJAH_SECRET_KEY, process.env.DOJAH_APP_ID || '');
  }
  if (premblySecret()) {
    return new PremblyKycAdapter(premblySecret());
  }
  if (process.env.DOJAH_SECRET_KEY) {
    return new DojahKycAdapter(process.env.DOJAH_SECRET_KEY, process.env.DOJAH_APP_ID || '');
  }
  return new PremblySandboxAdapter();
}

async function recordCheck(
  subjectType: KycSubject,
  subjectId: string,
  tier: 1 | 2 | 3,
  kind: string,
  res: KycCheckResult,
  maskedInput?: string,
): Promise<void> {
  await q(
    `INSERT INTO kyc.verification_check
       (subject_type, subject_id, tier, check_kind, provider, status, confidence, masked_input, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      subjectType,
      subjectId,
      tier,
      kind,
      res.provider,
      res.passed ? 'passed' : 'failed',
      res.confidence ?? null,
      maskedInput ?? null,
      JSON.stringify({
        reference: res.reference,
        reason: res.reason,
        verifiedName: res.verifiedName,
        companyName: res.companyName,
        rcNumber: res.rcNumber,
      }),
    ],
  );
}

async function assetBase64(assetId: string): Promise<string | null> {
  // Media assets carry no inline bytes; read the clean file from storage.
  try {
    const { bytes } = await mediaService.readAsset(assetId);
    return bytes.length ? bytes.toString('base64') : null;
  } catch {
    return null;
  }
}

export interface TierRunInput {
  nin?: string;
  bvn?: string;
  rcNumber?: string;
  businessName?: string;
  submittedName?: string;
  bankAccountName?: string;
  selfieBase64?: string;
  documents?: { assetId: string; kind: KycDocKind }[];
  adapter?: KycAdapter;
}

export interface TierRunOutcome {
  tierReached: 0 | 1 | 2 | 3;
  provider: string;
  ninMasked?: string;
  bvnMasked?: string;
  cacNumber?: string;
  cacCompanyName?: string;
  cacVerified?: boolean;
  verifiedLegalName?: string;
  faceVerified?: boolean;
  faceConfidence?: number;
  nameAlignment?: NameAlignmentResult;
  checks: { tier: 1 | 2 | 3; kind: string; passed: boolean; reason?: string; confidence?: number }[];
}

export const kycService = {
  verifyNameAlignment,
  normalizeCacNumber,

  /** Attach uploaded media assets to the provider's KYC application. */
  async attachDocuments(
    providerId: string,
    docs: { assetId: string; kind: KycDocKind }[],
  ): Promise<KycDocument[]> {
    const out: KycDocument[] = [];
    for (const d of docs) {
      const asset = await mediaService.get(d.assetId);
      if (!asset) throw new Error('ASSET_NOT_FOUND');
      if (asset.status !== 'clean') throw new Error('ASSET_NOT_CLEAN');
      const rows = await q<Record<string, unknown>>(
        `INSERT INTO kyc.submission_document (provider_id, asset_id, kind)
         VALUES ($1, $2, $3)
         ON CONFLICT (provider_id, asset_id) DO NOTHING
         RETURNING id, asset_id, kind, created_at`,
        [providerId, d.assetId, d.kind],
      );
      if (rows[0]) {
        out.push({
          id: String(rows[0].id),
          assetId: String(rows[0].asset_id),
          kind: rows[0].kind as KycDocKind,
          createdAt: String(rows[0].created_at),
        });
      }
    }
    return out;
  },

  async attachUserDocuments(
    userId: string,
    docs: { assetId: string; kind: KycDocKind }[],
  ): Promise<KycDocument[]> {
    const out: KycDocument[] = [];
    for (const d of docs) {
      const asset = await mediaService.get(d.assetId);
      if (!asset) throw new Error('ASSET_NOT_FOUND');
      if (asset.status !== 'clean') throw new Error('ASSET_NOT_CLEAN');
      const rows = await q<Record<string, unknown>>(
        `INSERT INTO kyc.customer_document (user_id, asset_id, kind)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, asset_id) DO NOTHING
         RETURNING id, asset_id, kind, created_at`,
        [userId, d.assetId, d.kind],
      );
      if (rows[0]) {
        out.push({
          id: String(rows[0].id),
          assetId: String(rows[0].asset_id),
          kind: rows[0].kind as KycDocKind,
          createdAt: String(rows[0].created_at),
        });
      }
    }
    return out;
  },

  /**
   * Run Tier 1 -> Tier 2 -> Tier 3 Prembly checks + Name Alignment.
   */
  async runTierChecks(
    subjectType: KycSubject,
    subjectId: string,
    input: TierRunInput,
  ): Promise<TierRunOutcome> {
    // Live vendor calls go through the spend guard (cache, attempt limit,
    // budget caps, cost ledger). An injected adapter (tests) is used as-is.
    const adapter = input.adapter ?? guardKycAdapter(selectKycAdapter(), subjectType, subjectId);
    const checks: TierRunOutcome['checks'] = [];
    let tierReached: 0 | 1 | 2 | 3 = 0;
    let ninMasked: string | undefined;
    let bvnMasked: string | undefined;
    let cacNumber: string | undefined;
    let cacCompanyName: string | undefined;
    let cacVerified = false;
    let ninLegalName: string | undefined;
    let bvnLegalName: string | undefined;
    let faceVerified = false;
    let faceConfidence: number | undefined;

    const docs = input.documents ?? [];
    const selfieDoc = docs.find((d) => d.kind === 'selfie');
    const idDoc = docs.find((d) => d.kind === 'id_front') ?? docs.find((d) => d.kind === 'id_back');
    const selfieB64 = input.selfieBase64 || (selfieDoc ? await assetBase64(selfieDoc.assetId) : null);

    // ── Tier 1: NIN and/or BVN (with optional 1-step Prembly Face Match) ────
    let tier1Passed = false;
    if (input.nin) {
      const masked = maskId(input.nin);
      let r: KycCheckResult;
      if (selfieB64 && adapter.verifyNinWithFace) {
        r = await adapter.verifyNinWithFace(input.nin.trim(), selfieB64);
        await recordCheck(subjectType, subjectId, 1, 'nin_w_face', r, masked);
        checks.push({ tier: 1, kind: 'nin_w_face', passed: r.passed, reason: r.reason, confidence: r.confidence });
        if (r.passed) {
          faceVerified = true;
          faceConfidence = r.confidence;
        }
      } else {
        r = await adapter.verifyNin(input.nin.trim());
        await recordCheck(subjectType, subjectId, 1, 'nin', r, masked);
        checks.push({ tier: 1, kind: 'nin', passed: r.passed, reason: r.reason, confidence: r.confidence });
      }
      if (r.passed) {
        tier1Passed = true;
        ninMasked = masked;
        ninLegalName = r.verifiedName;
      }
    }
    if (input.bvn) {
      const masked = maskId(input.bvn);
      let r: KycCheckResult;
      if (!faceVerified && selfieB64 && adapter.verifyBvnWithFace) {
        r = await adapter.verifyBvnWithFace(input.bvn.trim(), selfieB64);
        await recordCheck(subjectType, subjectId, 1, 'bvn_w_face', r, masked);
        checks.push({ tier: 1, kind: 'bvn_w_face', passed: r.passed, reason: r.reason, confidence: r.confidence });
        if (r.passed) {
          faceVerified = true;
          faceConfidence = r.confidence;
        }
      } else {
        r = await adapter.verifyBvn(input.bvn.trim());
        await recordCheck(subjectType, subjectId, 1, 'bvn', r, masked);
        checks.push({ tier: 1, kind: 'bvn', passed: r.passed, reason: r.reason, confidence: r.confidence });
      }
      if (r.passed) {
        tier1Passed = true;
        bvnMasked = masked;
        bvnLegalName = r.verifiedName;
        if (!ninMasked) ninMasked = masked;
      }
    }
    if (!tier1Passed) {
      return { tierReached: 0, provider: adapter.name, ninMasked, bvnMasked, checks };
    }
    tierReached = 1;

    // ── Tier 2: Document + Selfie Face Match OR Biometric Liveness ──────────
    let tier2Passed = false;
    if (idDoc && selfieB64) {
      const idB64 = await assetBase64(idDoc.assetId);
      const r = await adapter.verifyDocAndFace(idB64 ?? '', selfieB64);
      await recordCheck(subjectType, subjectId, 2, 'doc_face', r);
      checks.push({ tier: 2, kind: 'doc_face', passed: r.passed, reason: r.reason, confidence: r.confidence });
      if (r.passed) {
        tier2Passed = true;
        faceVerified = true;
        faceConfidence = r.confidence ?? faceConfidence;
      }
    } else if (selfieB64 && adapter.verifyFaceLiveness) {
      const r = await adapter.verifyFaceLiveness(selfieB64);
      await recordCheck(subjectType, subjectId, 2, 'face_liveness', r);
      checks.push({ tier: 2, kind: 'face_liveness', passed: r.passed, reason: r.reason, confidence: r.confidence });
      if (r.passed) {
        tier2Passed = true;
        faceVerified = true;
        faceConfidence = r.confidence ?? faceConfidence;
      }
    } else if (faceVerified) {
      tier2Passed = true;
    }

    if (tier2Passed) {
      tierReached = 2;
    }

    // ── Tier 3: Mandatory CAC Corporate Affairs Commission Verification ─────
    if (input.rcNumber) {
      const norm = normalizeCacNumber(input.rcNumber);
      const r = await adapter.verifyCac(input.rcNumber.trim(), input.businessName);
      await recordCheck(subjectType, subjectId, 3, 'cac', r, norm.formatted);
      checks.push({ tier: 3, kind: 'cac', passed: r.passed, reason: r.reason });
      if (r.passed) {
        cacVerified = true;
        cacNumber = r.rcNumber ?? norm.formatted;
        cacCompanyName = r.companyName;
        if (tier2Passed) tierReached = 3;
      }
    } else if (tier2Passed && docs.some((d) => d.kind === 'address')) {
      const addrDoc = docs.find((d) => d.kind === 'address')!;
      const b64 = await assetBase64(addrDoc.assetId);
      const passed = Boolean(b64);
      await recordCheck(subjectType, subjectId, 3, 'address', {
        passed,
        provider: adapter.name,
        reason: passed ? undefined : 'ADDRESS_ASSET_NOT_CLEAN',
      });
      checks.push({ tier: 3, kind: 'address', passed });
      if (passed && subjectType === 'user') tierReached = 3;
    }

    // ── Strict Name Alignment Check (Personal <-> NIN/BVN <-> CAC <-> Bank) ─
    const nameAlignment = verifyNameAlignment({
      submittedName: input.submittedName,
      businessName: input.businessName,
      ninLegalName,
      bvnLegalName,
      cacCompanyName,
      bankAccountName: input.bankAccountName,
    });

    await recordCheck(
      subjectType,
      subjectId,
      tierReached > 0 ? (tierReached as 1 | 2 | 3) : 1,
      'name_alignment',
      {
        passed: nameAlignment.aligned,
        provider: adapter.name,
        confidence: nameAlignment.score,
        verifiedName: nameAlignment.verifiedLegalName ?? undefined,
        companyName: nameAlignment.verifiedCacName ?? undefined,
        reason: nameAlignment.mismatchReason ?? undefined,
      },
    );

    return {
      tierReached,
      provider: adapter.name,
      ninMasked,
      bvnMasked,
      cacNumber,
      cacCompanyName,
      cacVerified,
      verifiedLegalName: nameAlignment.verifiedLegalName ?? undefined,
      faceVerified,
      faceConfidence,
      nameAlignment,
      checks,
    };
  },

  /** Persist a provider tier outcome and auto-approve when tier >= threshold AND name-aligned. */
  async applyProviderTier(providerId: string, outcome: TierRunOutcome) {
    const minTier = Number((await getSetting('kyc.auto_verify_min_tier')) || 2);
    const aligned = outcome.nameAlignment ? outcome.nameAlignment.aligned : true;
    const autoVerify = outcome.tierReached >= minTier && aligned;
    const nextStatus: KycStatus = autoVerify ? 'VERIFIED' : 'UNDER_REVIEW';
    const rejectionReason = !aligned && outcome.nameAlignment?.mismatchReason
      ? outcome.nameAlignment.mismatchReason
      : null;

    await q(
      `UPDATE provider.provider
          SET kyc_status = $2,
              kyc_tier = GREATEST(kyc_tier, $3),
              kyc_provider = $4,
              nin_masked = COALESCE($5, nin_masked),
              bvn_masked = COALESCE($6, bvn_masked),
              cac_number = COALESCE($7, cac_number),
              cac_company_name = COALESCE($8, cac_company_name),
              cac_verified = CASE WHEN $9 THEN TRUE ELSE cac_verified END,
              verified_legal_name = COALESCE($10, verified_legal_name),
              face_verified = CASE WHEN $11 THEN TRUE ELSE face_verified END,
              face_confidence = COALESCE($12, face_confidence),
              name_aligned = $13,
              name_alignment_score = $14,
              kyc_submitted_at = COALESCE(kyc_submitted_at, now()),
              kyc_reviewed_at = CASE WHEN $2 = 'VERIFIED' THEN now() ELSE kyc_reviewed_at END,
              kyc_reviewed_by = CASE WHEN $2 = 'VERIFIED' THEN 'auto:' || $4 ELSE kyc_reviewed_by END,
              kyc_rejection_reason = $15,
              status = CASE WHEN $2 = 'VERIFIED' THEN 'active' ELSE status END,
              verify_level = CASE WHEN $2 = 'VERIFIED' THEN 'verified' ELSE verify_level END
        WHERE id = $1`,
      [
        providerId,
        nextStatus,
        outcome.tierReached,
        outcome.provider,
        outcome.ninMasked ?? null,
        outcome.bvnMasked ?? null,
        outcome.cacNumber ?? null,
        outcome.cacCompanyName ?? null,
        Boolean(outcome.cacVerified),
        outcome.verifiedLegalName ?? null,
        Boolean(outcome.faceVerified),
        outcome.faceConfidence ?? null,
        aligned,
        outcome.nameAlignment?.score ?? 100,
        rejectionReason,
      ],
    );
    emit(autoVerify ? 'kyc.auto_verified' : 'kyc.submitted', {
      providerId,
      tier: outcome.tierReached,
      provider: outcome.provider,
      cacVerified: outcome.cacVerified,
      nameAligned: aligned,
    });
    return this.status(providerId);
  },

  /** Customer KYC submission — runs Prembly checks + Name Alignment and updates `kyc.customer`. */
  async submitUserApplication(userId: string, input: TierRunInput) {
    // Load customer profile name for alignment check
    const userRows = await q<{ name: string | null }>(`SELECT name FROM identity.users WHERE id=$1`, [userId]);
    const submittedName = input.submittedName ?? userRows[0]?.name ?? undefined;
    const outcome = await this.runTierChecks('user', userId, { ...input, submittedName });
    // Customers can auto-verify at Tier 1 (NIN or BVN) or Tier 2 (NIN/BVN + Selfie)
    const minCustomerTier = 1;
    const aligned = outcome.nameAlignment ? outcome.nameAlignment.aligned : true;
    const autoVerify = outcome.tierReached >= minCustomerTier && aligned;
    const nextStatus: KycStatus = autoVerify ? 'VERIFIED' : 'UNDER_REVIEW';
    const fastTrackMethod = outcome.faceVerified ? 'prembly_biometric_fast_track' : 'prembly_nin_bvn_instant';

    await q(
      `INSERT INTO kyc.customer
         (user_id, status, tier, provider, nin_masked, bvn_masked, verified_legal_name,
          face_verified, face_confidence, name_aligned, name_alignment_score, fast_track_method,
          submitted_at, reviewed_at, reviewed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(),
               CASE WHEN $2 = 'VERIFIED' THEN now() ELSE NULL END,
               CASE WHEN $2 = 'VERIFIED' THEN 'auto:' || $4 ELSE NULL END)
       ON CONFLICT (user_id) DO UPDATE
         SET status = $2,
             tier = GREATEST(kyc.customer.tier, $3),
             provider = $4,
             nin_masked = COALESCE($5, kyc.customer.nin_masked),
             bvn_masked = COALESCE($6, kyc.customer.bvn_masked),
             verified_legal_name = COALESCE($7, kyc.customer.verified_legal_name),
             face_verified = CASE WHEN $8 THEN TRUE ELSE kyc.customer.face_verified END,
             face_confidence = COALESCE($9, kyc.customer.face_confidence),
             name_aligned = $10,
             name_alignment_score = $11,
             fast_track_method = $12,
             rejection_reason = $13,
             submitted_at = now(),
             reviewed_at = CASE WHEN $2 = 'VERIFIED' THEN now() ELSE kyc.customer.reviewed_at END,
             reviewed_by = CASE WHEN $2 = 'VERIFIED' THEN 'auto:' || $4 ELSE kyc.customer.reviewed_by END`,
      [
        userId,
        nextStatus,
        outcome.tierReached,
        outcome.provider,
        outcome.ninMasked ?? null,
        outcome.bvnMasked ?? null,
        outcome.verifiedLegalName ?? submittedName ?? null,
        Boolean(outcome.faceVerified),
        outcome.faceConfidence ?? null,
        aligned,
        outcome.nameAlignment?.score ?? 100,
        fastTrackMethod,
        !aligned ? outcome.nameAlignment?.mismatchReason ?? null : null,
      ],
    ).catch(async () => {
      // pg-mem fallback when ON CONFLICT DO UPDATE is unsupported
      const existing = await q(`SELECT user_id FROM kyc.customer WHERE user_id=$1`, [userId]);
      if (existing.length === 0) {
        await q(
          `INSERT INTO kyc.customer
             (user_id, status, tier, provider, nin_masked, bvn_masked, verified_legal_name,
              face_verified, face_confidence, name_aligned, name_alignment_score, fast_track_method, submitted_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())`,
          [
            userId, nextStatus, outcome.tierReached, outcome.provider,
            outcome.ninMasked ?? null, outcome.bvnMasked ?? null,
            outcome.verifiedLegalName ?? submittedName ?? null,
            Boolean(outcome.faceVerified), outcome.faceConfidence ?? null,
            aligned, outcome.nameAlignment?.score ?? 100, fastTrackMethod,
          ],
        );
      } else {
        await q(
          `UPDATE kyc.customer
              SET status=$2, tier=$3, provider=$4, nin_masked=COALESCE($5, nin_masked),
                  bvn_masked=COALESCE($6, bvn_masked), verified_legal_name=COALESCE($7, verified_legal_name),
                  face_verified=$8, face_confidence=$9, name_aligned=$10, name_alignment_score=$11,
                  fast_track_method=$12, submitted_at=now()
            WHERE user_id=$1`,
          [
            userId, nextStatus, outcome.tierReached, outcome.provider,
            outcome.ninMasked ?? null, outcome.bvnMasked ?? null,
            outcome.verifiedLegalName ?? submittedName ?? null,
            Boolean(outcome.faceVerified), outcome.faceConfidence ?? null,
            aligned, outcome.nameAlignment?.score ?? 100, fastTrackMethod,
          ],
        );
      }
    });
    emit(autoVerify ? 'kyc.user.auto_verified' : 'kyc.user.submitted', {
      userId,
      tier: outcome.tierReached,
      provider: outcome.provider,
      faceVerified: outcome.faceVerified,
    });
    return this.userStatus(userId);
  },

  async userStatus(userId: string) {
    const rows = await q<Record<string, unknown>>(
      `SELECT status, tier, provider, nin_masked, bvn_masked, verified_legal_name,
              face_verified, face_confidence, name_aligned, name_alignment_score,
              fast_track_method, rejection_reason, submitted_at, reviewed_at
         FROM kyc.customer WHERE user_id = $1`,
      [userId],
    );
    const docs = await this.userDocumentsFor(userId);
    const r = rows[0];
    return {
      userId,
      status: (r ? String(r.status) : 'PENDING') as KycStatus,
      tier: r ? Number(r.tier ?? 0) : 0,
      provider: r?.provider ? String(r.provider) : null,
      ninMasked: r?.nin_masked ? String(r.nin_masked) : null,
      bvnMasked: r?.bvn_masked ? String(r.bvn_masked) : null,
      verifiedLegalName: r?.verified_legal_name ? String(r.verified_legal_name) : null,
      faceVerified: Boolean(r?.face_verified),
      faceConfidence: r?.face_confidence != null ? Number(r.face_confidence) : null,
      nameAligned: r?.name_aligned != null ? Boolean(r.name_aligned) : true,
      nameAlignmentScore: r?.name_alignment_score != null ? Number(r.name_alignment_score) : 100,
      fastTrackMethod: r?.fast_track_method ? String(r.fast_track_method) : null,
      rejectionReason: r?.rejection_reason ? String(r.rejection_reason) : null,
      submittedAt: r?.submitted_at ? String(r.submitted_at) : null,
      reviewedAt: r?.reviewed_at ? String(r.reviewed_at) : null,
      documentCount: docs.length,
    };
  },

  async userApprove(userId: string, adminUserId: string): Promise<void> {
    await q(
      `UPDATE kyc.customer
          SET status = 'VERIFIED', rejection_reason = NULL,
              reviewed_at = now(), reviewed_by = $2
        WHERE user_id = $1`,
      [userId, adminUserId],
    );
    emit('kyc.user.approved', { userId, by: adminUserId });
  },

  async userReject(userId: string, reason: string, adminUserId: string): Promise<void> {
    await q(
      `UPDATE kyc.customer
          SET status = 'REJECTED', rejection_reason = $2,
              reviewed_at = now(), reviewed_by = $3
        WHERE user_id = $1`,
      [userId, reason, adminUserId],
    );
    emit('kyc.user.rejected', { userId, by: adminUserId, reason });
  },

  async userDocumentsFor(userId: string): Promise<KycDocument[]> {
    const rows = await q<Record<string, unknown>>(
      `SELECT id, asset_id, kind, created_at
         FROM kyc.customer_document
        WHERE user_id = $1
        ORDER BY created_at ASC`,
      [userId],
    );
    return rows.map((r) => ({
      id: String(r.id),
      assetId: String(r.asset_id),
      kind: r.kind as KycDocKind,
      createdAt: String(r.created_at),
    }));
  },

  /** Audit trail of automated checks for admin review. */
  async checksFor(subjectType: KycSubject, subjectId: string) {
    const rows = await q<Record<string, unknown>>(
      `SELECT id, tier, check_kind, provider, status, confidence, masked_input, detail, created_at
         FROM kyc.verification_check
        WHERE subject_type = $1 AND subject_id = $2
        ORDER BY created_at DESC LIMIT 50`,
      [subjectType, subjectId],
    );
    return rows.map((r) => ({
      id: String(r.id),
      tier: Number(r.tier),
      kind: String(r.check_kind),
      provider: String(r.provider),
      status: String(r.status),
      confidence: r.confidence != null ? Number(r.confidence) : null,
      maskedInput: r.masked_input ? String(r.masked_input) : null,
      detail: r.detail,
      createdAt: String(r.created_at),
    }));
  },

  /** Legacy untiered entry point — moves application into UNDER_REVIEW. */
  async submitApplication(providerId: string): Promise<{ providerId: string; status: KycStatus }> {
    await q(
      `UPDATE provider.provider
          SET kyc_status = 'UNDER_REVIEW',
              kyc_rejection_reason = NULL,
              kyc_submitted_at = now()
        WHERE id = $1 AND kyc_status <> 'VERIFIED'`,
      [providerId],
    );
    const rows = await q<{ kyc_status: string }>(
      `SELECT kyc_status FROM provider.provider WHERE id = $1`,
      [providerId],
    );
    const status = (rows[0]?.kyc_status ?? 'UNDER_REVIEW') as KycStatus;
    emit('kyc.submitted', { providerId, status });
    return { providerId, status };
  },

  async status(providerId: string) {
    const rows = await q<Record<string, unknown>>(
      `SELECT p.kyc_status, p.kyc_tier, p.kyc_provider, p.nin_masked, p.bvn_masked,
              p.cac_number, p.cac_company_name, p.cac_verified,
              p.verified_legal_name, p.face_verified, p.face_confidence,
              p.name_aligned, p.name_alignment_score, p.account_name, p.bank_name,
              p.office_address, p.storefront_completed, p.onboarding_step,
              p.kyc_rejection_reason, p.kyc_submitted_at, p.kyc_reviewed_at,
              u.name AS user_name
         FROM provider.provider p
         LEFT JOIN identity.users u ON u.id = p.user_id
        WHERE p.id = $1`,
      [providerId],
    );
    const r = rows[0];
    if (!r) return null;
    const docs = await this.documentsFor(providerId);
    return {
      providerId,
      status: String(r.kyc_status) as KycStatus,
      tier: Number(r.kyc_tier ?? 0),
      provider: r.kyc_provider ? String(r.kyc_provider) : null,
      ninMasked: r.nin_masked ? String(r.nin_masked) : null,
      bvnMasked: r.bvn_masked ? String(r.bvn_masked) : null,
      cacNumber: r.cac_number ? String(r.cac_number) : null,
      cacCompanyName: r.cac_company_name ? String(r.cac_company_name) : null,
      cacVerified: Boolean(r.cac_verified),
      verifiedLegalName: r.verified_legal_name ? String(r.verified_legal_name) : null,
      faceVerified: Boolean(r.face_verified),
      faceConfidence: r.face_confidence != null ? Number(r.face_confidence) : null,
      nameAligned: r.name_aligned != null ? Boolean(r.name_aligned) : false,
      nameAlignmentScore: r.name_alignment_score != null ? Number(r.name_alignment_score) : 0,
      bankAccountName: r.account_name ? String(r.account_name) : null,
      bankName: r.bank_name ? String(r.bank_name) : null,
      officeAddress: r.office_address ? String(r.office_address) : null,
      storefrontCompleted: Boolean(r.storefront_completed),
      onboardingStep: r.onboarding_step ? String(r.onboarding_step) : 'basic_info',
      rejectionReason: r.kyc_rejection_reason ? String(r.kyc_rejection_reason) : null,
      submittedAt: r.kyc_submitted_at ? String(r.kyc_submitted_at) : null,
      reviewedAt: r.kyc_reviewed_at ? String(r.kyc_reviewed_at) : null,
      documentCount: docs.length,
    };
  },

  async documentsFor(providerId: string): Promise<KycDocument[]> {
    const rows = await q<Record<string, unknown>>(
      `SELECT id, asset_id, kind, created_at
         FROM kyc.submission_document
        WHERE provider_id = $1
        ORDER BY created_at ASC`,
      [providerId],
    );
    return rows.map((r) => ({
      id: String(r.id),
      assetId: String(r.asset_id),
      kind: r.kind as KycDocKind,
      createdAt: String(r.created_at),
    }));
  },

  async markApproved(providerId: string, adminUserId: string): Promise<void> {
    await q(
      `UPDATE provider.provider
          SET kyc_status = 'VERIFIED',
              kyc_rejection_reason = NULL,
              kyc_reviewed_at = now(),
              kyc_reviewed_by = $2
        WHERE id = $1`,
      [providerId, adminUserId],
    );
    emit('kyc.approved', { providerId, by: adminUserId });
  },

  async reject(providerId: string, reason: string, adminUserId: string) {
    await q(
      `UPDATE provider.provider
          SET kyc_status = 'REJECTED',
              kyc_rejection_reason = $2,
              kyc_reviewed_at = now(),
              kyc_reviewed_by = $3,
              status = 'onboarding',
              verify_level = 'rejected',
              online = FALSE
        WHERE id = $1`,
      [providerId, reason, adminUserId],
    );
    emit('kyc.rejected', { providerId, by: adminUserId, reason });
    return { providerId, kycStatus: 'REJECTED' as const, reason };
  },

  // ── Prembly MCP Server Bridge (Model Context Protocol Tool Manifest & Executor) ──
  // Reference: https://docs.prembly.com/docs/the-prembly-mcp-server-a-complete-beginners-guide
  getMcpToolsManifest() {
    const remoteMcpUrl = process.env.PREMBLY_MCP_URL || 'https://mcp.prembly.com/mcp';
    return {
      mcpServer: 'prembly-identitypass-mcp',
      version: '1.0.0',
      docsUrl: 'https://docs.prembly.com/docs/the-prembly-mcp-server-a-complete-beginners-guide',
      remoteStreamableHttpConfig: {
        mcpServers: {
          prembly: {
            url: remoteMcpUrl,
          },
        },
      },
      configured: Boolean(premblySecret()),
      adapter: selectKycAdapter().name,
      tools: [
        {
          name: 'prembly_verify_nin',
          description: 'Verify Nigerian 11-digit National Identification Number (NIN) via Prembly IdentityPass.',
          inputSchema: { type: 'object', required: ['nin'], properties: { nin: { type: 'string' }, selfieBase64: { type: 'string' } } },
        },
        {
          name: 'prembly_verify_bvn',
          description: 'Verify Nigerian 11-digit Bank Verification Number (BVN) via Prembly IdentityPass.',
          inputSchema: { type: 'object', required: ['bvn'], properties: { bvn: { type: 'string' }, selfieBase64: { type: 'string' } } },
        },
        {
          name: 'prembly_verify_cac_kyb',
          description: 'Verify Nigerian Corporate Affairs Commission (CAC) RC, BN, or IT registration number and company name.',
          inputSchema: { type: 'object', required: ['rcNumber'], properties: { rcNumber: { type: 'string' }, businessName: { type: 'string' } } },
        },
        {
          name: 'prembly_verify_face_liveness',
          description: 'Perform biometric face liveness & anti-spoofing check on a vendor or customer selfie.',
          inputSchema: { type: 'object', required: ['selfieBase64'], properties: { selfieBase64: { type: 'string' } } },
        },
        {
          name: 'prembly_verify_bank_alignment',
          description: 'Resolve a 10-digit NUBAN bank account and verify strict name alignment with NIN/BVN legal name and CAC company name.',
          inputSchema: {
            type: 'object',
            required: ['accountNumber', 'bankCode'],
            properties: {
              accountNumber: { type: 'string' },
              bankCode: { type: 'string' },
              submittedName: { type: 'string' },
              businessName: { type: 'string' },
              ninLegalName: { type: 'string' },
              cacCompanyName: { type: 'string' },
            },
          },
        },
        // Short canonical names (the documented MCP surface); the longer names
        // above remain as aliases for existing callers.
        {
          name: 'prembly_verify_cac',
          description: 'Verify a CAC RC/BN/IT number; returns { verified, companyName, rcNumber }.',
          inputSchema: { type: 'object', required: ['rcNumber'], properties: { rcNumber: { type: 'string' }, companyName: { type: 'string' } } },
        },
        {
          name: 'prembly_verify_bank_account',
          description: 'Resolve a 10-digit NUBAN account and check the holder name against the vendor identity.',
          inputSchema: { type: 'object', required: ['accountNumber', 'bankCode'], properties: { accountNumber: { type: 'string' }, bankCode: { type: 'string' }, submittedName: { type: 'string' } } },
        },
        {
          name: 'prembly_check_name_alignment',
          description: 'Compare submitted, NIN/BVN legal, CAC and bank account names without calling a vendor (free).',
          inputSchema: { type: 'object', properties: { submittedName: { type: 'string' }, businessName: { type: 'string' }, ninLegalName: { type: 'string' }, bvnLegalName: { type: 'string' }, cacCompanyName: { type: 'string' }, bankAccountName: { type: 'string' } } },
        },
      ],
    };
  },

  /** Tool list only (what an MCP client's tools/list returns). */
  listMcpTools() {
    return this.getMcpToolsManifest().tools;
  },

  async executeMcpTool(toolName: string, args: Record<string, unknown>) {
    const adapter = selectKycAdapter();
    switch (toolName) {
      case 'prembly_verify_nin': {
        const nin = String(args.nin ?? '');
        const selfie = typeof args.selfieBase64 === 'string' ? args.selfieBase64 : '';
        if (selfie && adapter.verifyNinWithFace) return adapter.verifyNinWithFace(nin, selfie);
        return adapter.verifyNin(nin);
      }
      case 'prembly_verify_bvn': {
        const bvn = String(args.bvn ?? '');
        const selfie = typeof args.selfieBase64 === 'string' ? args.selfieBase64 : '';
        if (selfie && adapter.verifyBvnWithFace) return adapter.verifyBvnWithFace(bvn, selfie);
        return adapter.verifyBvn(bvn);
      }
      case 'prembly_verify_cac_kyb':
      case 'prembly_verify_cac': {
        const rcNumber = String(args.rcNumber ?? '');
        const name = typeof args.businessName === 'string' ? args.businessName
          : typeof args.companyName === 'string' ? args.companyName : undefined;
        const r = await adapter.verifyCac(rcNumber, name);
        return { ...r, verified: r.passed };
      }
      case 'prembly_check_name_alignment':
        return verifyNameAlignment({
          submittedName: typeof args.submittedName === 'string' ? args.submittedName : undefined,
          businessName: typeof args.businessName === 'string' ? args.businessName : undefined,
          ninLegalName: typeof args.ninLegalName === 'string' ? args.ninLegalName : undefined,
          bvnLegalName: typeof args.bvnLegalName === 'string' ? args.bvnLegalName : undefined,
          cacCompanyName: typeof args.cacCompanyName === 'string' ? args.cacCompanyName : undefined,
          bankAccountName: typeof args.bankAccountName === 'string' ? args.bankAccountName : undefined,
        });
      case 'prembly_verify_face_liveness': {
        const selfie = String(args.selfieBase64 ?? '');
        if (adapter.verifyFaceLiveness) return adapter.verifyFaceLiveness(selfie);
        return adapter.verifyDocAndFace(selfie, selfie);
      }
      case 'prembly_verify_bank_alignment':
      case 'prembly_verify_bank_account': {
        const accountNumber = String(args.accountNumber ?? '');
        const bankCode = String(args.bankCode ?? '');
        const bankRes = adapter.verifyBankAccount
          ? await adapter.verifyBankAccount(accountNumber, bankCode)
          : { passed: false, provider: adapter.name, verifiedName: undefined };
        const resolvedAccountName = bankRes.verifiedName;
        const alignment = verifyNameAlignment({
          submittedName: typeof args.submittedName === 'string' ? args.submittedName : undefined,
          businessName: typeof args.businessName === 'string' ? args.businessName : undefined,
          ninLegalName: typeof args.ninLegalName === 'string' ? args.ninLegalName : undefined,
          cacCompanyName: typeof args.cacCompanyName === 'string' ? args.cacCompanyName : undefined,
          bankAccountName: resolvedAccountName,
        });
        return {
          passed: bankRes.passed && Boolean(resolvedAccountName) && alignment.aligned,
          provider: adapter.name,
          accountName: resolvedAccountName,
          alignment,
        };
      }
      default:
        throw new Error(`UNKNOWN_PREMBLY_MCP_TOOL: ${toolName}`);
    }
  },
};
