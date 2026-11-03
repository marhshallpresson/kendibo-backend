// Rules every WhatsApp message has to pass, kept in one place.
//
// - Scope: the assistant only does Kendibo home services. Meta's Business
//   Solution Terms (in force for every account since 15 Jan 2026) bar
//   general-purpose AI assistants; task-specific bookings and support with a
//   human hand-off are allowed. Off-topic requests are declined before any
//   LLM call (see whatsapp.bot.ts), and the first reply says it is automated.
// - 24-hour window: free-form messages only within 24h of the customer's last
//   message. Business-initiated messages (job offers, "vendor accepted") use
//   an approved template when one is configured, otherwise SMS through Sling.
// - Opt-out: STOP / START (handled in the router, stored as the promo preference).
// - Cost: since 1 Oct 2026 Meta bills service messages beyond 1,000 a month per
//   number, so each step is one message, and LLM turns are capped per customer
//   and per day.
import { q } from '../../packages/database/db.js';
import { wa, type TemplateButton } from './whatsapp.client.js';
import { llmTurnsToday } from './nlu/index.js';
import { approvedTemplate, templateParam, type TemplateKey } from './templates.js';

export const SERVICE_WINDOW_MS = 24 * 3600_000;
export const OPT_OUT = /^(stop|unsubscribe|stop promos?|stop promotions?|stop all|stop messages?)( please)?[.!]*$/;
export const OPT_IN = /^start offers$/;

export async function setJobOfferConsent(waId: string, optedIn: boolean): Promise<void> {
  await q(`INSERT INTO messaging.whatsapp_marketing_consent (wa_id, opted_in, source, updated_at)
    VALUES ($1,$2,$3,now()) ON CONFLICT (wa_id) DO UPDATE SET opted_in=$2, source=$3, updated_at=now()`,
  [waId.replace(/\D/g, ''), optedIn, optedIn ? 'whatsapp_start' : 'whatsapp_stop']);
}

export async function hasJobOfferConsent(waId: string): Promise<boolean> {
  const phone = waId.replace(/\D/g, '');
  const rows = await q<{ opted_in: boolean }>(`SELECT opted_in FROM messaging.whatsapp_marketing_consent WHERE wa_id=$1`, [phone]).catch(() => []);
  if (rows[0]?.opted_in !== true) return false;
  // Respect an opt-out from the app as well as WhatsApp. A missing preference
  // row is permitted only because an explicit consent record exists above.
  const prefs = await q<{ promo_enabled: boolean }>(
    `SELECT p.promo_enabled FROM identity.users u JOIN notification.user_preference p ON p.user_id=u.id::text WHERE u.phone=$1`, [`+${phone}`],
  ).catch(() => [{ promo_enabled: false }]);
  return prefs[0]?.promo_enabled !== false;
}

/** True when the customer messaged us in the last 24 hours. */
export async function inServiceWindow(waId: string): Promise<boolean> {
  const rows = await q<{ at: string | null }>(`SELECT MAX(received_at) AS at FROM messaging.whatsapp_inbound WHERE wa_id=$1`, [waId]).catch(() => []);
  const at = rows[0]?.at ? Date.parse(String(rows[0].at)) : NaN;
  return Number.isFinite(at) && Date.now() - at < SERVICE_WINDOW_MS;
}

export async function llmAllowed(waId: string): Promise<boolean> {
  const perCustomer = Number(process.env.WHATSAPP_AI_DAILY_TURNS || 25);
  const overall = Number(process.env.WHATSAPP_AI_GLOBAL_DAILY_TURNS || 3000);
  const used = await llmTurnsToday(waId);
  return used.mine < perCustomer && used.all < overall;
}

/**
 * A message we start (not a reply). Inside the window it goes as a normal
 * WhatsApp message; outside it as the catalogue template once Meta has
 * approved it (templates.ts), else as SMS.
 */
export async function sendBusinessInitiated(opts: {
  waId: string;
  whatsapp: () => Promise<void>;
  template?: { key: TemplateKey; params: string[]; buttons?: TemplateButton[] };
  sms: string;
}): Promise<'whatsapp' | 'template' | 'sms' | 'skipped'> {
  const isJobOffer = opts.template?.key === 'job_offer';
  if (isJobOffer && !(await hasJobOfferConsent(opts.waId))) return 'skipped';
  if (await inServiceWindow(opts.waId)) { await opts.whatsapp(); return 'whatsapp'; }
  const t = opts.template ? await approvedTemplate(opts.template.key, isJobOffer) : null;
  if (t && opts.template) {
    try {
      await wa.template(opts.waId, t.name, opts.template.params.map((p) => templateParam(p)), opts.template.buttons, t.language);
      return 'template';
    } catch { /* fall through to SMS so the message is not lost */ }
  }
  const { sms } = await import('../notifications/channels.js');
  await sms.send(`+${opts.waId.replace(/\D/g, '')}`, opts.sms, { type: isJobOffer ? 'promotional' : 'transactional' });
  return 'sms';
}

/** Plain text to a customer that may arrive after the window closed. */
export const notifyCustomer = (waId: string, text: string) =>
  sendBusinessInitiated({ waId, whatsapp: () => wa.text(waId, text), template: { key: 'request_update', params: [text.replace(/[.!]+$/, '')] }, sms: text });
