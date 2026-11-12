// Tells a real identity verdict apart from "the identity provider could not
// answer". Provider-side problems (no keys configured, unfunded wallet, quota or
// rate limit, timeouts, 5xx, network errors, our own spend cap, a thrown
// adapter) are NOT the applicant's fault: the application is saved and handed to
// admins for manual verification instead of being rejected.
// A real verdict (passed, or failed with a reason like NIN_NOT_FOUND or a name
// mismatch) keeps the normal flow.
export type KycOutcomeClass = 'passed' | 'failed' | 'unavailable';

/** pending_reason / kyc_pending_reason value for applications awaiting a human check. */
export const MANUAL_VERIFICATION = 'manual_verification';

/** Client-facing copy for an application waiting on manual verification. */
export const MANUAL_REVIEW_MESSAGE = "We've received your details. Our team will verify you shortly — usually within 24 hours.";

const UNAVAILABLE_RE = new RegExp(
  [
    'KYC_PROVIDER_UNCONFIGURED',
    'KYC_(DAILY|MONTHLY)_BUDGET_REACHED',
    'KYC_ADAPTER_ERROR',
    'INSUFFICIENT',
    'WALLET_BALANCE',
    'QUOTA',
    'RATE.?LIMIT',
    'TOO MANY REQUESTS',
    'TIME.?OUT',
    'TIMED.?OUT',
    'ABORTED',
    'PREMBLY_HTTP_\\d+',
    'DOJAH_HTTP_(401|402|403|408|429|5\\d\\d)',
    'FETCH FAILED',
    'NETWORK',
    'ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR',
    'SOCKET HANG UP',
    'SERVICE UNAVAILABLE',
    'TEMPORARILY UNAVAILABLE',
    'INTERNAL SERVER ERROR',
    'BAD GATEWAY',
    'GATEWAY TIME',
    'INVALID API KEY',
    'UNAUTHORI[SZ]ED',
  ].join('|'),
  'i',
);

interface CheckLike { passed: boolean; reason?: string; unavailable?: boolean }

export function classifyKycResult(r: CheckLike): KycOutcomeClass {
  if (r.passed) return 'passed';
  if (r.unavailable) return 'unavailable';
  return UNAVAILABLE_RE.test(String(r.reason ?? '')) ? 'unavailable' : 'failed';
}

export const isKycUnavailable = (r: CheckLike): boolean => classifyKycResult(r) === 'unavailable';

/** A thrown adapter call becomes an "unavailable" result, never a 500. */
export function unavailableFromError(e: unknown, provider: string) {
  const msg = e instanceof Error ? e.message : String(e);
  return {
    passed: false,
    provider,
    reason: `KYC_ADAPTER_ERROR: ${msg}`.slice(0, 300),
    unavailable: true,
  };
}
