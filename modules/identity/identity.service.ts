// Identity module — Postgres-backed users, device sessions, PIN, biometrics.
import { createHash, randomBytes } from 'node:crypto';
import { issueOtp, verifyOtp, signAccess, signRefresh, rotateRefresh, revokeAll } from '../../packages/auth/auth.js';
import { welcomeService } from '../notifications/welcome.js';
import { q } from '../../packages/database/db.js';
import { emit } from '../../packages/observability/emit.js';
import { providerService } from '../providers/provider.service.js';
import { isAdminRole, rolePerms } from '../authorization/rbac.js';
import { sms, email } from '../notifications/channels.js';
import { templates } from '../notifications/mail.templates.js';
import { adminTwoFactor, adminLoginChallenge, adminSessions, adminLoginLock, lockKeys } from './admin-security.service.js';

export type LoginDevice = { fp?: string; platform?: string; model?: string; os?: string; appVersion?: string; ip?: string; city?: string; ua?: string };
/** Admin with 2FA on: the first factor passed, the session waits for POST /v1/admin/login/2fa. */
export interface TwoFactorChallenge { twoFactorRequired: true; challengeId: string; isNew: boolean }
const CUSTOMER_PERMS = ['booking:create', 'booking:view:self', 'booking:cancel'];
const newDeviceId = () => `dev_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;

export interface User {
  id: string; phone?: string; email?: string; hasPin: boolean; biometric: boolean;
  name?: string; nickname?: string; dob?: string; avatarUrl?: string; role?: string; createdAt: string;
  googleLinked: boolean; facebookLinked: boolean;
}
const hashPin = (pin: string) => createHash('sha256').update(`kendibo-pin:${pin}`).digest('hex');
const row = (r: Record<string, unknown>): User => ({
  id: String(r.id), phone: (r.phone as string) ?? undefined, email: (r.email as string) ?? undefined,
  // Never send the PIN hash: a 4-digit PIN's SHA-256 is cracked in 10,000 tries.
  hasPin: Boolean(r.pin_hash), biometric: Boolean(r.biometric),
  googleLinked: Boolean(r.google_sub), facebookLinked: Boolean(r.facebook_sub),
  name: (r.name as string) ?? undefined, nickname: (r.nickname as string) ?? undefined,
  dob: r.dob ? String(r.dob).slice(0, 10) : undefined,
  avatarUrl: (r.profile_image as string) ?? undefined,
  role: String(r.role ?? 'CUSTOMER').toUpperCase(), createdAt: String(r.created_at),
});

export const identityService = {
  /** Normalise + validate. Throws BAD_IDENTITY for garbage (route maps to 400). */
  normalizeIdentity(identity: string): { channel: 'phone' | 'email'; value: string } {
    const id = identity.trim();
    if (id.includes('@')) {
      const email = id.toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new Error('BAD_IDENTITY');
      return { channel: 'email', value: email };
    }
    const digits = id.replace(/\D/g, '');
    let phone = '';
    if (digits.startsWith('234') && digits.length >= 12) phone = `+${digits.slice(0, 13)}`;
    else if (digits.startsWith('0') && digits.length === 11) phone = `+234${digits.slice(1)}`;
    else if (/^[789]\d{9}$/.test(digits)) phone = `+234${digits}`; // 803 123 4567 typed without the leading 0
    else if (/^\d{7,15}$/.test(digits)) phone = `+${digits}`;
    if (!phone) throw new Error('BAD_IDENTITY');
    return { channel: 'phone', value: phone };
  },
  async requestOtp(channel: 'phone' | 'email', identity: string) {
    const norm = this.normalizeIdentity(identity);
    if (norm.channel !== channel) throw new Error('BAD_IDENTITY');
    const r = await issueOtp(channel, norm.value);
    try {
      if (channel === 'phone') {
        await sms.send(norm.value, `Your Kendibo verification code is ${r.code}. It expires in 5 minutes.`, { type: 'otp' });
      } else {
        const mail = templates.otp(r.code);
        await email.send(norm.value, 'Your Kendibo code', mail.html);
      }
    } catch (e) {
      throw Object.assign(new Error('SEND_FAILED'), { cause: e });
    }
    return { devCode: r.devCode };
  },
  async verifyOtp(channel: 'phone' | 'email', identity: string, code: string, device?: LoginDevice & { name?: string; role?: string }) {
    const norm = this.normalizeIdentity(identity);
    if (norm.channel !== channel) return null;
    if (!(await verifyOtp(channel, norm.value, code))) return null;
    const normalizedRole = device?.role?.toLowerCase() === 'provider' ? 'PROVIDER' : 'CUSTOMER';
    const name = device?.name;
    const col = channel === 'phone' ? 'phone' : 'email';
    const rows = await q<Record<string, unknown>>(`SELECT * FROM identity.users WHERE ${col}=$1`, [norm.value]);
    let user = rows[0];
    let isNew = false;
    if (!user) {
      isNew = true;
      const ins = await q<Record<string, unknown>>(
        `INSERT INTO identity.users (${col}, role, name) VALUES ($1,$2,$3) RETURNING *`, [norm.value, normalizedRole, name ?? null],
      );
      user = ins[0];
      emit('identity.user_created', { userId: String(user.id), channel: channel === 'phone' ? 'phone_otp' : 'email_otp', role: normalizedRole });
      // Welcome in-app + email + push — best-effort, never blocks the login.
      void welcomeService.send({
        id: String(user.id),
        name: (user.name as string | null) ?? null,
        email: (user.email as string | null) ?? null,
        phone: (user.phone as string | null) ?? null,
      }).catch(() => {});
    } else {
      const sets: string[] = [];
      const vals: unknown[] = [];
      if (normalizedRole === 'PROVIDER' && String(user.role ?? 'CUSTOMER').toUpperCase() !== 'PROVIDER') {
        sets.push(`role=$${vals.length + 1}`); vals.push('PROVIDER');
      }
      if (!user.name && name) { sets.push(`name=$${vals.length + 1}`); vals.push(name); }
      if (sets.length > 0) {
        const upd = await q<Record<string, unknown>>(
          `UPDATE identity.users SET ${sets.join(', ')}, updated_at=now() WHERE id=$${vals.length + 1} RETURNING *`,
          [...vals, user.id],
        );
        user = upd[0];
      }
    }
    // Admin bootstrap: signup can never mint an admin (the role argument is
    // ignored for anything but provider), so a first console seat is claimed by
    // listing your email/phone in ADMIN_BOOTSTRAP. Grants SUPER_ADMIN only to
    // a plain CUSTOMER; an identity already holding any other role is never
    // touched, so re-logging-in can't silently upgrade or demote anyone.
    const bootstrap = process.env.ADMIN_BOOTSTRAP
      ?.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) ?? [];
    if (bootstrap.includes(norm.value) && String(user.role).toUpperCase() === 'CUSTOMER') {
      const upd = await q<Record<string, unknown>>(
        `UPDATE identity.users SET role='SUPER_ADMIN', updated_at=now() WHERE id=$1 RETURNING *`, [user.id],
      );
      if (upd[0]) user = upd[0];
    }
    if (String(user.role ?? '').toUpperCase() === 'PROVIDER') {
      await providerService.onboard(String(user.id));
    }
    const challenge = await this.loginGate(user, device);
    if (challenge) return { ...challenge, isNew };
    return { ...(await this.issueSession(user, device)), isNew };
  },
  /**
   * Runs before any session is issued (OTP, Google, Facebook): a suspended
   * account is refused (ACCOUNT_SUSPENDED); an admin with 2FA on gets a
   * challenge instead of tokens.
   */
  async loginGate(user: Record<string, unknown>, device?: LoginDevice): Promise<Omit<TwoFactorChallenge, 'isNew'> | null> {
    if (String(user.status ?? '') === 'suspended') throw new Error('ACCOUNT_SUSPENDED');
    const role = String(user.role ?? 'CUSTOMER').toUpperCase();
    if (isAdminRole(role) && await adminTwoFactor.enabled(String(user.id))) {
      const { ua, ip, ...rest } = device ?? {};
      const challengeId = await adminLoginChallenge.create(String(user.id), rest, ip ?? null, ua ?? null);
      return { twoFactorRequired: true, challengeId };
    }
    return null;
  },
  /**
   * Access + refresh for a user. Permissions are derived from the role the DB
   * actually holds, not a hardcoded customer pair — an admin seat would
   * otherwise mint a token with no admin grants and every /v1/admin call would
   * 403. Admin logins start a tracked session (idle timeout, 2FA marker).
   */
  async issueSession(user: Record<string, unknown>, device?: LoginDevice, opts: { permissions?: string[]; mfa?: boolean } = {}) {
    const id = String(user.id);
    const role = String(user.role ?? 'CUSTOMER').toUpperCase();
    const permissions = opts.permissions ?? (isAdminRole(role) ? [...rolePerms(role)] : CUSTOMER_PERMS);
    const deviceId = newDeviceId();
    const access = signAccess(id, permissions, deviceId);
    const refresh = await signRefresh(id, deviceId);
    if (isAdminRole(role)) await adminSessions.start(id, deviceId, opts.mfa === true);
    const { ua: _ua, ...d } = device ?? {};
    void _ua;
    await this.logDevice(id, d);
    return { user: row(user), access, refresh: refresh.token, deviceId };
  },
  /** Open bookings as customer, or accepted jobs as provider — blocks account erasure. */
  async hasOpenBookings(userId: string): Promise<boolean> {
    const open = await q(
      `SELECT 1 FROM booking.booking b
        WHERE (b.user_id=$1 OR b.id::text IN (SELECT da.job_id FROM dispatch.assignment da JOIN provider.provider p ON p.id=da.provider_id
                                                WHERE p.user_id=$1 AND da.status='accepted'))
          AND upper(b.status) NOT IN ('COMPLETED','CANCELLED','CANCELED','REFUNDED','CLOSED','DECLINED','EXPIRED') LIMIT 1`, [userId],
    );
    return Boolean(open[0]);
  },
  refresh(token: string) { return rotateRefresh(token); },
  logoutAll(userId: string) { return revokeAll(userId); },
  async me(userId: string) {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM identity.users WHERE id=$1`, [userId]);
    return rows[0] ? row(rows[0]) : null;
  },
  async setPin(userId: string, pin: string) {
    if (!/^\d{4}$/.test(pin)) throw new Error('PIN_MUST_BE_4_DIGITS');
    await q(`UPDATE identity.users SET pin_hash=$2 WHERE id=$1`, [userId, hashPin(pin)]);
    return { ok: true };
  },
  async verifyPin(userId: string, pin: string): Promise<boolean> {
    const rows = await q<{ pin_hash: string }>(`SELECT pin_hash FROM identity.users WHERE id=$1`, [userId]);
    const h = rows[0]?.pin_hash;
    return Boolean(h) && h === hashPin(pin);
  },
  async changePin(userId: string, oldPin: string, newPin: string) {
    if (!(await this.verifyPin(userId, oldPin))) throw new Error('BAD_PIN');
    return this.setPin(userId, newPin);
  },
  async enableBiometrics(userId: string, enabled: boolean) {
    await q(`UPDATE identity.users SET biometric=$2 WHERE id=$1`, [userId, enabled]);
    return { biometric: enabled };
  },
  /** Fill/Edit Profile: name, nickname, date of birth, avatar. Phone/email change via OTP re-verify (not here). */
  async updateProfile(userId: string, patch: { name?: string; nickname?: string; dob?: string; avatarUrl?: string }) {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.name !== undefined) {
      const clean = String(patch.name).trim().replace(/\s+/g, ' ').slice(0, 80);
      if (clean.length < 2) throw new Error('NAME_TOO_SHORT');
      sets.push(`name=$${vals.length + 1}`); vals.push(clean);
    }
    if (patch.nickname !== undefined) { sets.push(`nickname=$${vals.length + 1}`); vals.push(String(patch.nickname).trim().slice(0, 40) || null); }
    if (patch.dob !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(patch.dob)) throw new Error('BAD_DOB');
      sets.push(`dob=$${vals.length + 1}`); vals.push(patch.dob);
    }
    // Only real web addresses: a browser-local blob:/file:/data:/content: link
    // only works on the device (and tab) that made it, and breaks everywhere else.
    if (patch.avatarUrl !== undefined && !/^(blob|file|data|content):/i.test(String(patch.avatarUrl).trim())) {
      sets.push(`profile_image=$${vals.length + 1}`); vals.push(String(patch.avatarUrl).slice(0, 500) || null);
    }
    if (sets.length > 0) {
      await q(`UPDATE identity.users SET ${sets.join(', ')}, updated_at=now() WHERE id=$${vals.length + 1}`, [...vals, userId]);
    }
    const me = await this.me(userId);
    if (!me) throw new Error('NOT_FOUND');
    return me;
  },
  /** Account deactivation: status flag + all refresh tokens revoked. Row retained for audit/finance. */
  /**
   * NDPA 2023 s.34(1)(b)/s.38: a copy of the user's data in a machine-readable
   * format. Secrets (PIN hash, tokens) and raw ID numbers are never included.
   */
  async exportData(userId: string) {
    const safe = async (sql: string) => q<Record<string, unknown>>(sql, [userId]).catch(() => []);
    const profile = await this.me(userId);
    return {
      exportedAt: new Date().toISOString(),
      profile,
      addresses: await safe(`SELECT * FROM property.address WHERE user_id=$1`),
      bookings: await safe(`SELECT * FROM booking.booking WHERE user_id=$1 ORDER BY created_at DESC`),
      serviceRequests: await safe(`SELECT * FROM booking.service_request WHERE user_id=$1 ORDER BY created_at DESC`),
      payments: await safe(`SELECT p.reference, p.psp, p.amount_kobo, p.status, p.created_at, p.booking_id
                              FROM payment.payment p JOIN booking.booking b ON b.id = p.booking_id WHERE b.user_id=$1`),
      walletTransactions: await safe(`SELECT * FROM payment.wallet_txn WHERE user_id=$1 ORDER BY created_at DESC`),
      identityVerification: await safe(`SELECT status, tier, created_at, updated_at FROM kyc.customer WHERE user_id=$1`),
      notificationPreferences: await safe(`SELECT * FROM notification.user_preference WHERE user_id=$1`),
      supportTickets: await safe(`SELECT * FROM support.ticket WHERE customer_id=$1 ORDER BY created_at DESC`),
      devices: await safe(`SELECT platform, channel, created_at FROM identity.device WHERE user_id=$1`),
    };
  },
  /**
   * Erase an account (NDPA s.34(1)(d); Google Play account deletion). Personal
   * details are wiped and sign-in is revoked everywhere. Booking, payment and
   * verification records are kept where the law requires, tied only to the
   * anonymous id. Callers check open bookings / wallet balance first.
   */
  async eraseAccount(userId: string) {
    await q(
      `UPDATE identity.users SET name='Deleted user', nickname=NULL, email=NULL, phone=NULL, dob=NULL,
         profile_image=NULL, google_sub=NULL, facebook_sub=NULL, pin_hash=NULL, biometric=false,
         status='deleted', updated_at=now() WHERE id=$1`, [userId],
    );
    for (const sql of [
      `DELETE FROM property.address WHERE user_id=$1`,
      `DELETE FROM notification.user_preference WHERE user_id=$1`,
      `DELETE FROM identity.device WHERE user_id=$1`,
      `DELETE FROM identity.customer_profile WHERE user_id=$1`,
    ]) await q(sql, [userId]).catch(() => undefined); // rows still referenced by bookings stay
    await this.logoutAll(userId);
    return { ok: true };
  },
  async deactivate(userId: string) {
    await q(`UPDATE identity.users SET status='inactive' WHERE id=$1`, [userId]);
    await this.logoutAll(userId);
    return { ok: true };
  },
  /**
   * Link a phone number to a signed-in account so the owner can also sign in with it.
   * Step 1 sends a code to the number; step 2 links it once the code is confirmed,
   * so nobody can attach a number they do not hold. A number already on another
   * account is refused.
   */
  async requestPhoneLink(userId: string, raw: string) {
    const norm = this.normalizeIdentity(raw);
    if (norm.channel !== 'phone') throw new Error('BAD_IDENTITY');
    const taken = await q(`SELECT 1 FROM identity.users WHERE phone=$1 AND id<>$2`, [norm.value, userId]);
    if (taken[0]) throw new Error('PHONE_IN_USE');
    const r = await issueOtp('phone', norm.value);
    try {
      await sms.send(norm.value, `Your Kendibo code to add this phone number is ${r.code}. It expires in 5 minutes.`, { type: 'otp' });
    } catch (e) {
      throw Object.assign(new Error('SEND_FAILED'), { cause: e });
    }
    return { phone: norm.value, devCode: r.devCode };
  },
  async confirmPhoneLink(userId: string, raw: string, code: string) {
    const norm = this.normalizeIdentity(raw);
    if (norm.channel !== 'phone') throw new Error('BAD_IDENTITY');
    if (!(await verifyOtp('phone', norm.value, code))) throw new Error('BAD_OTP');
    const taken = await q(`SELECT 1 FROM identity.users WHERE phone=$1 AND id<>$2`, [norm.value, userId]);
    if (taken[0]) throw new Error('PHONE_IN_USE');
    await q(`UPDATE identity.users SET phone=$2, updated_at=now() WHERE id=$1`, [userId, norm.value]);
    emit('identity.phone_linked', { userId });
    return { phone: norm.value };
  },
  /** Pre-check for the login button: normalises identity, answers existence only. */
  async accountExists(identity: string): Promise<{ exists: boolean; channel: 'phone' | 'email' }> {
    const norm = this.normalizeIdentity(identity);
    const col = norm.channel === 'phone' ? 'phone' : 'email';
    const rows = await q(`SELECT id FROM identity.users WHERE ${col}=$1`, [norm.value]);
    return { exists: rows.length > 0, channel: norm.channel };
  },
  /** Silent device history: upsert per (user, fingerprint). Never blocks login. */
  async logDevice(userId: string, d: { fp?: string; platform?: string; model?: string; os?: string; appVersion?: string; ip?: string; city?: string }) {
    const fp = String(d.fp ?? `${d.platform ?? 'unknown'}:${d.model ?? 'unknown'}`).slice(0, 160);
    try {
      const rows = await q<Record<string, unknown>>(
        `SELECT id FROM identity.device_session WHERE user_id=$1 AND device_fp=$2`, [userId, fp],
      );
      if (rows[0]) {
        await q(`UPDATE identity.device_session SET last_seen=now(), ip=$3, city=$4 WHERE id=$1`, [String(rows[0].id), userId, d.ip ?? null, d.city ?? null]);
      } else {
        const others = await q(`SELECT 1 FROM identity.device_session WHERE user_id=$1 LIMIT 1`, [userId]);
        await q(`INSERT INTO identity.device_session (user_id, device_fp, platform, model, os, app_version, ip, city)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [userId, fp, d.platform ?? 'unknown', d.model ?? null, d.os ?? null, d.appVersion ?? null, d.ip ?? null, d.city ?? null]);
        // A new phone on an existing account (possible SIM swap): alert the owner
        // and hold payouts for 24h (payoutService.bankEligible).
        if (others[0]) await this.flagNewDevice(userId, d.model ?? d.platform ?? 'a new device');
      }
    } catch { /* history must never break login */ }
    return { ok: true };
  },
  async flagNewDevice(userId: string, deviceName: string) {
    await q(`UPDATE identity.users SET new_device_at=now() WHERE id=$1`, [userId]);
    emit('identity.new_device', { userId });
    const u = await q<{ phone: string | null; email: string | null }>(`SELECT phone, email FROM identity.users WHERE id=$1`, [userId]).catch(() => []);
    const text = `Kendibo: your account was just signed in on ${String(deviceName).slice(0, 40)}. If this wasn't you, contact Kendibo support now. Payouts are paused for 24 hours to keep your money safe.`;
    try {
      if (u[0]?.phone) await sms.send(String(u[0].phone), text, { type: 'transactional' });
      if (u[0]?.email) await email.send(String(u[0].email), 'New sign-in to your Kendibo account', `<p>${text}</p>`);
    } catch { /* alert is best effort */ }
  },
  /** Google SSO: verify ID token (or OAuth2 access token), match-or-create verified user, same session bundle. */
  async googleVerify(idToken: string, device?: LoginDevice) {
    // Fail fast on obvious junk without network (keeps tests hermetic, avoids
    // useless external round-trip on garbage that can never verify).
    const trimmedToken = (idToken ?? '').trim();
    if (!trimmedToken || trimmedToken.length < 20) throw new Error('BAD_GOOGLE_TOKEN');

    const allowed = (process.env.GOOGLE_CLIENT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    let claims: { aud?: string; azp?: string; exp?: string | number; email?: string; email_verified?: string | boolean; sub?: string; name?: string; picture?: string };

    if (trimmedToken.split('.').length === 3) {
      const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(trimmedToken)}`);
      if (!res.ok) throw new Error('BAD_GOOGLE_TOKEN');
      claims = (await res.json()) as typeof claims;
      if (
        allowed.length > 0 &&
        !allowed.includes(String(claims.aud ?? '')) &&
        !allowed.includes(String(claims.azp ?? ''))
      ) {
        throw new Error('BAD_GOOGLE_AUDIENCE');
      }
      if (Number(claims.exp ?? 0) * 1000 < Date.now()) throw new Error('GOOGLE_TOKEN_EXPIRED');
    } else {
      // Fallback for Web OAuth2 access_token when third-party cookies block implicit id_token
      const [tokenInfoRes, userInfoRes] = await Promise.all([
        fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(trimmedToken)}`),
        fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${trimmedToken}` },
        }),
      ]);
      if (!tokenInfoRes.ok || !userInfoRes.ok) throw new Error('BAD_GOOGLE_TOKEN');
      const tokenInfo = (await tokenInfoRes.json()) as { aud?: string; azp?: string; exp?: string | number };
      const userInfo = (await userInfoRes.json()) as { sub?: string; email?: string; email_verified?: boolean | string; name?: string; picture?: string };
      if (
        allowed.length > 0 &&
        !allowed.includes(String(tokenInfo.aud ?? '')) &&
        !allowed.includes(String(tokenInfo.azp ?? ''))
      ) {
        throw new Error('BAD_GOOGLE_AUDIENCE');
      }
      if (tokenInfo.exp && Number(tokenInfo.exp) * 1000 < Date.now()) throw new Error('GOOGLE_TOKEN_EXPIRED');
      claims = { ...tokenInfo, ...userInfo };
    }

    if (String(claims.email_verified) !== 'true' || !claims.email || !claims.sub) throw new Error('GOOGLE_UNVERIFIED');
    const email = String(claims.email).toLowerCase();
    const picture = claims.picture ? String(claims.picture).slice(0, 500) : null;
    let rows = await q<Record<string, unknown>>(`SELECT * FROM identity.users WHERE google_sub=$1`, [String(claims.sub)]);
    let isNew = false;
    if (!rows[0]) {
      const byEmail = await q<Record<string, unknown>>(`SELECT * FROM identity.users WHERE email=$1`, [email]);
      if (byEmail[0]) {
        await q(`UPDATE identity.users SET google_sub=$2, profile_image=COALESCE(profile_image,$3) WHERE id=$1`, [String(byEmail[0].id), String(claims.sub), picture]);
        rows = await q<Record<string, unknown>>(`SELECT * FROM identity.users WHERE id=$1`, [String(byEmail[0].id)]);
      } else {
        const ins = await q<Record<string, unknown>>(
          `INSERT INTO identity.users (email, name, google_sub, profile_image) VALUES ($1,$2,$3,$4) RETURNING *`,
          [email, String((claims as { name?: string }).name ?? email.split('@')[0]).slice(0, 80), String(claims.sub), picture],
        );
        rows = ins;
        isNew = true;
        emit('identity.user_created', { userId: String((ins[0] as { id?: unknown }).id), channel: 'google', role: 'CUSTOMER' });
        // Welcome in-app + email + push — best-effort, never blocks the login.
        void welcomeService.send({
          id: String((ins[0] as { id?: unknown }).id),
          name: String((claims as { name?: string }).name ?? email.split('@')[0]),
          email,
          phone: null,
        }).catch(() => {});
      }
    }
    let userRow = rows[0];
    const bootstrap = process.env.ADMIN_BOOTSTRAP
      ?.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) ?? [];
    if (bootstrap.includes(email) && String(userRow.role ?? 'CUSTOMER').toUpperCase() === 'CUSTOMER') {
      const upd = await q<Record<string, unknown>>(
        `UPDATE identity.users SET role='SUPER_ADMIN', updated_at=now() WHERE id=$1 RETURNING *`, [userRow.id],
      );
      if (upd[0]) userRow = upd[0];
    }
    // Admin seats share the password/OTP lockout (per account and per IP): a
    // locked seat gets no session via Google either. Caller answers 429.
    if (isAdminRole(String(userRow.role ?? '').toUpperCase())) {
      const retryAfter = await adminLoginLock.retryAfter(lockKeys(String(userRow.id), device?.ip ?? null));
      if (retryAfter > 0) throw Object.assign(new Error('ADMIN_LOGIN_LOCKED'), { retryAfter, adminId: String(userRow.id) });
    }
    const challenge = await this.loginGate(userRow, device);
    if (challenge) return { ...challenge, isNew };
    return { ...(await this.issueSession(userRow, device)), isNew };
  },
  /** Facebook Login: verify the token with Meta (see facebook.ts), match-or-create, same session bundle. */
  async facebookVerify(accessToken: string, device?: LoginDevice) {
    const { verifyFacebookToken } = await import('./facebook.js');
    const p = await verifyFacebookToken(accessToken);
    let rows = await q<Record<string, unknown>>(`SELECT * FROM identity.users WHERE facebook_sub=$1`, [p.id]);
    let isNew = false;
    if (!rows[0]) {
      const byEmail = p.email ? await q<Record<string, unknown>>(`SELECT * FROM identity.users WHERE email=$1 AND facebook_sub IS NULL`, [p.email]) : [];
      if (byEmail[0]) {
        await q(`UPDATE identity.users SET facebook_sub=$2, profile_image=COALESCE(profile_image,$3) WHERE id=$1`, [String(byEmail[0].id), p.id, p.picture]);
        rows = await q<Record<string, unknown>>(`SELECT * FROM identity.users WHERE id=$1`, [String(byEmail[0].id)]);
      } else {
        const name = p.name ?? (p.email ? p.email.split('@')[0] : 'Kendibo user');
        rows = await q<Record<string, unknown>>(
          `INSERT INTO identity.users (email, name, facebook_sub, profile_image) VALUES ($1,$2,$3,$4) RETURNING *`, [p.email, name, p.id, p.picture],
        );
        isNew = true;
        emit('identity.user_created', { userId: String((rows[0] as { id?: unknown }).id), channel: 'facebook', role: 'CUSTOMER' });
        void welcomeService.send({ id: String((rows[0] as { id?: unknown }).id), name, email: p.email, phone: null }).catch(() => {});
      }
    }
    const challenge = await this.loginGate(rows[0], device);
    if (challenge) return { ...challenge, isNew };
    return { ...(await this.issueSession(rows[0], device, { permissions: ['booking:create', 'booking:view:self'] })), isNew };
  },
  /**
   * Meta Data Deletion Request / deauthorize: unlink the Facebook id and drop
   * the Facebook photo. The account itself (bookings, payments, phone) was not
   * obtained from Facebook and stays; the person can close it in the app.
   */
  async facebookDataDeletion(facebookId: string): Promise<{ code: string }> {
    const { facebookHash } = await import('./facebook.js');
    await q(`UPDATE identity.users SET profile_image = NULL WHERE facebook_sub=$1 AND (profile_image LIKE '%fbcdn%' OR profile_image LIKE '%facebook%' OR profile_image LIKE '%fbsbx%')`, [facebookId]);
    // A Facebook-only account (no phone, no Google) got its name and email from
    // Facebook: anonymise them too. Accounts with another sign-in keep theirs.
    await q(`UPDATE identity.users SET email = NULL, name = 'Deleted user', nickname = NULL
              WHERE facebook_sub=$1 AND phone IS NULL AND google_sub IS NULL`, [facebookId]);
    await q(`UPDATE identity.users SET facebook_sub = NULL WHERE facebook_sub=$1`, [facebookId]);
    const code = `fbdel_${createHash('sha256').update(`${facebookId}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 20)}`;
    await q(`INSERT INTO identity.facebook_deletion (code, facebook_hash) VALUES ($1,$2)`, [code, facebookHash(facebookId)]);
    return { code };
  },
};
