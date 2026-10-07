// Auth package — OTP in Postgres (identity.otp_code, survives restart),
// refresh tokens hashed in Postgres (identity.refresh_token) with rotation +
// reuse detection. JWT access 15m. No in-memory stores.
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { q } from '../database/db.js';

// Dev-only fallbacks. Production boot refuses empty secrets in env.ts,
// so these values can never serve api-kendibo.pxxlspace.cv traffic.
const ACCESS_SECRET = config.JWT_ACCESS_SECRET || 'dev-access-INSECURE-DEV-ONLY';
const REFRESH_SECRET = config.JWT_REFRESH_SECRET || 'dev-refresh-INSECURE-DEV-ONLY';

export async function issueOtp(channel: string, identity: string): Promise<{ code: string; devCode: string }> {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await q(`DELETE FROM identity.otp_code WHERE channel=$1 AND identity=$2`, [channel, identity]);
  await q(
    `INSERT INTO identity.otp_code (channel, identity, code, expires_at) VALUES ($1,$2,$3, now() + interval '5 minutes')`,
    [channel, identity, code],
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
  if (rec.code !== code) return false;
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
    if (!rec || rec.revoked) return null; // reuse detected -> reject
    await q(`UPDATE identity.refresh_token SET revoked=TRUE WHERE id=$1`, [p.jti]);
    const access = signAccess(p.sub, []);
    const next = await signRefresh(p.sub, p.deviceId);
    return { access, refresh: next.token };
  } catch { return null; }
}
export async function revokeAll(userId: string) {
  await q(`DELETE FROM identity.refresh_token WHERE user_id=$1`, [userId]);
}
export function verifyAccess(token: string): { sub: string; permissions: string[] } | null {
  try { return jwt.verify(token, config.JWT_ACCESS_SECRET) as { sub: string; permissions: string[] }; }
  catch { return null; }
}
