// Lifecycle, retention and marketing email (see docs/email-lifecycle.md).
//
// Three kinds, three rule sets:
//   transactional — about something the user did or must act on (approval,
//                   earnings statement). No consent needed; no unsubscribe gate.
//   lifecycle     — service tips/nudges tied to their account (welcome series,
//                   abandoned request, review ask, onboarding nudges). Legitimate
//                   interest; honours the one-click unsubscribe.
//   marketing     — promotional (win-back, seasonal, newsletter). ONLY with
//                   email_marketing_consent, never after unsubscribe, max one
//                   per user per 7 days.
// The hourly sweeper is idempotent: notification.email_send_log is unique per
// user + template + period and is claimed BEFORE sending.
import { q } from '../../packages/database/db.js';
import { observability } from '../../packages/observability/watchup.adapter.js';
import { email } from './channels.js';
import { brandedEmail, appUrl, type BrandedEmail } from './email-layout.js';

export type EmailKind = 'transactional' | 'lifecycle' | 'marketing';
const DAY = 86_400_000, HOUR = 3_600_000;
const MARKETING_CAP_MS = 7 * DAY;

interface Recipient {
  id: string; email: string | null; name: string | null;
  email_marketing_consent: boolean | null; email_unsubscribed_at: string | null;
}

export type DeliverResult = { sent: boolean; reason?: 'NO_EMAIL' | 'NO_CONSENT' | 'UNSUBSCRIBED' | 'WEEKLY_CAP' | 'ALREADY_SENT' | 'SEND_FAILED' };

async function recipient(userId: string): Promise<Recipient | null> {
  const r = await q<Recipient>(
    `SELECT id, email, name, email_marketing_consent, email_unsubscribed_at FROM identity.users WHERE id=$1`, [userId]);
  return r[0] ?? null;
}

/** Gate, claim the log row, send; release the claim if sending fails so the next sweep retries. */
export async function deliver(userId: string, template: string, period: string, kind: EmailKind,
  build: (u: Recipient) => BrandedEmail): Promise<DeliverResult> {
  const u = await recipient(userId);
  if (!u?.email) return { sent: false, reason: 'NO_EMAIL' };
  if (kind !== 'transactional' && u.email_unsubscribed_at) return { sent: false, reason: 'UNSUBSCRIBED' };
  if (kind === 'marketing') {
    if (u.email_marketing_consent !== true) return { sent: false, reason: 'NO_CONSENT' };
    const recent = await q<{ sent_at: string }>(
      `SELECT sent_at FROM notification.email_send_log WHERE user_id=$1 AND kind='marketing'`, [userId]);
    if (recent.some((r) => Date.now() - new Date(r.sent_at).getTime() < MARKETING_CAP_MS)) return { sent: false, reason: 'WEEKLY_CAP' };
  }
  const prior = await q(`SELECT 1 FROM notification.email_send_log WHERE user_id=$1 AND template=$2 AND period=$3`, [userId, template, period]);
  if (prior.length) return { sent: false, reason: 'ALREADY_SENT' };
  try {
    await q(`INSERT INTO notification.email_send_log (user_id, template, period, kind) VALUES ($1,$2,$3,$4)`, [userId, template, period, kind]);
  } catch {
    return { sent: false, reason: 'ALREADY_SENT' }; // lost the unique race
  }
  const mail = build(u);
  try {
    await email.send(u.email, mail.subject, mail.html, { text: mail.text, headers: mail.headers, reference: `${template}:${period}` });
    return { sent: true };
  } catch (e) {
    await q(`DELETE FROM notification.email_send_log WHERE user_id=$1 AND template=$2 AND period=$3`, [userId, template, period]).catch(() => {});
    observability.captureException(e as Error, { template });
    return { sent: false, reason: 'SEND_FAILED' };
  }
}

// ── Templates: short, warm, one call to action ──────────────────────────────
type Tpl = { kind: EmailKind; title: string; preheader: string; paragraphs: string[]; cta: { label: string; path: string } };
export const LIFECYCLE_TEMPLATES: Record<string, Tpl> = {
  customer_welcome_d2: { kind: 'lifecycle', title: 'How booking on Kendibo works', preheader: 'Three steps, about a minute.',
    paragraphs: ['Tell us what you need (on the app or on WhatsApp), pick a time, and we match you with a verified pro nearby.',
      'You see the price before you confirm. Your payment is held safely until the job is done.'],
    cta: { label: 'Book a service', path: '/book' } },
  customer_welcome_d5: { kind: 'lifecycle', title: 'Tips for a smooth first job', preheader: 'Photos and a landmark go a long way.',
    paragraphs: ['Add a photo of the problem and a nearby landmark so your pro arrives prepared.',
      'Share the start code only when they arrive, and rate them after so we keep standards high.'],
    cta: { label: 'Get started', path: '/book' } },
  customer_abandoned_request: { kind: 'lifecycle', title: 'Still need a hand?', preheader: 'Your request is waiting.',
    paragraphs: ['You started a request but it is not booked yet. Pick up where you left off, or reply on WhatsApp and we will help.'],
    cta: { label: 'Finish my request', path: '/requests' } },
  customer_review_ask: { kind: 'lifecycle', title: 'How did it go?', preheader: 'A 10-second rating helps your neighbours.',
    paragraphs: ['Your job is done. A quick rating helps good pros get more work and helps us fix anything that went wrong.'],
    cta: { label: 'Rate the job', path: '/bookings' } },
  customer_no_booking_30d: { kind: 'marketing', title: 'Anything need fixing at home?', preheader: 'Cleaners, AC, plumbing and more.',
    paragraphs: ['It has been a month. If the AC is noisy, a tap is dripping or the house needs a deep clean, a verified pro is close by.'],
    cta: { label: 'Book a service', path: '/book' } },
  customer_winback_60d: { kind: 'marketing', title: 'We miss you at Kendibo', preheader: 'Trusted help, still around the corner.',
    paragraphs: ['We have added more verified pros near you. Tell us what you need and we will match you in minutes.'],
    cta: { label: 'See what is new', path: '/book' } },
  customer_seasonal_ac: { kind: 'marketing', title: 'Get your AC ready for dry season', preheader: 'Beat the harmattan heat and dust.',
    paragraphs: ['Dry season is coming. A service now clears dust, checks gas and keeps your bills down when you need it most.'],
    cta: { label: 'Book AC service', path: '/book?category=ac' } },
  provider_onboarding_24h: { kind: 'lifecycle', title: 'Finish your Kendibo profile', preheader: 'A few steps to your first job.',
    paragraphs: ['You are close. Complete your ID check, add your services and prices, and add your bank account so we can pay you.'],
    cta: { label: 'Continue setup', path: '/provider/onboarding' } },
  provider_onboarding_72h: { kind: 'lifecycle', title: 'Customers near you are booking', preheader: 'Your profile is not live yet.',
    paragraphs: ['Jobs are coming in near you. Finish your profile today so we can start sending them your way. Need help? Reply to this email.'],
    cta: { label: 'Finish my profile', path: '/provider/onboarding' } },
  provider_approved: { kind: 'transactional', title: 'You are approved on Kendibo', preheader: 'Go online to start receiving jobs.',
    paragraphs: ['Welcome aboard. Your account is verified.', 'Next: list your prices, keep your location on, and go online when you are free to work.'],
    cta: { label: 'Go online', path: '/provider' } },
  provider_first_job_tips: { kind: 'lifecycle', title: 'Tips for your first Kendibo job', preheader: 'Great first jobs bring repeat customers.',
    paragraphs: ['Arrive on time, confirm the start code, take a before and after photo, and leave the space tidy.',
      'Happy customers rate you higher, and higher ratings get you more jobs.'],
    cta: { label: 'View my jobs', path: '/provider/jobs' } },
  provider_weekly_earnings: { kind: 'transactional', title: 'Your Kendibo week', preheader: 'Your earnings summary.',
    paragraphs: [], cta: { label: 'See earnings', path: '/provider/earnings' } },
  provider_inactive: { kind: 'lifecycle', title: 'Jobs are waiting near you', preheader: 'Go online to get offers again.',
    paragraphs: ['You have not been online for a while. Customers near you are booking. Go online when you are free and we will send offers.'],
    cta: { label: 'Go online', path: '/provider' } },
};

function render(template: string, userId: string, name: string | null, extra: string[] = []): BrandedEmail {
  const t = LIFECYCLE_TEMPLATES[template];
  return brandedEmail({ kind: t.kind === 'transactional' ? 'transactional' : t.kind, userId, greetingName: name,
    title: t.title, preheader: t.preheader, paragraphs: [...extra, ...t.paragraphs],
    cta: { label: t.cta.label, url: `${appUrl()}${t.cta.path}` } });
}

export function send(template: string, userId: string, period: string, extra: string[] = []): Promise<DeliverResult> {
  const t = LIFECYCLE_TEMPLATES[template];
  return deliver(userId, template, period, t.kind, (u) => render(template, userId, u.name, extra));
}

/** Newsletter/campaign to one user — always marketing (consent + cap + unsubscribe). */
export function sendMarketing(userId: string, campaignId: string, title: string, paragraphs: string[], cta?: { label: string; url: string }) {
  return deliver(userId, `campaign:${campaignId}`, 'once', 'marketing',
    (u) => brandedEmail({ kind: 'marketing', userId, greetingName: u.name, title, paragraphs, cta }));
}

const iso = (d: Date) => d.toISOString();
const isoWeek = (d: Date) => {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t.getTime() - y.getTime()) / DAY + 1) / 7)).padStart(2, '0')}`;
};
const naira = (k: number) => `NGN ${(k / 100).toLocaleString('en-NG', { maximumFractionDigits: 0 })}`;

type Row = Record<string, unknown>;
const between = (sql: string, from: Date, to: Date) => q<Row>(sql, [iso(from), iso(to)]);

/** One pass over every rule. Safe to run as often as you like. */
export async function lifecycleSweep(now = new Date()): Promise<{ sent: number; byTemplate: Record<string, number> }> {
  const byTemplate: Record<string, number> = {};
  const run = async (template: string, userId: string, period: string, extra?: string[]) => {
    try {
      const r = await send(template, userId, period, extra);
      if (r.sent) byTemplate[template] = (byTemplate[template] ?? 0) + 1;
    } catch (e) { observability.captureException(e as Error, { template }); }
  };
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const users = `SELECT id FROM identity.users WHERE email IS NOT NULL AND (role IS NULL OR role='CUSTOMER') AND created_at >= $1 AND created_at < $2`;

  // Customer welcome series (day 0 is welcome.ts at sign-up).
  for (const u of await between(users, ago(7 * DAY), ago(2 * DAY))) await run('customer_welcome_d2', String(u.id), 'once');
  for (const u of await between(users, ago(10 * DAY), ago(5 * DAY))) await run('customer_welcome_d5', String(u.id), 'once');

  // Abandoned request: submitted 6-72h ago, never booked.
  for (const r of await between(
    `SELECT id, user_id, status FROM booking.service_request WHERE booking_id IS NULL AND created_at >= $1 AND created_at < $2`, ago(72 * HOUR), ago(6 * HOUR))) {
    if (['SUBMITTED', 'MATCHING', 'OFFERED'].includes(String(r.status))) await run('customer_abandoned_request', String(r.user_id), String(r.id));
  }

  // Review ask: completed in the last 14 days with no customer rating yet.
  const done = await q<Row>(`SELECT id, user_id FROM booking.booking WHERE status='COMPLETED' AND created_at >= $1`, [iso(ago(14 * DAY))]);
  for (const b of done) {
    const rated = await q(`SELECT 1 FROM review.party_rating WHERE booking_id=$1 AND rater_role='customer'`, [b.id]).catch(() => [{}]);
    if (!rated.length) await run('customer_review_ask', String(b.user_id), String(b.id));
  }

  // Retention (marketing): last activity = latest booking or sign-up.
  const consented = await q<Row>(
    `SELECT id, created_at FROM identity.users WHERE email IS NOT NULL AND email_marketing_consent = TRUE AND email_unsubscribed_at IS NULL AND (role IS NULL OR role='CUSTOMER')`);
  const month = now.getUTCMonth(); // AC prompt Oct-Nov, before the Nov-Mar dry season / harmattan.
  for (const u of consented) {
    const last = await q<{ created_at: string }>(`SELECT created_at FROM booking.booking WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [u.id]);
    const lastAt = new Date(String(last[0]?.created_at ?? u.created_at));
    const idle = now.getTime() - lastAt.getTime();
    const since = lastAt.toISOString().slice(0, 10);
    if (idle >= 60 * DAY) await run('customer_winback_60d', String(u.id), `since:${since}`);
    else if (idle >= 30 * DAY) await run('customer_no_booking_30d', String(u.id), `since:${since}`);
    else if (month === 9 || month === 10) await run('customer_seasonal_ac', String(u.id), `${now.getUTCFullYear()}-ac`);
  }

  // Providers / vendors.
  const providers = await q<Row>(`SELECT id, user_id, kyc_status, online, location_at, created_at FROM provider.provider WHERE created_at >= $1`, [iso(ago(365 * DAY))]);
  const monday = now.getUTCDay() === 1;
  for (const p of providers) {
    const age = now.getTime() - new Date(String(p.created_at)).getTime();
    const verified = String(p.kyc_status) === 'VERIFIED';
    const uid = String(p.user_id);
    if (!verified) {
      if (age >= 72 * HOUR && age < 7 * DAY) await run('provider_onboarding_72h', uid, 'once');
      else if (age >= 24 * HOUR && age < 72 * HOUR) await run('provider_onboarding_24h', uid, 'once');
      continue;
    }
    if (age < 30 * DAY) await run('provider_approved', uid, 'once');
    const accepted = await q(`SELECT 1 FROM dispatch.assignment WHERE provider_id=$1 AND status='accepted' LIMIT 1`, [p.id]);
    if (accepted.length) await run('provider_first_job_tips', uid, 'once');
    if (monday) {
      const week = await q<{ amount_kobo: string; tip_kobo: string }>(`SELECT amount_kobo, tip_kobo FROM provider.earning WHERE provider_id=$1 AND created_at >= $2`, [p.id, iso(ago(7 * DAY))]);
      if (week.length) {
        const total = week.reduce((s, e) => s + Number(e.amount_kobo) + Number(e.tip_kobo ?? 0), 0);
        await run('provider_weekly_earnings', uid, isoWeek(now), [`Last 7 days: ${week.length} job${week.length === 1 ? '' : 's'}, ${naira(total)} earned.`]);
      }
    }
    const lastSeen = p.location_at ? new Date(String(p.location_at)).getTime() : new Date(String(p.created_at)).getTime();
    if (!p.online && now.getTime() - lastSeen >= 14 * DAY) await run('provider_inactive', uid, now.toISOString().slice(0, 7));
  }
  return { sent: Object.values(byTemplate).reduce((a, b) => a + b, 0), byTemplate };
}

let timer: NodeJS.Timeout | null = null;
let tierTimer: NodeJS.Timeout | null = null;
async function tierSweep() {
  const { tierService } = await import('../tiers/tier.service.js');
  await tierService.sweepSubscriptions();
}
/** Hourly, like startReminderSweeper. main.ts skips it under NODE_ENV=test. */
export function startLifecycleSweeper(everyMs = HOUR) {
  if (timer) return;
  timer = setInterval(() => { void lifecycleSweep().catch((e) => observability.captureException(e)); }, everyMs);
  timer.unref?.();
  // Kendibo Pro renewals / expiries / renewal reminders (tier.service.ts): more often than hourly
  // so a lapsed period is settled quickly. Idempotent (compare-and-set + once-per-period claim).
  tierTimer = setInterval(() => { void tierSweep().catch((e) => observability.captureException(e)); }, Math.min(everyMs, 15 * 60_000));
  tierTimer.unref?.();
}

// ── Consent ─────────────────────────────────────────────────────────────────
export async function setMarketingConsent(userId: string, optIn: boolean, source: string) {
  await q(
    optIn
      ? `UPDATE identity.users SET email_marketing_consent=TRUE, email_marketing_consent_at=now(), email_marketing_consent_source=$2, email_unsubscribed_at=NULL WHERE id=$1`
      : `UPDATE identity.users SET email_marketing_consent=FALSE, email_marketing_consent_at=now(), email_marketing_consent_source=$2 WHERE id=$1`,
    [userId, source.slice(0, 60)]);
  return emailPreferences(userId);
}

export async function unsubscribe(userId: string, source = 'unsubscribe_link') {
  await q(
    `UPDATE identity.users SET email_marketing_consent=FALSE, email_marketing_consent_at=now(), email_marketing_consent_source=$2, email_unsubscribed_at=now() WHERE id=$1`,
    [userId, source]);
}

export async function emailPreferences(userId: string) {
  const r = await q<Row>(`SELECT email_marketing_consent, email_marketing_consent_at, email_marketing_consent_source, email_unsubscribed_at FROM identity.users WHERE id=$1`, [userId]);
  const x = r[0] ?? {};
  return {
    marketing: x.email_marketing_consent === true,
    consentAt: x.email_marketing_consent_at ?? null,
    consentSource: x.email_marketing_consent_source ?? null,
    unsubscribedAt: x.email_unsubscribed_at ?? null,
  };
}
