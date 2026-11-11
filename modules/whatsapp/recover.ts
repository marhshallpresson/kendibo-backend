// RECOVER: a customer lost or changed their number and wants their old account
// on this WhatsApp number. We ask for the old email or phone, email a 6-digit
// code to the old account, and move this number over once they reply with it.
//
// Safety: the reply is the same whether or not the account exists (no account
// enumeration); codes are hashed, expire after 10 minutes and die after 5 wrong
// tries; 3 attempts per number per day; a number that already has its own
// bookings is never merged automatically (a person handles it).
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { q } from '../../packages/database/db.js';
import { emit } from '../../packages/observability/emit.js';
import { observability } from '../../packages/observability/watchup.adapter.js';
import { wa } from './whatsapp.client.js';

export const RECOVER_TRIGGER = /^(\/recover|recover|recover (my )?account|get back my (old )?account|my old account|i (lost|changed) my (old )?(number|line|sim))[.!?]*$/i;
const CODE_TTL_MS = 10 * 60_000;
const MAX_TRIES = 5;
const MAX_PER_DAY = 3;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export interface RecoverState { recover?: 'ask' | 'code'; recoverId?: string }
export type RecoverOutcome = { kind: 'handled' } | { kind: 'moved'; userId: string } | { kind: 'support' } | { kind: 'not_mine' };

const hash = (code: string) => createHash('sha256').update(`kendibo-recover:${code}`).digest('hex');
const last4 = (waId: string) => waId.replace(/\D/g, '').slice(-4);

/** 0803 123 4567, 234803…, +234803… → +234803…; anything else → null. */
export function normalisePhone(raw: string): string | null {
  const d = raw.replace(/[\s\-().]/g, '');
  if (!/^\+?\d{10,15}$/.test(d)) return null;
  const digits = d.replace(/\D/g, '');
  if (digits.startsWith('0') && digits.length === 11) return `+234${digits.slice(1)}`;
  return `+${digits}`;
}

async function attemptsToday(waId: string): Promise<number> {
  const r = await q<{ n: string }>(`SELECT COUNT(*) AS n FROM messaging.whatsapp_recovery WHERE wa_id=$1 AND created_at > $2`,
    [waId, new Date(Date.now() - 86_400_000).toISOString()]);
  return Number(r[0]?.n ?? 0);
}

/** "/recover": ask which account (or say the daily limit is reached). */
export async function startRecovery(waId: string, a: RecoverState): Promise<void> {
  if ((await attemptsToday(waId)) >= MAX_PER_DAY) {
    delete a.recover; delete a.recoverId;
    await wa.text(waId, "You've tried to recover an account 3 times today. Please try again tomorrow, or type AGENT and a person will help you.");
    return;
  }
  a.recover = 'ask';
  delete a.recoverId;
  await wa.text(waId, 'No wahala, let\'s get your account back. What email or phone number was on your old Kendibo account?\n\nType "cancel" to stop.');
}

/**
 * The customer is in the middle of RECOVER. Returns 'not_mine' when the
 * message isn't part of the flow (they moved on), so the router carries on.
 */
export async function continueRecovery(waId: string, currentUserId: string, a: RecoverState, text: string): Promise<RecoverOutcome> {
  const t = text.trim();
  if (/^(cancel|stop|exit|quit|menu|\/.*)$/i.test(t)) {
    delete a.recover; delete a.recoverId;
    if (t.toLowerCase() !== 'cancel') return { kind: 'not_mine' };
    await wa.text(waId, 'Okay, recovery stopped. Nothing changed.');
    return { kind: 'handled' };
  }
  if (a.recover === 'ask') return askedForAccount(waId, currentUserId, a, t);
  if (a.recover === 'code') {
    if (!/^\d[\d\s]{3,9}$/.test(t)) { delete a.recover; delete a.recoverId; return { kind: 'not_mine' }; }
    return checkCode(waId, currentUserId, a, t.replace(/\s/g, ''));
  }
  return { kind: 'not_mine' };
}

async function askedForAccount(waId: string, currentUserId: string, a: RecoverState, t: string): Promise<RecoverOutcome> {
  const email = EMAIL_RE.test(t) ? t.toLowerCase() : null;
  const phone = email ? null : normalisePhone(t);
  if (!email && !phone) {
    await wa.text(waId, "I couldn't read that. Please type the email (like ada@gmail.com) or phone number (like 0803 123 4567) from your old account.");
    return { kind: 'handled' };
  }
  if ((await attemptsToday(waId)) >= MAX_PER_DAY) {
    delete a.recover; delete a.recoverId;
    await wa.text(waId, "You've tried to recover an account 3 times today. Please try again tomorrow, or type AGENT and a person will help you.");
    return { kind: 'handled' };
  }
  // The email column only ever holds an address its owner confirmed (app OTP
  // sign-in, or the WhatsApp confirmation link), so it is safe to send the code there.
  const found = await q<{ id: string; email: string | null; name: string | null; role: string | null }>(
    email ? `SELECT id, email, name, role FROM identity.users WHERE lower(email)=$1`
      : `SELECT id, email, name, role FROM identity.users WHERE phone=$1`,
    [email ?? phone],
  ).catch(() => []);
  // Staff accounts are never moved from a chat.
  const target = found[0]?.email && String(found[0].id) !== currentUserId && !/ADMIN|SUPPORT|OPS/i.test(String(found[0].role ?? '')) ? found[0] : null;
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const row = await q<{ id: string }>(
    `INSERT INTO messaging.whatsapp_recovery (wa_id, target_user_id, code_hash, status, expires_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [waId, target ? String(target.id) : null, target ? hash(code) : null, target ? 'sent' : 'no_match', new Date(Date.now() + CODE_TTL_MS).toISOString()],
  );
  if (target?.email) {
    try {
      const [{ email: mailer }, { templates }] = await Promise.all([import('../notifications/channels.js'), import('../notifications/mail.templates.js')]);
      const mail = templates.recoveryCode({ name: target.name ?? undefined, code, last4: last4(waId) }, { recipientEmail: String(target.email) });
      await mailer.send(String(target.email), 'Your Kendibo account recovery code', mail.html);
    } catch (e) { observability.captureException(e); }
  }
  emit('whatsapp.recovery_requested', { matched: Boolean(target) });
  a.recover = 'code';
  a.recoverId = String(row[0].id);
  await wa.text(waId, "If that matches a Kendibo account, we've sent a 6-digit code to its email. Reply with the code here. It works for 10 minutes.\n\nNo email? Type AGENT and a person will help.");
  return { kind: 'handled' };
}

async function checkCode(waId: string, currentUserId: string, a: RecoverState, code: string): Promise<RecoverOutcome> {
  const r = (await q<{ id: string; target_user_id: string | null; code_hash: string | null; attempts: number; status: string; expires_at: string }>(
    `SELECT * FROM messaging.whatsapp_recovery WHERE id=$1 AND wa_id=$2`, [a.recoverId ?? '00000000-0000-0000-0000-000000000000', waId],
  ).catch(() => []))[0];
  const expired = !r || new Date(String(r.expires_at)).getTime() < Date.now() || !['sent', 'no_match'].includes(String(r.status)) || Number(r.attempts) >= MAX_TRIES;
  if (expired) {
    delete a.recover; delete a.recoverId;
    await wa.text(waId, 'That code has expired. Type /recover to get a new one.');
    return { kind: 'handled' };
  }
  const ok = r.code_hash != null && r.target_user_id != null && timingSafeEqual(Buffer.from(hash(code)), Buffer.from(String(r.code_hash)));
  if (!ok) {
    const tries = Number(r.attempts) + 1;
    await q(`UPDATE messaging.whatsapp_recovery SET attempts=$2, status=$3 WHERE id=$1`, [r.id, tries, tries >= MAX_TRIES ? 'locked' : String(r.status)]);
    if (tries >= MAX_TRIES) {
      delete a.recover; delete a.recoverId;
      await wa.text(waId, 'That code didn\'t match, and that was the last try for this code. Type /recover to start again, or AGENT for a person.');
    } else {
      await wa.text(waId, `That code doesn't match. Check the email and try again (${MAX_TRIES - tries} ${MAX_TRIES - tries === 1 ? 'try' : 'tries'} left).`);
    }
    return { kind: 'handled' };
  }
  delete a.recover; delete a.recoverId;
  const targetId = String(r.target_user_id);

  // This number already has its own history: never merge two real accounts automatically.
  const own = await q(`SELECT 1 FROM booking.booking WHERE user_id=$1 LIMIT 1`, [currentUserId]).catch(() => []);
  const ownReq = own[0] ? own : await q(`SELECT 1 FROM booking.service_request WHERE user_id=$1 LIMIT 1`, [currentUserId]).catch(() => []);
  if (ownReq[0]) {
    await q(`UPDATE messaging.whatsapp_recovery SET status='needs_support' WHERE id=$1`, [r.id]);
    const { supportService } = await import('../warranties/warranty.service.js');
    await supportService.open(currentUserId, `whatsapp: account recovery. Number ending ${last4(waId)} has its own bookings; customer proved they own account ${targetId.slice(0, 8)}. Merge by hand.`, undefined, 'high');
    emit('whatsapp.recovery_needs_support', {});
    await wa.text(waId, "Code confirmed. This number already has its own bookings, so we can't join the two accounts automatically. Someone from the Kendibo team will help you in this chat (8am–8pm daily).");
    return { kind: 'support' };
  }

  const phone = `+${waId.replace(/\D/g, '')}`;
  const before = await q<{ phone: string | null; email: string | null; name: string | null }>(`SELECT phone, email, name FROM identity.users WHERE id=$1`, [targetId]);
  // Detach this number from the empty account it was auto-created with, then move it to the old one.
  await q(`UPDATE identity.users SET phone=NULL, updated_at=now() WHERE phone=$1 AND id<>$2`, [phone, targetId]);
  await q(`UPDATE identity.users SET phone=$2, updated_at=now() WHERE id=$1`, [targetId, phone]);
  await q(`UPDATE messaging.whatsapp_job_draft SET status='abandoned' WHERE wa_id=$1 AND status='collecting'`, [waId]).catch(() => undefined);
  await q(`UPDATE messaging.whatsapp_recovery SET status='done' WHERE id=$1`, [r.id]);
  await q(`INSERT INTO audit.log (actor, action, entity_type, entity_id, before, after) VALUES ($1,$2,$3,$4,$5,$6)`, [
    `whatsapp:${last4(waId)}`, 'account.recovered_to_new_number', 'user', targetId,
    JSON.stringify({ phone_last4: before[0]?.phone ? String(before[0].phone).slice(-4) : null, detached_user: currentUserId }),
    JSON.stringify({ phone_last4: last4(waId) }),
  ]).catch((e) => observability.captureException(e));
  emit('whatsapp.recovered', { userId: targetId });
  if (before[0]?.email) {
    try {
      const [{ email: mailer }, { templates }] = await Promise.all([import('../notifications/channels.js'), import('../notifications/mail.templates.js')]);
      const mail = templates.accountMoved({ name: before[0].name ?? undefined, last4: last4(waId) }, { recipientEmail: String(before[0].email) });
      await mailer.send(String(before[0].email), 'Your Kendibo account moved to a new number', mail.html);
    } catch (e) { observability.captureException(e); }
  }
  const first = before[0]?.name ? String(before[0].name).trim().split(/\s+/)[0] : '';
  await wa.text(waId, `Welcome back${first ? `, ${first}` : ''}! Your Kendibo account is now on this number. Type / to see what you can do.`);
  return { kind: 'moved', userId: targetId };
}
