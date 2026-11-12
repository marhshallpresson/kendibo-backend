// Admin email alerts: sign-ups, provider/vendor onboarding steps and unserved
// demand. Recipients come from the DATABASE (platform_setting
// 'admin.alert_emails', seeded in 042, edited from the admin console) — never
// from env. Driven by the in-process emit() bus, so every alert is
// fire-and-forget: it never blocks or fails the user's request. Each alert has
// a dedupe key in notification.admin_alert_log so "first time online" or
// "request X unserved" is sent exactly once.
import { z } from 'zod';
import { q } from '../../packages/database/db.js';
import { onEmit } from '../../packages/observability/emit.js';
import { observability } from '../../packages/observability/watchup.adapter.js';
import { getSetting, setSetting } from '../settings/settings.service.js';
import { email } from './channels.js';
import { brandedEmail, appUrl } from './email-layout.js';

export const ALERT_EMAILS_KEY = 'admin.alert_emails';
export const DEFAULT_ALERT_EMAILS = ['admin@kendibo.ng', 'alerts@kendibo.ng'];
export const alertEmailsSchema = z.array(z.string().trim().toLowerCase().email()).min(1).max(20);

export async function getAlertEmails(): Promise<string[]> {
  const v = await getSetting<unknown>(ALERT_EMAILS_KEY).catch(() => null);
  const parsed = alertEmailsSchema.safeParse(v);
  return parsed.success ? Array.from(new Set(parsed.data)) : DEFAULT_ALERT_EMAILS;
}

export async function setAlertEmails(list: string[], actor?: string): Promise<string[]> {
  const clean = Array.from(new Set(alertEmailsSchema.parse(list)));
  await setSetting(ALERT_EMAILS_KEY, clean, actor);
  return clean;
}

/** 08012345678 / +2348012345678 -> +234801***678 */
export function maskPhone(phone?: string | null): string {
  const p = String(phone ?? '').trim();
  if (p.length < 7) return p ? '***' : 'not given';
  return `${p.slice(0, p.length - 6)}***${p.slice(-3)}`;
}

const pending = new Set<Promise<unknown>>();
function track(p: Promise<unknown>) {
  pending.add(p);
  void p.finally(() => pending.delete(p));
}

async function claim(dedupeKey: string, kind: string): Promise<boolean> {
  const seen = await q(`SELECT 1 FROM notification.admin_alert_log WHERE dedupe_key=$1`, [dedupeKey]);
  if (seen.length) return false;
  try {
    await q(`INSERT INTO notification.admin_alert_log (dedupe_key, kind) VALUES ($1,$2)`, [dedupeKey, kind]);
    return true;
  } catch {
    return false; // a concurrent sender won the unique key
  }
}

export interface AdminAlert { kind: string; dedupeKey: string; title: string; lines: string[]; link?: string }

/** Send one alert to every configured recipient. Never throws. */
export async function sendAdminAlert(a: AdminAlert): Promise<{ sent: number; skipped?: 'duplicate' }> {
  try {
    if (!(await claim(a.dedupeKey, a.kind))) return { sent: 0, skipped: 'duplicate' };
    const to = await getAlertEmails();
    const mail = brandedEmail({
      kind: 'admin', title: `[Kendibo alert] ${a.title}`, preheader: a.lines[0],
      paragraphs: [...a.lines, `Time: ${new Date().toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })} (WAT)`],
      cta: a.link ? { label: 'Open in admin', url: a.link } : undefined,
    });
    let sent = 0; const errors: string[] = [];
    for (const r of to) {
      try { await email.send(r, mail.subject, mail.html, { text: mail.text, reference: a.dedupeKey }); sent++; }
      catch (e) { errors.push(`${r}: ${(e as Error).message}`); }
    }
    await q(`UPDATE notification.admin_alert_log SET recipients=$2, error=$3 WHERE dedupe_key=$1`,
      [a.dedupeKey, sent, errors.length ? errors.join('; ').slice(0, 500) : null]).catch(() => {});
    if (errors.length) observability.captureException(new Error(`admin alert ${a.kind} partial failure: ${errors.join('; ')}`));
    return { sent };
  } catch (e) {
    try { observability.captureException(e as Error); } catch { /* fail open */ }
    return { sent: 0 };
  }
}

const admin = (path: string) => `${appUrl()}/admin${path}`;

async function userInfo(userId: string) {
  const r = await q<{ name: string | null; phone: string | null; email: string | null; role: string | null }>(
    `SELECT name, phone, email, role FROM identity.users WHERE id=$1`, [userId]);
  return r[0] ?? { name: null, phone: null, email: null, role: null };
}

async function providerInfo(providerId: string) {
  const r = await q<{ user_id: string; business_name: string | null; office_city: string | null }>(
    `SELECT user_id, business_name, office_city FROM provider.provider WHERE id=$1`, [providerId]).catch(() => []);
  if (!r[0]) return { name: 'Unknown provider', phone: 'n/a', city: '' };
  const u = await userInfo(String(r[0].user_id));
  return { name: r[0].business_name || u.name || 'Unnamed provider', phone: maskPhone(u.phone), city: r[0].office_city || '' };
}

async function providerStep(providerId: string, step: string, title: string, extra: string[] = [], once = true) {
  const p = await providerInfo(providerId);
  return sendAdminAlert({
    kind: `provider.${step}`,
    dedupeKey: once ? `provider:${providerId}:${step}` : `provider:${providerId}:${step}:${Date.now()}`,
    title: `${title}: ${p.name}`,
    lines: [`Provider: ${p.name}`, `Phone: ${p.phone}`, ...(p.city ? [`City: ${p.city}`] : []), ...extra],
    link: admin(`/providers/${providerId}`),
  });
}

export async function alertUnservedRequest(requestId: string, reason: string) {
  const r = await q<Record<string, unknown>>(`SELECT * FROM booking.service_request WHERE id=$1`, [requestId]);
  const req = r[0];
  if (!req) return { sent: 0 };
  const u = await userInfo(String(req.user_id));
  let category = String(req.category_id ?? req.service_id ?? '');
  if (req.category_id) {
    const c = await q<{ name: string }>(`SELECT name FROM catalog.category WHERE id=$1`, [req.category_id]).catch(() => []);
    if (c[0]) category = String(c[0].name);
  }
  let area = '';
  if (req.address_id) {
    const a = await q<{ street: string | null; estate: string | null; city: string | null }>(
      `SELECT street, estate, city FROM property.address WHERE id=$1`, [req.address_id]).catch(() => []);
    if (a[0]) area = [a[0].estate, a[0].street, a[0].city].filter(Boolean).join(', ');
  }
  if (!area && req.lat != null) area = `${Number(req.lat).toFixed(4)}, ${Number(req.lng).toFixed(4)}`;
  const why: Record<string, string> = {
    NO_PROVIDER_IN_RANGE: 'No available, verified provider in range',
    SERVICE_NOT_OFFERED: 'Service/category we do not offer (or unrecognised)',
    NO_LOCATION: 'No location given, so nobody could be matched',
  };
  return sendAdminAlert({
    kind: 'demand.unserved',
    dedupeKey: `request:${requestId}:unserved`,
    title: `Unserved request: ${category || 'unknown service'}${area ? ` in ${area}` : ''}`,
    lines: [
      `Why: ${why[reason] ?? reason}`,
      `Category: ${category || 'not set'}`,
      `Area/city: ${area || 'unknown'}`,
      `Customer: ${String(req.contact_name ?? u.name ?? 'unnamed')} (${maskPhone(String(req.contact_phone ?? u.phone ?? ''))})`,
      `Asked for: ${String(req.title ?? '')}${req.details ? ` — ${String(req.details).slice(0, 300)}` : ''}`,
      `Channel: ${String(req.source ?? 'app')}`,
      `Submitted: ${new Date(String(req.created_at ?? Date.now())).toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })}`,
    ],
    link: admin(`/requests/${requestId}`),
  });
}

/**
 * The identity provider (Prembly) could not answer — unconfigured, unfunded,
 * over quota or down — so an ID application was saved for a human to verify.
 * One email per application: the dedupe key carries the application ref.
 */
export async function alertKycManualReview(p: Record<string, unknown>) {
  const subjectType = String(p.subjectType ?? '') === 'provider' ? 'provider' : 'user';
  const subjectId = String(p.subjectId ?? '');
  if (!subjectId) return { sent: 0 };
  let who: { name: string; phone: string };
  if (subjectType === 'provider') {
    const info = await providerInfo(subjectId);
    who = { name: info.name, phone: info.phone };
  } else {
    const u = await userInfo(subjectId);
    who = { name: u.name || 'Unnamed customer', phone: maskPhone(u.phone) };
  }
  const reason = String(p.reason ?? 'provider unavailable').slice(0, 200);
  return sendAdminAlert({
    kind: 'kyc.manual_review_needed',
    dedupeKey: `kyc:${subjectType}:${subjectId}:manual_review:${String(p.applicationRef ?? 'once')}`,
    title: `KYC needs manual verification: ${who.name}`,
    lines: [
      `${subjectType === 'provider' ? 'Provider/vendor' : 'Customer'}: ${who.name}`,
      `Phone: ${who.phone}`,
      `Why: the identity provider could not verify automatically (${reason})`,
      'The application is saved as UNDER_REVIEW. Check the documents and approve or reject it.',
    ],
    link: admin('/kyc/queue'),
  });
}

async function onEvent(event: string, p: Record<string, unknown>): Promise<unknown> {
  const pid = p.providerId ? String(p.providerId) : '';
  switch (event) {
    case 'identity.user_created':
    case 'whatsapp.user_created': {
      const userId = String(p.userId);
      const u = await userInfo(userId);
      const channel = event === 'whatsapp.user_created' ? 'whatsapp' : String(p.channel ?? 'app');
      const isProvider = String(p.role ?? u.role ?? '').toUpperCase() === 'PROVIDER';
      return sendAdminAlert({
        kind: isProvider ? 'signup.provider' : 'signup.customer',
        dedupeKey: `user:${userId}:signup`,
        title: `New ${isProvider ? 'provider/vendor' : 'customer'} sign-up via ${channel}`,
        lines: [`Name: ${u.name || 'not given yet'}`, `Phone: ${maskPhone(u.phone)}`, `Email: ${u.email ? 'yes' : 'no'}`, `Channel: ${channel}`],
        link: admin(`/users/${userId}`),
      });
    }
    case 'provider.onboarded': return providerStep(pid, 'onboarded', 'New provider/vendor profile started');
    // A manual-review submission gets its own alert (kyc.manual_review_needed) instead.
    case 'kyc.submitted': return p.manualReview ? null : providerStep(pid, 'kyc_submitted', 'KYC submitted', [`Status: ${String(p.status ?? 'PENDING')}`], false);
    case 'kyc.manual_review_needed': return alertKycManualReview(p);
    case 'kyc.approved': return providerStep(pid, 'kyc_passed', 'KYC passed');
    case 'kyc.rejected': return providerStep(pid, 'kyc_failed', 'KYC failed', [`Reason: ${String(p.reason ?? 'not given')}`], false);
    case 'provider.kyb_submitted': return providerStep(pid, 'kyb_submitted', 'Business KYB submitted', [`CAC/RC number given: ${p.hasRcNumber ? 'yes' : 'no'}`]);
    case 'provider.bank_added': return providerStep(pid, 'bank_added', 'Bank account added');
    case 'offering.created': return providerStep(pid, 'first_price', 'First price listed', [`Category: ${String(p.categoryId ?? '')}`]);
    case 'provider.availability': return p.online ? providerStep(pid, 'first_online', 'First time online') : null;
    case 'provider.verified': return providerStep(pid, 'approved', 'Provider approved', [`Level: ${String(p.level ?? '')}`]);
    case 'category.provider_created': {
      const prov = await providerInfo(pid);
      return sendAdminAlert({
        kind: 'category.provider_created',
        dedupeKey: `category:${String(p.categoryId)}:provider_created`,
        title: `New provider-made category: ${String(p.name ?? p.categoryId)}`,
        lines: [
          `Category: ${String(p.name ?? '')} (${String(p.categoryId)})`,
          `Group: ${String(p.groupId ?? 'other')}`,
          `Added by: ${prov.name} (${prov.phone})`,
          'It is live now. Approve, merge it into an existing category, or reject it.',
        ],
        link: admin('/category-proposals'),
      });
    }
    case 'request.unserved': return alertUnservedRequest(String(p.requestId), String(p.reason ?? ''));
    case 'whatsapp.request_submitted':
      return Number(p.vendors ?? 0) === 0 ? alertUnservedRequest(String(p.requestId), 'NO_PROVIDER_IN_RANGE') : null;
    default: return null;
  }
}

let installed = false;
/** Subscribe to the event bus once (idempotent). */
export function installAdminAlerts(): void {
  if (installed) return;
  installed = true;
  onEmit((event, props) => {
    const p = onEvent(event, props).catch((e) => { try { observability.captureException(e as Error); } catch { /* fail open */ } });
    track(p);
  });
}

/** Wait for in-flight alerts (tests, graceful shutdown). */
export async function flushAdminAlerts(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}
