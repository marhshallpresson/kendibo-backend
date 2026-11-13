// Admin console security: TOTP two-factor (RFC 6238, node:crypto only), login
// challenges, login lockout and session idle tracking.
//
// Sessions: access tokens are stateless 15-minute JWTs. Each login gets a
// device id (the refresh chain keeps it); it travels in the access token as
// `sid` and keys identity.admin_session, which records last activity and
// whether the session passed 2FA. A token with no sid (none are issued by the
// login routes any more) is not idle-tracked.
import crypto from 'node:crypto';
import { q } from '../../packages/database/db.js';
import { config } from '../../packages/config/env.js';

// ── env knobs (read per call so ops/tests can change them) ──────────────────
export const adminIdleTimeoutMin = () => {
  const n = Number(process.env.ADMIN_IDLE_TIMEOUT_MIN ?? 30);
  return Number.isFinite(n) && n > 0 ? n : 30;
};
export const adminTwoFactorRequired = () => String(process.env.ADMIN_2FA_REQUIRED ?? '').toLowerCase() === 'true';

export const LOCK_MAX_FAILURES = 5;
export const LOCK_WINDOW_MS = 15 * 60_000;
export const LOCK_DURATION_MS = 15 * 60_000;
const CHALLENGE_TTL_MS = 5 * 60_000;
const CHALLENGE_MAX_ATTEMPTS = 5;
const TOTP_STEP_SEC = 30;
const TOTP_DIGITS = 6;
const TOTP_ISSUER = 'Kendibo Admin';

// ── base32 (RFC 4648, no padding) ────────────────────────────────────────────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf: Buffer): string {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0; let value = 0; const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('BAD_BASE32');
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

// ── TOTP (RFC 6238 over RFC 4226 HOTP, HMAC-SHA1, 30 s, 6 digits) ───────────
function hotp(key: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', key).update(msg).digest();
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}
export const totpStep = (atMs = Date.now()) => Math.floor(atMs / 1000 / TOTP_STEP_SEC);
/** Current code for a base32 secret (used by tests and nothing else in prod). */
export function totpCode(secretB32: string, atMs = Date.now()): string {
  return hotp(base32Decode(secretB32), totpStep(atMs));
}
/**
 * Accepts the current step ±1 (clock drift). Returns the matched step, or null.
 * Steps <= lastUsedStep are refused so a seen code can't be replayed.
 */
export function totpMatch(secretB32: string, code: string, lastUsedStep = 0, atMs = Date.now()): number | null {
  if (!/^\d{6}$/.test(String(code ?? '').trim())) return null;
  const key = base32Decode(secretB32);
  const given = Buffer.from(String(code).trim());
  const now = totpStep(atMs);
  for (const step of [now - 1, now, now + 1]) {
    if (step <= lastUsedStep) continue;
    const want = Buffer.from(hotp(key, step));
    if (crypto.timingSafeEqual(want, given)) return step;
  }
  return null;
}

// ── secrets at rest: AES-256-GCM, key derived from server secrets ───────────
// ADMIN_2FA_ENC_KEY wins when set; otherwise the key is derived from the JWT
// access secret + media signing secret. Rotating those secrets without setting
// ADMIN_2FA_ENC_KEY to the old derivation forces admins to re-enroll.
function encKey(): Buffer {
  const explicit = process.env.ADMIN_2FA_ENC_KEY;
  const material = explicit
    ? `explicit|${explicit}`
    : `derived|${config.JWT_ACCESS_SECRET || 'dev-access-INSECURE-DEV-ONLY'}|${config.MEDIA_SIGN_SECRET || 'dev-media'}`;
  return crypto.createHash('sha256').update(`kendibo-admin-2fa:${material}`).digest();
}
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}
export function decryptSecret(enc: string): string | null {
  try {
    const [v, iv, tag, ct] = String(enc).split(':');
    if (v !== 'v1') return null;
    const d = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  } catch { return null; }
}

interface TwoFaRow { user_id: string; secret_enc: string | null; pending_secret_enc: string | null; enabled_at: string | null; last_used_step: string | number }
const twoFaRow = async (userId: string) =>
  (await q<TwoFaRow>(`SELECT * FROM identity.admin_2fa WHERE user_id=$1`, [userId]))[0] ?? null;
const ms = (v: unknown) => (v instanceof Date ? v.getTime() : v ? new Date(String(v)).getTime() : 0);

export const adminTwoFactor = {
  async enabled(userId: string): Promise<boolean> {
    const r = await twoFaRow(userId).catch(() => null);
    return Boolean(r?.enabled_at && r.secret_enc);
  },
  async status(userId: string) {
    const r = await twoFaRow(userId);
    return { enabled: Boolean(r?.enabled_at && r.secret_enc), pending: Boolean(r?.pending_secret_enc), enabledAt: r?.enabled_at ? String(r.enabled_at) : null };
  },
  /** New pending secret (replaces any earlier pending one). Refused when 2FA is already on. */
  async enroll(userId: string, label: string) {
    const r = await twoFaRow(userId);
    if (r?.enabled_at && r.secret_enc) throw new Error('TWO_FACTOR_ALREADY_ENABLED');
    const secret = base32Encode(crypto.randomBytes(20));
    const enc = encryptSecret(secret);
    if (r) await q(`UPDATE identity.admin_2fa SET pending_secret_enc=$2, updated_at=now() WHERE user_id=$1`, [userId, enc]);
    else await q(`INSERT INTO identity.admin_2fa (user_id, pending_secret_enc) VALUES ($1,$2)`, [userId, enc]);
    const account = encodeURIComponent(`${TOTP_ISSUER}:${label}`);
    const otpauthUrl = `otpauth://totp/${account}?secret=${secret}&issuer=${encodeURIComponent(TOTP_ISSUER)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SEC}`;
    return { secret, otpauthUrl };
  },
  /** Confirms the pending secret with a code from the app; 2FA is then on. */
  async confirm(userId: string, code: string): Promise<boolean> {
    const r = await twoFaRow(userId);
    if (!r?.pending_secret_enc) throw new Error('NO_PENDING_ENROLLMENT');
    const secret = decryptSecret(r.pending_secret_enc);
    if (!secret) throw new Error('NO_PENDING_ENROLLMENT');
    const step = totpMatch(secret, code, 0);
    if (step == null) return false;
    await q(`UPDATE identity.admin_2fa SET secret_enc=$2, pending_secret_enc=NULL, enabled_at=now(), last_used_step=$3, updated_at=now() WHERE user_id=$1`,
      [userId, r.pending_secret_enc, step]);
    return true;
  },
  /** Checks a code against the enabled secret (single use per step). */
  async check(userId: string, code: string): Promise<boolean> {
    const r = await twoFaRow(userId);
    if (!r?.enabled_at || !r.secret_enc) return false;
    const secret = decryptSecret(r.secret_enc);
    if (!secret) return false;
    const step = totpMatch(secret, code, Number(r.last_used_step ?? 0));
    if (step == null) return false;
    const claimed = await q(`UPDATE identity.admin_2fa SET last_used_step=$2, updated_at=now() WHERE user_id=$1 AND last_used_step < $2 RETURNING user_id`, [userId, step]);
    return Boolean(claimed[0]);
  },
  async disable(userId: string) {
    await q(`DELETE FROM identity.admin_2fa WHERE user_id=$1`, [userId]);
    await q(`DELETE FROM identity.admin_recovery_code WHERE user_id=$1`, [userId]);
  },
};

// ── recovery codes: one-time codes for a lost authenticator (057) ────────────
const RECOVERY_COUNT = 10;
// No 0/o/1/l/i so codes read back cleanly from paper or a screenshot.
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
/** Lowercase, no spaces or hyphens: "ABCD-EFGH" and "abcdefgh" are the same code. */
export const normalizeRecoveryCode = (code: string) => String(code ?? '').toLowerCase().replace(/[\s-]/g, '');
const hashRecoveryCode = (code: string) => crypto.createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
const randomRecoveryCode = () => {
  let s = '';
  for (let i = 0; i < 8; i++) s += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
};
export const adminRecoveryCodes = {
  /** Replaces every code for the user with a fresh set. Plaintext is returned once; only hashes are stored. */
  async regenerate(userId: string): Promise<string[]> {
    const codes = Array.from({ length: RECOVERY_COUNT }, randomRecoveryCode);
    await q(`DELETE FROM identity.admin_recovery_code WHERE user_id=$1`, [userId]);
    for (const c of codes) {
      await q(`INSERT INTO identity.admin_recovery_code (user_id, code_hash) VALUES ($1,$2)`, [userId, hashRecoveryCode(c)]);
    }
    return codes;
  },
  async remaining(userId: string): Promise<number> {
    const r = await q<{ n: string | number }>(`SELECT COUNT(*) AS n FROM identity.admin_recovery_code WHERE user_id=$1 AND used_at IS NULL`, [userId]);
    return Number(r[0]?.n ?? 0);
  },
  /** Spends an unused code (single use). Hashes are compared in constant time. */
  async consume(userId: string, code: string): Promise<boolean> {
    const want = Buffer.from(hashRecoveryCode(code), 'hex');
    const rows = await q<{ id: string; code_hash: string }>(`SELECT id, code_hash FROM identity.admin_recovery_code WHERE user_id=$1 AND used_at IS NULL`, [userId]);
    let hit: string | null = null;
    for (const r of rows) {
      const h = Buffer.from(String(r.code_hash), 'hex');
      if (h.length === want.length && crypto.timingSafeEqual(h, want) && hit == null) hit = String(r.id);
    }
    if (hit == null) return false;
    const claimed = await q(`UPDATE identity.admin_recovery_code SET used_at=now() WHERE id=$1 AND used_at IS NULL RETURNING id`, [hit]);
    return Boolean(claimed[0]);
  },
};

// ── login challenges (first factor passed, TOTP pending) ─────────────────────
export type ChallengeDevice = Record<string, unknown>;
export const adminLoginChallenge = {
  async create(userId: string, device: ChallengeDevice, ip: string | null, ua: string | null): Promise<string> {
    const rows = await q<{ id: string }>(
      `INSERT INTO identity.admin_login_challenge (user_id, device, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [userId, JSON.stringify(device ?? {}), ip, ua ? ua.slice(0, 300) : null, new Date(Date.now() + CHALLENGE_TTL_MS).toISOString()],
    );
    return String(rows[0].id);
  },
  /** Open challenge (unused, unexpired, attempts left), or null. */
  async open(id: string): Promise<{ id: string; userId: string; device: ChallengeDevice; attempts: number } | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const r = (await q<Record<string, unknown>>(`SELECT * FROM identity.admin_login_challenge WHERE id=$1`, [id]))[0];
    if (!r || r.used_at || ms(r.expires_at) < Date.now() || Number(r.attempts ?? 0) >= CHALLENGE_MAX_ATTEMPTS) return null;
    const device = typeof r.device === 'string' ? JSON.parse(r.device) : (r.device ?? {});
    return { id, userId: String(r.user_id), device: device as ChallengeDevice, attempts: Number(r.attempts ?? 0) };
  },
  async failedAttempt(id: string) {
    await q(`UPDATE identity.admin_login_challenge SET attempts = attempts + 1 WHERE id=$1`, [id]);
  },
  /** Single use: only one request wins. */
  async consume(id: string): Promise<boolean> {
    const rows = await q(`UPDATE identity.admin_login_challenge SET used_at=now() WHERE id=$1 AND used_at IS NULL RETURNING id`, [id]);
    return Boolean(rows[0]);
  },
};

// ── lockout: 5 failures / 15 min per account and per IP -> locked 15 min ────
export const lockKeys = (userId: string | null, ip: string | null) =>
  [userId ? `acct:${userId}` : null, ip ? `ip:${ip}` : null].filter(Boolean) as string[];

export const adminLoginLock = {
  /** Seconds until every key is unlocked (0 = not locked). */
  async retryAfter(keys: string[]): Promise<number> {
    let max = 0;
    for (const k of keys) {
      const r = (await q<{ locked_until: string | null }>(`SELECT locked_until FROM identity.admin_login_lock WHERE key=$1`, [k]))[0];
      const left = ms(r?.locked_until) - Date.now();
      if (left > max) max = left;
    }
    return max > 0 ? Math.ceil(max / 1000) : 0;
  },
  /** Records a failure on each key; returns seconds locked (0 if not yet locked). */
  async fail(keys: string[]): Promise<number> {
    const now = Date.now();
    for (const k of keys) {
      const r = (await q<{ failures: number; window_started_at: string; locked_until: string | null }>(
        `SELECT failures, window_started_at, locked_until FROM identity.admin_login_lock WHERE key=$1`, [k]))[0];
      if (!r) {
        await q(`INSERT INTO identity.admin_login_lock (key, failures, window_started_at) VALUES ($1,1,$2)`, [k, new Date(now).toISOString()]);
        continue;
      }
      const fresh = ms(r.window_started_at) < now - LOCK_WINDOW_MS && ms(r.locked_until) < now;
      const failures = fresh ? 1 : Number(r.failures ?? 0) + 1;
      const lockedUntil = failures >= LOCK_MAX_FAILURES ? new Date(now + LOCK_DURATION_MS).toISOString() : (fresh ? null : r.locked_until);
      await q(`UPDATE identity.admin_login_lock SET failures=$2, window_started_at=$3, locked_until=$4, updated_at=now() WHERE key=$1`,
        [k, failures, fresh ? new Date(now).toISOString() : r.window_started_at, lockedUntil]);
    }
    return this.retryAfter(keys);
  },
  /** A full successful login clears the account key (the IP key ages out). */
  async clear(userId: string) {
    await q(`DELETE FROM identity.admin_login_lock WHERE key=$1`, [`acct:${userId}`]);
  },
};

// ── admin sessions: idle timeout + 2FA marker ───────────────────────────────
export const adminSessions = {
  async start(userId: string, sid: string, mfa: boolean) {
    await q(`DELETE FROM identity.admin_session WHERE sid=$1`, [sid]);
    await q(`INSERT INTO identity.admin_session (sid, user_id, mfa_at, last_seen_at) VALUES ($1,$2,$3,now())`,
      [sid, userId, mfa ? new Date().toISOString() : null]);
  },
  async get(sid: string) {
    return (await q<{ sid: string; user_id: string; mfa_at: string | null; last_seen_at: string }>(
      `SELECT sid, user_id, mfa_at, last_seen_at FROM identity.admin_session WHERE sid=$1`, [sid]))[0] ?? null;
  },
  /**
   * 'idle' when the session has not been used within ADMIN_IDLE_TIMEOUT_MIN
   * (row removed; the caller revokes the device's refresh tokens). Otherwise
   * records activity (at most every 15 s) and reports whether it passed 2FA.
   */
  async touch(userId: string, sid: string): Promise<{ state: 'ok' | 'idle'; mfa: boolean }> {
    const r = await this.get(sid);
    if (!r || String(r.user_id) !== userId) {
      // A session from before tracking (or a role granted mid-session): start tracking now.
      await this.start(userId, sid, false);
      return { state: 'ok', mfa: false };
    }
    const idleMs = Date.now() - ms(r.last_seen_at);
    if (idleMs > adminIdleTimeoutMin() * 60_000) {
      await q(`DELETE FROM identity.admin_session WHERE sid=$1`, [sid]);
      return { state: 'idle', mfa: false };
    }
    if (idleMs > 15_000) await q(`UPDATE identity.admin_session SET last_seen_at=now() WHERE sid=$1`, [sid]);
    return { state: 'ok', mfa: Boolean(r.mfa_at) };
  },
  /** Refresh is refused for an idle admin session (refresh itself is not activity). */
  async idle(userId: string, sid: string): Promise<boolean> {
    const r = await this.get(sid);
    if (!r || String(r.user_id) !== userId) return false;
    return Date.now() - ms(r.last_seen_at) > adminIdleTimeoutMin() * 60_000;
  },
  async markMfa(sid: string) {
    await q(`UPDATE identity.admin_session SET mfa_at=now() WHERE sid=$1`, [sid]);
  },
  async revokeUser(userId: string) {
    await q(`DELETE FROM identity.admin_session WHERE user_id=$1`, [userId]);
  },
  async revokeSid(userId: string, sid: string) {
    await q(`DELETE FROM identity.admin_session WHERE sid=$1`, [sid]);
    await q(`DELETE FROM identity.refresh_token WHERE user_id=$1 AND device_id=$2`, [userId, sid]);
  },
};
