// Identity module — Postgres-backed users, device sessions, PIN, biometrics.
import { createHash } from 'node:crypto';
import { issueOtp, verifyOtp, signAccess, signRefresh, rotateRefresh, revokeAll } from '../../packages/auth/auth.js';
import { welcomeService } from '../notifications/welcome.js';
import { q } from '../../packages/database/db.js';
import { providerService } from '../providers/provider.service.js';
import { isAdminRole, rolePerms } from '../authorization/rbac.js';
import { sms, email } from '../notifications/channels.js';
import { templates } from '../notifications/mail.templates.js';

export interface User {
  id: string; phone?: string; email?: string; pinHash?: string; biometric: boolean;
  name?: string; nickname?: string; dob?: string; avatarUrl?: string; role?: string; createdAt: string;
}
const hashPin = (pin: string) => createHash('sha256').update(`kendibo-pin:${pin}`).digest('hex');
const row = (r: Record<string, unknown>): User => ({
  id: String(r.id), phone: (r.phone as string) ?? undefined, email: (r.email as string) ?? undefined,
  pinHash: (r.pin_hash as string) ?? undefined, biometric: Boolean(r.biometric),
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
        await sms.send(norm.value, `Your Kendibo verification code is ${r.code}. It expires in 5 minutes.`);
      } else {
        const mail = templates.otp(r.code);
        await email.send(norm.value, 'Your Kendibo code', mail.html);
      }
    } catch (e) {
      throw Object.assign(new Error('SEND_FAILED'), { cause: e });
    }
    return { devCode: r.devCode };
  },
  async verifyOtp(channel: 'phone' | 'email', identity: string, code: string, device?: { fp?: string; platform?: string; model?: string; os?: string; appVersion?: string; ip?: string; city?: string; name?: string; role?: string }) {
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
    const deviceId = `dev_${Date.now().toString(36)}`;
    // Permissions are derived from the role the DB actually holds, not a
    // hardcoded customer pair — an admin seat would otherwise mint a token
    // with no admin grants and every /v1/admin call would 403.
    const role = String(user.role ?? 'CUSTOMER').toUpperCase();
    const permissions = isAdminRole(role)
      ? [...rolePerms(role)]
      : ['booking:create', 'booking:view:self', 'booking:cancel'];
    const access = signAccess(String(user.id), permissions);
    const refresh = await signRefresh(String(user.id), deviceId);
    await this.logDevice(String(user.id), device ?? {});
    return { user: row(user), access, refresh: refresh.token, deviceId, isNew };
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
    if (patch.avatarUrl !== undefined) { sets.push(`profile_image=$${vals.length + 1}`); vals.push(String(patch.avatarUrl).slice(0, 500) || null); }
    if (sets.length > 0) {
      await q(`UPDATE identity.users SET ${sets.join(', ')}, updated_at=now() WHERE id=$${vals.length + 1}`, [...vals, userId]);
    }
    const me = await this.me(userId);
    if (!me) throw new Error('NOT_FOUND');
    return me;
  },
  /** Account deactivation: status flag + all refresh tokens revoked. Row retained for audit/finance. */
  async deactivate(userId: string) {
    await q(`UPDATE identity.users SET status='inactive' WHERE id=$1`, [userId]);
    await this.logoutAll(userId);
    return { ok: true };
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
        await q(`INSERT INTO identity.device_session (user_id, device_fp, platform, model, os, app_version, ip, city)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [userId, fp, d.platform ?? 'unknown', d.model ?? null, d.os ?? null, d.appVersion ?? null, d.ip ?? null, d.city ?? null]);
      }
    } catch { /* history must never break login */ }
    return { ok: true };
  },
  /** Google SSO: verify ID token, match-or-create verified user, same session bundle. */
  async googleVerify(idToken: string, device?: { fp?: string; platform?: string; model?: string; os?: string; appVersion?: string; ip?: string; city?: string }) {
    // Fail fast on obvious junk without network (keeps tests hermetic, avoids
    // useless external round-trip on garbage that can never verify).
    if (!idToken || idToken.length < 20 || idToken.split('.').length !== 3) throw new Error('BAD_GOOGLE_TOKEN');
    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!res.ok) throw new Error('BAD_GOOGLE_TOKEN');
    const claims = (await res.json()) as { aud?: string; exp?: string; email?: string; email_verified?: string; sub?: string; name?: string; picture?: string };
    const allowed = (process.env.GOOGLE_CLIENT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (allowed.length > 0 && !allowed.includes(String(claims.aud ?? ''))) throw new Error('BAD_GOOGLE_AUDIENCE');
    if (Number(claims.exp ?? 0) * 1000 < Date.now()) throw new Error('GOOGLE_TOKEN_EXPIRED');
    if (claims.email_verified !== 'true' || !claims.email || !claims.sub) throw new Error('GOOGLE_UNVERIFIED');
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
        // Welcome in-app + email + push — best-effort, never blocks the login.
        void welcomeService.send({
          id: String((ins[0] as { id?: unknown }).id),
          name: String((claims as { name?: string }).name ?? email.split('@')[0]),
          email,
          phone: null,
        }).catch(() => {});
      }
    }
    const user = row(rows[0]);
    const deviceId = `dev_${Date.now().toString(36)}`;
    const access = signAccess(user.id, ['booking:create', 'booking:view:self']);
    const refresh = await signRefresh(user.id, deviceId);
    await this.logDevice(user.id, device ?? {});
    return { user, access, refresh: refresh.token, deviceId, isNew };
  },
};
