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
  await q(`UPDATE identity.otp_code SET attempts = attempts + 1 WHERE id=$1`, [rec.id]);
  const given = Buffer.from(otpDigest(channel, identity, String(code)));
  const stored = Buffer.from(String(rec.code));
  if (given.length !== stored.length || !crypto.timingSafeEqual(given, stored)) return false;
  await q(`DELETE FROM identity.otp_code WHERE id=$1`, [rec.id]);
  return true;
}

export function signAccess(userId: string, permissions: string[]): string {
  return jwt.sign({ sub: userId, permissions }, ACCESS_SECRET, { expiresIn: '15m' });
}
export async function signRefresh(userId: string, deviceId: string): Promise<{ token: string; id: string }> {
  const id = crypto.randomUUID();
  const token = jwt.sign({ sub: userId, deviceId, jti: id }, REFRESH_SECRET, { expiresIn: '45d' });
  const hash = crypto.createHash('sha256').update(token).digest('hex'); // never store raw
  await q(`INSERT INTO identity.refresh_token (id, user_id, device_id, token_hash) VALUES ($1,$2,$3,$4)`, [id, userId, deviceId, hash]);
  return { token, id };
}
export async function rotateRefresh(token: string): Promise<{ access: string; refresh: string } | null> {
  try {
    const p = jwt.verify(token, REFRESH_SECRET) as { sub: string; deviceId: string; jti: string };
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
    const roleRows = await q<{ role: string }>(`SELECT role FROM identity.users WHERE id=$1`, [p.sub]);
    if (!roleRows[0]) return null;
    const role = String(roleRows[0].role ?? 'CUSTOMER').toUpperCase();
    const access = signAccess(p.sub, isAdminRole(role) ? [...rolePerms(role)] : ['booking:create', 'booking:view:self', 'booking:cancel']);
    const next = await signRefresh(p.sub, p.deviceId);
    return { access, refresh: next.token };
  } catch { return null; }
}
export async function revokeAll(userId: string) {
  await q(`DELETE FROM identity.refresh_token WHERE user_id=$1`, [userId]);
}
export function verifyAccess(token: string): { sub: string; permissions: string[] } | null {
  // Same secret signAccess used (incl. the dev fallback) and HS256 only, so a
  // token can never pick its own algorithm.
  try { return jwt.verify(token, ACCESS_SECRET, { algorithms: ['HS256'] }) as { sub: string; permissions: string[] }; }
  catch { return null; }
}
