// Auth package — OTP in Postgres (identity.otp_code, survives restart),
// refresh tokens hashed in Postgres (identity.refresh_token) with rotation +
// reuse detection. JWT access 15m. No in-memory stores.
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { q } from '../database/db.js';
import { isAdminRole, rolePerms } from '../../modules/authorization/rbac.js';

// Dev-only fallbacks. Production boot refuses empty secrets in env.ts,
// so these values can never serve api-kendibo.pxxlspace.cv traffic.
const ACCESS_SECRET = config.JWT_ACCESS_SECRET || 'dev-access-INSECURE-DEV-ONLY';
const REFRESH_SECRET = config.JWT_REFRESH_SECRET || 'dev-refresh-INSECURE-DEV-ONLY';

// OTPs are stored as a keyed hash: a DB read (backup, replica, SQL injection
// elsewhere) must not hand out live login codes.
const otpDigest = (channel: string, identity: string, code: string) =>
  crypto.createHmac('sha256', ACCESS_SECRET).update(`${channel}:${identity}:${code}`).digest('hex');

export async function issueOtp(channel: string, identity: string): Promise<{ code: string; devCode: string }> {
  const code = String(crypto.randomInt(100000, 1000000)); // CSPRNG, uniform 6 digits
  await q(`DELETE FROM identity.otp_code WHERE channel=$1 AND identity=$2`, [channel, identity]);
  await q(
    `INSERT INTO identity.otp_code (channel, identity, code, expires_at) VALUES ($1,$2,$3, now() + interval '5 minutes')`,
    [channel, identity, otpDigest(channel, identity, code)],
  );
  return { code, devCode: config.NODE_ENV === 'production' ? 'SENT' : code };
}
export async function verifyOtp(channel: string, identity: string, code: string): Promise<boolean> {
  const rows = await q<{ id: string; code: string; attempts: number; expires_at: string }>(
    `SELECT id, code, attempts, expires_at FROM identity.otp_code WHERE channel=$1 AND identity=$2 ORDER BY created_at DESC LIMIT 1`,
    [channel, identity],
  );
  const rec = rows[0];
  if (!rec || new Date(rec.expires_at).getTime() < Date.now() || rec.attempts >= 5) return false;
  // Claim the attempt atomically so parallel guesses can't all slip under the limit.
  const claimed = await q(`UPDATE identity.otp_code SET attempts = attempts + 1 WHERE id=$1 AND attempts < 5 RETURNING id`, [rec.id]);
  if (!claimed[0]) return false;
  const given = Buffer.from(otpDigest(channel, identity, String(code)));
  const stored = Buffer.from(String(rec.code));
  if (given.length !== stored.length || !crypto.timingSafeEqual(given, stored)) return false;
  await q(`DELETE FROM identity.otp_code WHERE id=$1`, [rec.id]);
  return true;
}

/**
 * sid = the refresh token's device id. It ties admin requests to a tracked
 * session (identity.admin_session: idle timeout, 2FA) while access tokens stay
 * stateless JWTs.
 */
export function signAccess(userId: string, permissions: string[], sid?: string): string {
  // ts: issue time in ms, so a revocation can tell tokens apart within one second.
  const ts = Date.now();
  return jwt.sign(sid ? { sub: userId, permissions, sid, ts } : { sub: userId, permissions, ts }, ACCESS_SECRET, { expiresIn: '15m' });
}
/** Verified subject of a refresh token (no DB, no rotation) — for pre-rotation account checks. */
export function refreshSubject(token: string): { sub: string; deviceId: string } | null {
  try {
    const p = jwt.verify(token, REFRESH_SECRET, { algorithms: ['HS256'] }) as { sub: string; deviceId: string };
    return p?.sub ? { sub: String(p.sub), deviceId: String(p.deviceId ?? '') } : null;
  } catch { return null; }
}
export async function signRefresh(userId: string, deviceId: string): Promise<{ token: string; id: string }> {
  const id = crypto.randomUUID();
  const token = jwt.sign({ sub: userId, deviceId, jti: id }, REFRESH_SECRET, { expiresIn: '45d' });
  const hash = crypto.createHash('sha256').update(token).digest('hex'); // never store raw
  await q(`INSERT INTO identity.refresh_token (id, user_id, device_id, token_hash) VALUES ($1,$2,$3,$4)`, [id, userId, deviceId, hash]);
  return { token, id };
}
const inflightRotations = new Map<string, Promise<{ access: string; refresh: string } | null>>();
const recentRotations = new Map<string, { userId: string; result: { access: string; refresh: string }; expiresAt: number }>();
const CONCURRENT_REFRESH_GRACE_MS = 2000;

export async function rotateRefresh(token: string): Promise<{ access: string; refresh: string } | null> {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const cached = recentRotations.get(tokenHash);
  if (cached) {
    if (cached.expiresAt > Date.now()) return cached.result;
    recentRotations.delete(tokenHash);
  }
  const inflight = inflightRotations.get(tokenHash);
  if (inflight) return inflight;
  const run = rotateRefreshOnce(token, tokenHash).finally(() => inflightRotations.delete(tokenHash));
  inflightRotations.set(tokenHash, run);
  return run;
}

async function rotateRefreshOnce(token: string, tokenHash: string): Promise<{ access: string; refresh: string } | null> {
  try {
    const p = jwt.verify(token, REFRESH_SECRET, { algorithms: ['HS256'] }) as { sub: string; deviceId: string; jti: string };
    const rows = await q<{ revoked: boolean }>(`SELECT revoked FROM identity.refresh_token WHERE id=$1`, [p.jti]);
    const rec = rows[0];
    if (!rec) return null;
    if (rec.revoked) {
      // A rotated-out token came back: someone holds a stolen copy. Kill every
      // session for the user so the thief's freshly rotated token dies too.
      await revokeAll(p.sub);
      return null;
    }
    // Single-use: only the request that flips revoked wins a concurrent race.
    const flipped = await q(`UPDATE identity.refresh_token SET revoked=TRUE WHERE id=$1 AND revoked=FALSE RETURNING id`, [p.jti]);
    if (!flipped[0]) return null;
    // Re-derive grants from the DB role so a refresh keeps (or loses) admin
    // rights exactly as the role currently says — never an empty grant list.
    const roleRows = await q<{ role: string; status: string | null }>(`SELECT role, status FROM identity.users WHERE id=$1`, [p.sub]);
    if (!roleRows[0] || String(roleRows[0].status ?? '') === 'suspended') return null;
    const role = String(roleRows[0].role ?? 'CUSTOMER').toUpperCase();
    const access = signAccess(p.sub, isAdminRole(role) ? [...rolePerms(role)] : ['booking:create', 'booking:view:self', 'booking:cancel'], p.deviceId);
    const next = await signRefresh(p.sub, p.deviceId);
    const result = { access, refresh: next.token };
    recentRotations.set(tokenHash, { userId: p.sub, result, expiresAt: Date.now() + CONCURRENT_REFRESH_GRACE_MS });
    return result;
  } catch { return null; }
}
export async function revokeAll(userId: string) {
  for (const [k, v] of recentRotations) if (v.userId === userId) recentRotations.delete(k);
  await q(`DELETE FROM identity.refresh_token WHERE user_id=$1`, [userId]);
}
export type AccessClaims = { sub: string; permissions: string[]; sid?: string; iat?: number; ts?: number };
export function verifyAccess(token: string): AccessClaims | null {
  // Same secret signAccess used (incl. the dev fallback) and HS256 only, so a
  // token can never pick its own algorithm.
  try { return jwt.verify(token, ACCESS_SECRET, { algorithms: ['HS256'] }) as AccessClaims; }
  catch { return null; }
}
