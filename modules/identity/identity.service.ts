// Identity module — Postgres-backed users, device sessions, PIN, biometrics.
import { createHash } from 'node:crypto';
import { issueOtp, verifyOtp, signAccess, signRefresh, rotateRefresh, revokeAll } from '../../packages/auth/auth.js';
import { q } from '../../packages/database/db.js';
import { sms, email } from '../notifications/channels.js';

export interface User { id: string; phone?: string; email?: string; pinHash?: string; biometric: boolean; createdAt: string; }
const hashPin = (pin: string) => createHash('sha256').update(`kendibo-pin:${pin}`).digest('hex');
const row = (r: Record<string, unknown>): User => ({
  id: String(r.id), phone: (r.phone as string) ?? undefined, email: (r.email as string) ?? undefined,
  pinHash: (r.pin_hash as string) ?? undefined, biometric: Boolean(r.biometric), createdAt: String(r.created_at),
});

export const identityService = {
  async requestOtp(channel: 'phone' | 'email', identity: string) {
    const r = await issueOtp(channel, identity);
    if (channel === 'phone') {
      let phone = identity.replace(/\s+/g, '');
      if (phone.startsWith('+')) phone = phone.substring(1);
      if (phone.startsWith('0')) phone = '234' + phone.substring(1); // Default to NG
      await sms.send(phone, `Your KENDIBO code is ${r.code}. It expires in 5 minutes.`);
    } else {
      await email.send(identity, 'Your KENDIBO code', `<p>Your KENDIBO code is <b>${r.code}</b>. It expires in 5 minutes.</p>`);
    }
    return { devCode: r.devCode };
  },
  async verifyOtp(channel: 'phone' | 'email', identity: string, code: string) {
    if (!(await verifyOtp(channel, identity, code))) return null;
    const col = channel === 'phone' ? 'phone' : 'email';
    let rows = await q<Record<string, unknown>>(`SELECT * FROM identity.users WHERE ${col}=$1`, [identity]);
    let user = rows[0];
    if (!user) {
      const ins = await q<Record<string, unknown>>(
        `INSERT INTO identity.users (${col}) VALUES ($1) RETURNING *`, [identity],
      );
      user = ins[0];
    }
    const deviceId = `dev_${Date.now().toString(36)}`;
    const access = signAccess(String(user.id), ['booking:create', 'booking:view:self']);
    const refresh = await signRefresh(String(user.id), deviceId);
    return { user: row(user), access, refresh: refresh.token, deviceId };
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
};
