// Admin console passwords: scrypt hashes in identity.admin_credential.
// Format: scrypt$N$r$p$<salt b64>$<hash b64>. Only admin seats can hold one.
import crypto from 'node:crypto';
import { q } from '../../packages/database/db.js';
import { isAdminRole } from '../authorization/rbac.js';

const N = 16384, R = 8, P = 1, KEYLEN = 64;
export const MIN_PASSWORD_LENGTH = 12;

function scrypt(password: string, salt: Buffer, n = N, r = R, p = P): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, KEYLEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? reject(e) : resolve(k))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** Why a new password is refused, or null when it is acceptable. */
export function passwordProblem(pw: string, email?: string | null): string | null {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (pw.length > 200) return 'That password is too long.';
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return 'Use letters and numbers.';
  if (email && pw.toLowerCase().includes(String(email).split('@')[0].toLowerCase())) return 'Do not use your email name in the password.';
  return null;
}

// A dummy hash so unknown emails take as long as real ones (no account probing by timing).
let dummy: Promise<string> | null = null;

export const adminPassword = {
  /** The admin seat for an email, with its stored hash (null hash = no password set yet). */
  async find(email: string): Promise<{ user: Record<string, unknown>; hash: string | null; mustChange: boolean } | null> {
    const rows = await q<Record<string, unknown>>(
      `SELECT u.*, c.password_hash, c.must_change FROM identity.users u
         LEFT JOIN identity.admin_credential c ON c.user_id = u.id
        WHERE lower(u.email) = lower($1)`, [email.trim()],
    );
    const u = rows[0];
    if (!u || !isAdminRole(String(u.role ?? ''))) return null;
    return { user: u, hash: u.password_hash ? String(u.password_hash) : null, mustChange: Boolean(u.must_change) };
  },
  /** Constant-ish time check: unknown accounts still pay for one scrypt. */
  async verify(email: string, password: string): Promise<{ user: Record<string, unknown>; mustChange: boolean } | null> {
    const found = await this.find(email);
    if (!found?.hash) {
      dummy ??= hashPassword(crypto.randomBytes(16).toString('hex'));
      await checkPassword(password, await dummy).catch(() => false);
      return null;
    }
    return (await checkPassword(password, found.hash)) ? { user: found.user, mustChange: found.mustChange } : null;
  },
  async set(userId: string, password: string, mustChange = false): Promise<void> {
    const hash = await hashPassword(password);
    await q(
      `INSERT INTO identity.admin_credential (user_id, password_hash, must_change) VALUES ($1,$2,$3)
       ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, must_change = EXCLUDED.must_change, updated_at = now()`,
      [userId, hash, mustChange],
    );
  },
  async hasPassword(userId: string): Promise<boolean> {
    return Boolean((await q(`SELECT 1 FROM identity.admin_credential WHERE user_id = $1`, [userId]))[0]);
  },
};
