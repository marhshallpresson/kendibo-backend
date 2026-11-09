// WhatsApp booking assistant: the second front door next to the app.
//
// Every inbound message goes through one router:
//   1. Receipt: dedupe by message id and keep the payload until it has been
//      processed (a crash mid-turn is retried by the sweeper); one turn at a
//      time per customer, so two quick messages can't race on the same draft.
//   2. Gates: vendor offer taps, STOP / START, the abuse limit, human hand-off.
//   3. Taps on our buttons and lists drive the booking flow (flow.ts).
//   4. A shared location or photo is saved to the job draft.
//   5. Text goes to the understanding layer (nlu/): intent, scope, trade,
//      budget, day and time. Off-topic requests are declined without an LLM
//      call; common questions get the official answers (facts.ts); booking
//      details fill the draft and the next step is asked. Only text the
//      classifier is unsure about goes to the AI fallback (agent.ts), within
//      a daily budget.
// Each customer text is logged, redacted, with what the router did. Ops label
// those lines in the admin console and the intent model retrains on them.
//
// Identity: Meta verifies the sender's number, so wa_id links to the account
// with that number (or creates a CUSTOMER account). Payment is confirmed by
// the PSP webhook, never by anything typed in the chat.
import { q } from '../../packages/database/db.js';
import { emit } from '../../packages/observability/emit.js';
import { observability } from '../../packages/observability/watchup.adapter.js';
import { wa, onMessageSent } from './whatsapp.client.js';
import { understand, logTurn, type Understanding } from './nlu/index.js';
import { currentDraft, openDraft, patchDraft, addPhotoToDraft, saveDraftLocation, cancelDraft, submitDraft, type Draft } from './draft.js';
import { nextStep, sendStep, handleFlowTap, patchFromUnderstanding, acknowledge, tradeName, type Asked, type Step } from './flow.js';
import { FACTS, priceLines } from './facts.js';
import { OPT_IN, OPT_OUT, llmAllowed, sendBusinessInitiated, notifyCustomer, setJobOfferConsent } from './policy.js';
import { activeRelay, closeRelay, relayText, relayMedia } from './relay.js';
import { idCheckLink, termsLink, payToken, webBase, emailConfirmLink } from './links.js';

type State = 'BOT' | 'HUMAN';
interface Session { waId: string; userId: string | null; state: State; data: Asked; updatedAt: number }

export interface InboundMessage {
  id: string; from: string; type: string;
  text?: { body?: string };
  interactive?: { button_reply?: { id: string; title: string }; list_reply?: { id: string; title: string } };
  button?: { payload?: string; text?: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  image?: { id: string; mime_type?: string; caption?: string };
  audio?: { id: string; mime_type?: string; voice?: boolean };
  video?: { id: string; mime_type?: string; caption?: string };
  document?: { id: string; mime_type?: string; caption?: string; filename?: string };
}

interface Deps {
  createCheckout: (input: { bookingId: string; amountKobo: bigint; customerEmail?: string; reference: string; idempotencyKey: string }) => Promise<{ checkoutUrl?: string | null; psp?: string }>;
}
let deps: Deps | null = null;
export function configureWhatsappBot(d: Deps) { deps = d; }

const HUMAN_MODE_MS = 12 * 3600_000;
const DRAFT_STALE_MS = 48 * 3600_000;
const RETRY_AFTER_MS = 10 * 60_000;
const naira = (kobo: bigint | string | number) => `₦${(Number(kobo) / 100).toLocaleString('en-NG', { maximumFractionDigits: 0 })}`;
const e164 = (waId: string) => `+${waId.replace(/\D/g, '')}`;
const firstName = (n?: string) => (n ? n.trim().split(/\s+/)[0] : '');
const MENU_BUTTONS = [
  { id: 'menu:book', title: 'Book a service' },
  { id: 'menu:bookings', title: 'My bookings' },
  { id: 'menu:help', title: 'Talk to a person' },
];
const DISCLOSURE = 'I\'m Kendibot, Kendibo\'s automated assistant. Type "agent" any time to reach a person.';
const EMPTY_DRAFT: Draft = {
  id: '', need: null, category_id: null, service_id: null, budget_kobo: null, photo_asset_ids: [], lat: null, lng: null,
  address_text: null, landmark: null, scheduled_date: null, time_window: null, request_id: null,
};

// Bot messages are kept as assistant turns: the support inbox shows them and
// the AI fallback reads them as conversation history.
onMessageSent(async (to, summary) => {
  if (!summary.trim()) return;
  await q(`INSERT INTO messaging.whatsapp_turn (wa_id, role, content) VALUES ($1,'assistant',$2)`, [to, summary.slice(0, 2000)]).catch(() => undefined);
});

// One turn at a time per customer (single API instance; a shared queue replaces this when we scale out).
const chains = new Map<string, Promise<void>>();
function runSerially(key: string, fn: () => Promise<void>): Promise<void> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn).finally(() => { if (chains.get(key) === next) chains.delete(key); });
  chains.set(key, next);
  return next;
}

async function loadSession(waId: string): Promise<Session> {
  const r = (await q<Record<string, unknown>>(`SELECT * FROM messaging.whatsapp_session WHERE wa_id=$1`, [waId]))[0];
  if (!r) return { waId, userId: null, state: 'BOT', data: {}, updatedAt: 0 };
  const data = (typeof r.data === 'string' ? JSON.parse(r.data) : (r.data ?? {})) as Asked;
  return { waId, userId: r.user_id ? String(r.user_id) : null, state: String(r.state) === 'HUMAN' ? 'HUMAN' : 'BOT', data, updatedAt: new Date(String(r.updated_at)).getTime() };
}
async function saveSession(s: Session) {
  await q(`DELETE FROM messaging.whatsapp_session WHERE wa_id=$1`, [s.waId]);
  await q(`INSERT INTO messaging.whatsapp_session (wa_id, user_id, state, data, updated_at) VALUES ($1,$2,$3,$4, now())`,
    [s.waId, s.userId, s.state, JSON.stringify(s.data)]);
}

/** Find (or create) the account behind a WhatsApp number. */
async function userFor(waId: string, profileName?: string): Promise<{ id: string; role: string; email: string | null }> {
  const phone = e164(waId);
  const found = await q<{ id: string; role: string | null; email: string | null }>(`SELECT id, role, email FROM identity.users WHERE phone=$1`, [phone]);
  if (found[0]) return { id: String(found[0].id), role: String(found[0].role ?? 'CUSTOMER'), email: found[0].email ? String(found[0].email) : null };
  const created = await q<{ id: string }>(
    `INSERT INTO identity.users (phone, name, role) VALUES ($1,$2,'CUSTOMER') RETURNING id`, [phone, (profileName ?? '').slice(0, 80) || null],
  );
  emit('whatsapp.user_created', { userId: String(created[0].id) });
  return { id: String(created[0].id), role: 'CUSTOMER', email: null };
}

/**
 * Download a customer's photo, voice note, video or PDF from Meta and store it
 * (object storage / FTP via mediaService). Returns null when the message has no file.
 */
async function saveUpload(m: InboundMessage): Promise<{ kind: 'image' | 'audio' | 'video' | 'document'; assetId: string | null; url: string | null; mime: string; bytes: Buffer | null } | null> {
  const kind = (['image', 'audio', 'video', 'document'] as const).find((k) => m.type === k && m[k]?.id);
  if (!kind) return null;
  const media = await wa.downloadMedia(String(m[kind]!.id)).catch(() => null);
  if (!media) return { kind, assetId: null, url: null, mime: '', bytes: null };
  const { mediaService } = await import('../media/media.service.js');
  const { assetId } = await mediaService.presign(kind === 'image' ? 'photo' : kind === 'video' ? 'video' : 'doc');
  const done = await mediaService.ingest(assetId, media.bytes, media.mime).catch(() => null);
  return done?.status === 'clean'
    ? { kind, assetId, url: (done as { url?: string }).url ?? null, mime: media.mime, bytes: media.bytes }
    : { kind, assetId: null, url: null, mime: media.mime, bytes: null };
}

const replyId = (m: InboundMessage) => m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id ?? m.button?.payload ?? '';
const replyText = (m: InboundMessage) =>
  (m.text?.body ?? m.image?.caption ?? m.video?.caption ?? m.document?.caption ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? m.button?.text ?? '').trim();

// ── Replies ──────────────────────────────────────────────────────────────────
async function sendWelcome(to: string, name?: string) {
  await wa.buttons(to, `${firstName(name) ? `Hi ${firstName(name)}! ` : 'Hi! '}I'm Kendibot, Kendibo's automated assistant. What do you need help with?\n\nType AGENT for a person. Vendors: reply START OFFERS for job offers by WhatsApp or SMS, or STOP to opt out.`, MENU_BUTTONS);
}
const sendMenu = (to: string, body = 'What would you like to do?') => wa.buttons(to, body, MENU_BUTTONS);

async function handOff(s: Session, userId: string, to: string, summary: string) {
  const { supportService } = await import('../warranties/warranty.service.js');
  const t = await supportService.open(userId, `whatsapp: ${summary.slice(0, 200)}`);
  s.state = 'HUMAN';
  emit('whatsapp.handoff', { ticketId: (t as { id?: string }).id ?? null });
  await wa.text(to, 'Okay. Someone from the Kendibo team will reply in this chat (8am–8pm daily). Type "bot" to go back to the assistant.');
}

async function sendStatus(to: string, userId: string, draft: Draft | null) {
  const b = await q<{ name: string | null; service_id: string; status: string; scheduled_at: string | null }>(
    `SELECT s.name, b.service_id, b.status, b.scheduled_at FROM booking.booking b LEFT JOIN catalog.service s ON s.id = b.service_id
      WHERE b.user_id=$1 ORDER BY b.created_at DESC LIMIT 3`, [userId],
  ).catch(() => []);
  const r = await q<{ title: string; status: string }>(
    `SELECT title, status FROM booking.service_request WHERE user_id=$1 ORDER BY created_at DESC LIMIT 3`, [userId],
  ).catch(() => []);
  const lines = [
    ...b.map((x) => `• ${x.name ?? x.service_id}: ${String(x.status).replace(/_/g, ' ').toLowerCase()}${x.scheduled_at ? `, ${new Date(String(x.scheduled_at)).toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Africa/Lagos' })}` : ''}`),
    ...r.map((x) => `• Request "${String(x.title).slice(0, 60)}": ${String(x.status).replace(/_/g, ' ').toLowerCase()}`),
  ];
  const body = lines.length ? `Your latest:\n${lines.join('\n')}` : 'You have no bookings yet.';
  if (draft) await wa.buttons(to, `${body}\n\nYou also have a request in progress.`, [{ id: 'flow:resume', title: 'Continue it' }, { id: 'menu:help', title: 'Talk to a person' }]);
  else await wa.buttons(to, body, [{ id: 'menu:book', title: 'Book a service' }, { id: 'menu:help', title: 'Talk to a person' }]);
}

async function factAnswer(u: Understanding, text: string, draft: Draft | null): Promise<string> {
  switch (u.intent) {
    case 'payment': return /refund|money back|cancel/i.test(text) ? FACTS.refunds : FACTS.payments;
    case 'pricing': {
      const cat = u.trade ?? draft?.category_id ?? null;
      const lines = cat ? await priceLines(cat) : null;
      return lines ? `${FACTS.pricing}\n\n${await tradeName(cat)}:\n${lines}` : FACTS.pricing;
    }
    case 'coverage': return FACTS.coverage;
    case 'trust':
      if (/warrant|guarantee|fail|break/i.test(text)) return FACTS.warranty;
      if (/what is kendibo|how does (this|it|kendibo) work|legit/i.test(text)) return FACTS.about;
      return FACTS.safety;
    case 'vendor_join': return FACTS.become_a_pro;
    default: return FACTS.about;
  }
}

/** Accept a pin (shared location or typed address) if we cover it. */
async function useLocation(to: string, s: Session, userId: string, loc: { lat: number; lng: number; address: string }): Promise<boolean> {
  const { geoService } = await import('../geo/geo.service.js');
  const zone = await geoService.checkZone(loc.lat, loc.lng);
  if (!zone.serviceable) {
    await wa.text(to, "Sorry, we don't cover that spot yet. We're live in Uyo first, then Lagos and Abuja.");
    return false;
  }
  const d = await openDraft(to, userId);
  await saveDraftLocation(to, d.id, loc);
  await sendStep(to, (await currentDraft(to)) ?? d, s.data, 'Location saved.');
  return true;
}

async function tryAgent(to: string, s: Session, userId: string, text: string, u: Understanding, step: Step | null, images: { mime: string; base64: string }[]): Promise<boolean> {
  const { aiConfigured, runAgent } = await import('./agent.js');
  if (!aiConfigured() || !(await llmAllowed(to))) return false;
  await saveSession(s); // talk_to_human can switch the stored state mid-turn
  return runAgent({ waId: to, userId, text, images, hints: { intent: u.intent, confidence: u.confidence, step } });
}

// ── Vendor offer taps ──────────────────────────────────────────────────────
async function handleOfferTap(waId: string, offerId: string, accept: boolean) {
  const user = await q<{ id: string }>(`SELECT id FROM identity.users WHERE phone=$1`, [e164(waId)]);
  const prov = user[0] ? await q<{ id: string }>(`SELECT id FROM provider.provider WHERE user_id=$1`, [String(user[0].id)]) : [];
  const offer = await q<{ provider_id: string; category_id: string | null }>(
    `SELECT o.provider_id, r.category_id FROM booking.request_offer o JOIN booking.service_request r ON r.id=o.request_id WHERE o.id=$1`, [offerId],
  );
  if (!prov[0] || !offer[0] || String(offer[0].provider_id) !== String(prov[0].id)) {
    await wa.text(waId, 'That job offer is not available on this number.');
    return;
  }
  const providerId = String(prov[0].id);
  if (accept) {
    const { vendorEligibilityService } = await import('../vendors/eligibility.service.js');
    if (!(await vendorEligibilityService.allowed(providerId, offer[0].category_id))) {
      await wa.text(waId, "You can't accept jobs in this trade yet. Open the Kendibo app to finish your verification.");
      return;
    }
  }
  const { requestService } = await import('../requests/request.service.js');
  try {
    await requestService.respondOffer(offerId, accept);
    await wa.text(waId, accept ? 'Job accepted. Open the Kendibo app for the address and to start the trip.' : 'Offer declined.');
  } catch (e) {
    await wa.text(waId, (e as Error).message === 'OFFER_TAKEN' ? 'Another pro took this job first.' : 'This offer has expired.');
  }
}

/** Job offer to a vendor: buttons inside the 24h window, else a template or SMS. */
export async function notifyProviderOfOffer(providerPhone: string, offerId: string, summary: string) {
  const waId = providerPhone.replace(/\D/g, '');
  await sendBusinessInitiated({
    waId,
    whatsapp: () => wa.buttons(waId, `New job near you: ${summary}`, [
      { id: `offer:${offerId}:accept`, title: 'Accept' },
      { id: `offer:${offerId}:decline`, title: 'Decline' },
    ]),
    template: {
      key: 'job_offer',
      params: [summary.slice(0, 200)],
      buttons: [{ index: 0, payload: `offer:${offerId}:accept` }, { index: 1, payload: `offer:${offerId}:decline` }],
    },
    sms: `New Kendibo job near you: ${summary.slice(0, 100)}. Open the Kendibo app to accept it.`,
  }).catch((e) => observability.captureException(e));
}

// ── Inbound ──────────────────────────────────────────────────────────────────
async function storeInbound(m: InboundMessage, profileName?: string): Promise<boolean> {
  // Only a duplicate may be ignored. A database error must reach the webhook
  // handler so Meta retries instead of losing the message after a 200 response.
  const rows = await q<{ message_id: string }>(
    `INSERT INTO messaging.whatsapp_inbound (message_id, wa_id, payload, profile_name) VALUES ($1,$2,$3,$4)
     ON CONFLICT (message_id) DO NOTHING RETURNING message_id`,
    [m.id, m.from, JSON.stringify(m), profileName ?? null],
  );
  return Boolean(rows[0]);
}

export async function handleInbound(m: InboundMessage, profileName?: string): Promise<void> {
  if (!(await storeInbound(m, profileName))) return;
  void wa.markRead(m.id);
  await runSerially(m.from, () => processAndMark(m, profileName));
}

/** Persist before acknowledging the webhook; process the saved message in the background. */
export async function enqueueInbound(m: InboundMessage, profileName?: string): Promise<void> {
  if (!(await storeInbound(m, profileName))) return;
  void wa.markRead(m.id);
  void runSerially(m.from, () => processAndMark(m, profileName)).catch((e) => {
    observability.captureException(e);
    console.error('[whatsapp] inbound processing failed; message remains queued');
  });
}

async function processAndMark(m: InboundMessage, profileName?: string) {
  await q(`UPDATE messaging.whatsapp_inbound SET started_at=now(), attempts=attempts+1 WHERE message_id=$1`, [m.id]).catch(() => undefined);
  try {
    await processInbound(m, profileName);
  } catch (e) {
    observability.captureException(e);
    const message = e instanceof Error ? e.message : '';
    const reason = /^WHATSAPP_SEND_\d{3}(?:_META_\d{1,8})?$/.test(message) ? message : 'INBOUND_PROCESSING_ERROR';
    console.error('[whatsapp] inbound processing failed', { reason });
    // If even the fallback cannot be delivered, leave the message unprocessed
    // for the bounded recovery sweep instead of silently discarding it.
    await wa.text(m.from, 'Something went wrong on our side. Please try again in a moment, or type "agent" to reach a person.');
  }
  // Processed (or answered with an apology): the sweeper only retries turns a crash cut short.
  await q(`UPDATE messaging.whatsapp_inbound SET processed_at=now() WHERE message_id=$1`, [m.id]).catch(() => undefined);
}

async function processInbound(m: InboundMessage, profileName?: string): Promise<void> {
  const to = m.from;
  const id = replyId(m);
  const text = replyText(m);
  const lower = text.toLowerCase().trim();

  const offerTap = id.match(/^offer:([0-9a-f-]{36}):(accept|decline)$/i);
  if (offerTap) return handleOfferTap(to, offerTap[1], offerTap[2] === 'accept');

  const s = await loadSession(to);
  const user = await userFor(to, profileName);
  s.userId = user.id;
  const firstContact = !(await q(`SELECT 1 FROM messaging.whatsapp_turn WHERE wa_id=$1 LIMIT 1`, [to]).catch(() => []))[0];
  await q(`INSERT INTO messaging.whatsapp_turn (wa_id, role, content) VALUES ($1,'user',$2)`, [to, (text || `(${m.type})`).slice(0, 2000)]).catch(() => undefined);

  // Marketing opt-out (Meta policy, NDPA 2023): STOP turns promotions off on
  // every channel; START turns them back on. Booking updates still go out.
  if (!id && OPT_OUT.test(lower)) {
    await setJobOfferConsent(to, false);
    const { notificationService } = await import('../notifications/notification.service.js');
    await notificationService.updateUserPreferences(user.id, { promo: false });
    emit('whatsapp.opt_out', { userId: user.id });
    const d = await currentDraft(to);
    if (d) await cancelDraft(d.id);
    s.data = {};
    await saveSession(s);
    await wa.text(to, "Done. You won't get offers or promotions from Kendibo. You'll still get messages about your own bookings. Reply START OFFERS to receive job offers by WhatsApp or SMS again.");
    return;
  }
  if (!id && OPT_IN.test(lower)) {
    await setJobOfferConsent(to, true);
    emit('whatsapp.opt_in', { userId: user.id });
    await wa.text(to, "You've opted in to Kendibo job offers by WhatsApp or SMS. Reply STOP any time to opt out.");
    return;
  }

  // Abuse / cost guard: at most 40 inbound messages per number per hour.
  const recent = await q<{ n: string }>(
    `SELECT COUNT(*) AS n FROM messaging.whatsapp_inbound WHERE wa_id=$1 AND received_at > $2`, [to, new Date(Date.now() - 3600_000).toISOString()],
  ).catch(() => [{ n: '0' }]);
  if (Number(recent[0]?.n ?? 0) > 40) return;

  // Onboarding: a short notice and one tap to agree before the first booking
  // (NDPA 2023 notice + consent). Whatever they asked first is kept and
  // answered straight after they agree, so nobody has to repeat themselves.
  if ((process.env.WHATSAPP_CONSENT_GATE ?? 'on') !== 'off') {
    const t = await q<{ at: string | null }>(`SELECT terms_accepted_at AS at FROM identity.users WHERE id=$1`, [user.id]).catch(() => [{ at: 'unknown' }]);
    if (!t[0]?.at) {
      if (id === 'consent:agree') {
        await q(`UPDATE identity.users SET terms_accepted_at=now(), terms_source='whatsapp' WHERE id=$1`, [user.id]);
        emit('whatsapp.terms_accepted', { userId: user.id });
        await sendWelcomeSms(to, user.id, profileName);
        await askName(to, s, profileName);
        await saveSession(s);
        return;
      }
      if (text && !id) s.data.pendingText = text.slice(0, 500);
      await saveSession(s);
      const hi = firstName(profileName) ? `Welcome to Kendibo, ${firstName(profileName)}!` : 'Welcome to Kendibo!';
      await wa.buttons(to, `${hi} I can book ID-checked cleaners, plumbers, electricians, AC and generator repairers and more, right here in WhatsApp.\n\nBefore we start: we use your name, number and the location you share to run your bookings, and you pay through Kendibo so your money is held until the job is done.\n\nTerms and privacy: ${termsLink()}`, [{ id: 'consent:agree', title: 'Agree & continue' }]);
      return;
    }
  }

  // Onboarding steps after consent: name (one tap), then email (or skip).
  if (s.data.onboard) {
    const done = await handleOnboarding(to, s, user.id, text, id, profileName);
    if (!done) { await saveSession(s); return; }
    const pending = s.data.pendingText ?? '';
    delete s.data.pendingText;
    await saveSession(s);
    if (pending) return processInbound({ id: `${m.id}:pending`, from: to, type: 'text', text: { body: pending } }, profileName);
    await sendWelcome(to, profileName);
    return;
  }

  // Shortcuts that work at any point: resend the pay button, or the ID check.
  if (!id && /^(pay|pay now|payment|make payment)[.!]*$/.test(lower)) { await sendPayButton(to, user.id); return; }
  // Completion: DONE confirms the job the pro marked finished; PROBLEM freezes it
  // (no payout) and hands the chat to a person.
  if (!id && /^(done|it'?s done|job done|confirm|confirmed|yes it'?s done)[.!]*$/.test(lower)) {
    const { awaitingConfirmationFor, confirmCompletion } = await import('../job-engine/job-guard.js');
    const bookingId = await awaitingConfirmationFor(user.id);
    if (!bookingId) { await sendMenu(to, "There's no finished job waiting for your confirmation right now."); return; }
    const out = await confirmCompletion(bookingId, 'customer');
    await wa.text(to, out === 'confirmed'
      ? 'Thanks for confirming! Your pro will be paid. Rate them in the app to help other customers.'
      : out === 'disputed' ? 'This job has an open report. Our team will settle it with you here.' : 'That job is not ready to confirm yet.');
    return;
  }
  if (!id && /^(problem|report|not done|issue|complain|complaint)[.!]*$/.test(lower)) {
    const { awaitingConfirmationFor } = await import('../job-engine/job-guard.js');
    const bookingId = await awaitingConfirmationFor(user.id);
    if (bookingId) {
      const { flag } = await import('../job-engine/job.machine.js');
      await flag(bookingId, 'DISPUTED', 'customer', 'reported on WhatsApp').catch(() => undefined);
    }
    await handOff(s, user.id, to, `Customer reported a problem${bookingId ? ` with booking ${bookingId.slice(0, 8)}` : ''}. Payment is on hold.`);
    await saveSession(s);
    return;
  }
  if (!id && /^(verify|verify me|verify id|kyc|id check)[.!]*$/.test(lower)) {
    await wa.ctaUrl(to, "Verify your ID on Kendibo's secure page. It takes about a minute. Never send your NIN or BVN in this chat.", 'Verify my ID', idCheckLink(to, user.id));
    return;
  }
  // Receipts and invoices: resend the newest one (WhatsApp link + verified email).
  if (!id && /^\/?(invoice|invoices|receipt|receipts|my receipt|my invoice)[.!]*$/.test(lower)) {
    const { latestInvoiceFor, sendInvoice } = await import('../invoices/invoice.service.js');
    const latest = await latestInvoiceFor(user.id);
    if (!latest || !(await sendInvoice(latest.bookingId))) await sendMenu(to, "You don't have a receipt yet. You'll get one here as soon as you pay for a job.");
    return;
  }
  // The pro asked for a new time: the customer accepts or keeps the old one.
  const sched = /^sched:(accept|decline):([0-9a-f-]{36})$/i.exec(id);
  if (sched) {
    const { answerScheduleChange } = await import('../job-engine/schedule-updates.js');
    const out = await answerScheduleChange(sched[2], user.id, sched[1].toLowerCase() === 'accept');
    if (out === 'gone') await sendMenu(to, 'That time change was already answered or replaced.');
    return;
  }

  // Human hand-off: the team owns the chat while the customer keeps talking
  // (12h of quiet hands it back) or until they type "bot".
  if (s.state === 'HUMAN') {
    if (Date.now() - s.updatedAt < HUMAN_MODE_MS && !['bot', 'menu'].includes(lower)) {
      await q(`UPDATE messaging.whatsapp_session SET updated_at=now() WHERE wa_id=$1`, [to]).catch(() => undefined);
      return; // the message is already in the support inbox
    }
    s.state = 'BOT';
  }

  // A draft untouched for two days starts over instead of resuming a stale job.
  await q(`UPDATE messaging.whatsapp_job_draft SET status='abandoned' WHERE wa_id=$1 AND status='collecting' AND updated_at < $2`,
    [to, new Date(Date.now() - DRAFT_STALE_MS).toISOString()]).catch(() => undefined);
  let draft = await currentDraft(to);
  if (!draft) s.data = { lang: s.data.lang };

  // ── Masked client ↔ vendor chat: words and uploads pass straight through ────
  const relay = id ? null : await activeRelay(to);
  if (relay && !['menu', 'agent', 'bot', 'help'].includes(lower)) {
    if (lower === 'end') {
      await closeRelay(relay.id);
      await sendMenu(to, 'Chat closed. Your booking stays active in Kendibo.');
      return;
    }
    const up = await saveUpload(m);
    if (up?.url) await relayMedia(relay, up.kind, up.url, text || undefined);
    else if (text) await relayText(relay, text);
    return;
  }

  // ── Taps ──────────────────────────────────────────────────────────────────
  if (id && !id.startsWith('ai:')) {
    try {
      if (id === 'menu:book') {
        await sendStep(to, draft ?? (await openDraft(to, user.id)), s.data);
      } else if (id === 'menu:bookings') {
        await sendStatus(to, user.id, draft);
      } else if (id === 'menu:help') {
        await handOff(s, user.id, to, 'asked for a person from the menu');
      } else if (id === 'flow:resume') {
        if (draft) await sendStep(to, draft, s.data); else await sendMenu(to);
      } else if (id === 'cancel:confirm') {
        if (draft && s.data.cancelDraftId === draft.id) {
          await cancelDraft(draft.id);
          s.data = { lang: s.data.lang };
          await sendMenu(to, 'Cancelled. Nothing was sent to vendors.');
        } else await sendMenu(to, 'That cancellation confirmation has expired.');
      } else if (id === 'cancel:keep') {
        delete s.data.cancelDraftId;
        if (draft) await sendStep(to, draft, s.data, 'Your request is still in progress.');
        else await sendMenu(to);
      } else if (id === 'flow:confirm' && !draft) {
        await sendMenu(to, 'That request has already been sent. Want to do something else?');
      } else if (id.startsWith('flow:') || id.startsWith('cat:')) {
        draft ??= await openDraft(to, user.id);
        const r = await handleFlowTap(id, { waId: to, userId: user.id, d: draft, a: s.data });
        s.data = r.a;
        if (!r.sent) await sendStep(to, r.d, s.data);
      } else {
        await sendMenu(to);
      }
    } catch (e) {
      if ((e as Error).message !== 'DRAFT_INCOMPLETE' || !draft) throw e;
      await sendStep(to, draft, s.data, 'A few details are still missing.');
    }
    await saveSession(s);
    return;
  }

  // ── Shared location ─────────────────────────────────────────────────────────
  if (m.type === 'location' && m.location) {
    await useLocation(to, s, user.id, { lat: m.location.latitude, lng: m.location.longitude, address: m.location.address || m.location.name || 'Shared location' });
    await saveSession(s);
    return;
  }

  // ── Photo, voice note, video or document (a caption is read as text below) ──
  const images: { mime: string; base64: string }[] = [];
  const upload = await saveUpload(m);
  if (upload) {
    if (upload.assetId) {
      draft = await addPhotoToDraft(to, user.id, upload.assetId);
      if (upload.kind === 'image' && upload.bytes) images.push({ mime: upload.mime, base64: upload.bytes.toString('base64') });
    }
    if (!text) {
      const d = draft ?? (await openDraft(to, user.id));
      const noun = { image: 'Photo', audio: 'Voice note', video: 'Video', document: 'Document' }[upload.kind];
      await sendStep(to, d, s.data, upload.assetId ? `${noun} added.` : `I couldn't save that ${noun.toLowerCase()}. You can send it again (up to 16 MB), or carry on without it.`);
      await saveSession(s);
      return;
    }
  }

  // ── Arrived from a vendor's storefront ("Connect on WhatsApp", ref KB-<slug>) ──
  const ref = text.match(/\bKB-([a-z0-9][a-z0-9-]{1,60})\b/i);
  if (ref) {
    const { storefrontService } = await import('../storefront/storefront.service.js');
    const sf = await storefrontService.bySlug(ref[1].toLowerCase()).catch(() => null);
    if (sf) {
      const d = draft ?? (await openDraft(to, user.id));
      await patchDraft(d.id, { preferred_provider_id: sf.id });
      await sendStep(to, { ...d, preferred_provider_id: sf.id }, s.data,
        `${firstContact ? `${DISCLOSURE}\n\n` : ''}You're requesting ${sf.name} through Kendibo. Tell me what you need.`);
      await saveSession(s);
      return;
    }
  }

  if (!text) {
    if (draft) await sendStep(to, draft, s.data); else await sendMenu(to);
    await saveSession(s);
    return;
  }

  // ── Text ──────────────────────────────────────────────────────────────────
  const step: Step | null = draft ? nextStep(draft, s.data) : null;
  const u = await understand(text, { expectingBudget: step === 'budget' });
  // An uncertain status prediction must not swallow a customer's description
  // while we're asking what needs fixing. Keep explicit status requests usable.
  if (draft && step === 'need' && u.intent === 'status' && !u.sure && !/\b(bookings?|orders?|requests?|jobs?|vendor|technician|appointment|status|update|history)\b/i.test(text)) {
    u.intent = 'details';
  }
  s.data.lang = u.language === 'pcm' ? 'pcm' : (s.data.lang ?? 'en');
  let route = 'flow';
  const lead = (x: string) => (firstContact ? `${DISCLOSURE}\n\n${x}`.trim() : x);

  if (u.intent === 'human') {
    route = 'human';
    await handOff(s, user.id, to, text);
  } else if (u.intent === 'out_of_scope' && u.sure) {
    // Meta's terms bar general-purpose AI assistants: decline, with no LLM call.
    route = 'refuse';
    const no = 'I can only help with Kendibo home services: booking a job, your bookings, payments and support.';
    if (draft) await sendStep(to, draft, s.data, lead(no)); else await sendMenu(to, lead(no));
  } else if (u.intent === 'greeting') {
    route = 'menu';
    if (firstContact && !draft) await sendWelcome(to, profileName);
    else if (draft) await sendStep(to, draft, s.data, lead("Welcome back. Let's finish your request."));
    else await sendMenu(to, `${firstName(profileName) ? `Hi ${firstName(profileName)}! ` : 'Hi! '}What would you like to do?`);
  } else if (u.intent === 'status') {
    route = 'facts';
    await sendStatus(to, user.id, draft);
  } else if (u.intent === 'cancel') {
    if (draft) {
      s.data.cancelDraftId = draft.id;
      await wa.buttons(to, 'Would you like to cancel your request in progress?', [
        { id: 'cancel:confirm', title: 'Yes, cancel' },
        { id: 'cancel:keep', title: 'Keep request' },
      ]);
    } else {
      await sendMenu(to, 'To cancel a booking that is already confirmed, open the Kendibo app and go to Bookings, or type "agent" and we\'ll do it for you.');
    }
  } else if (['payment', 'pricing', 'coverage', 'trust', 'vendor_join'].includes(u.intent) && u.sure) {
    route = 'facts';
    const answer = lead(await factAnswer(u, text, draft));
    if (draft) await sendStep(to, draft, s.data, `${answer}\n\nBack to your request:`);
    else await sendMenu(to, answer);
  } else if (u.intent === 'thanks' && u.sure) {
    route = 'menu';
    if (draft) await sendStep(to, draft, s.data, "You're welcome."); else await wa.text(to, 'You\'re welcome! Reply "menu" any time.');
  } else if (draft && step === 'confirm' && u.intent === 'affirm') {
    const out = await submitDraft(to, user.id, draft);
    if (!out.needsVerification) s.data = { lang: s.data.lang };
  } else if (draft && (step === 'photo' || step === 'budget') && u.intent === 'deny' && !u.budgetKobo) {
    if (step === 'photo') s.data.photo = true; else s.data.budget = true;
    await sendStep(to, draft, s.data);
  } else if (draft && step === 'location' && text.length >= 6 && !u.when.date && !u.budgetKobo && ['details', 'book', 'affirm', 'deny', 'out_of_scope'].includes(u.intent)) {
    // A typed address: geocode it, then the same coverage check as a pin.
    const { maps } = await import('../geo/maps.port.js');
    const city = (process.env.GEOLOCK_CITY ?? 'uyo').split(',')[0].trim() || 'uyo';
    const g = await maps.geocode(text, city).catch(() => null);
    if (g) await useLocation(to, s, user.id, { lat: g.lat, lng: g.lng, address: (g.formatted || text).slice(0, 160) });
    else { route = 'clarify'; await sendStep(to, draft, s.data, "I couldn't find that address. Add the area and a landmark, or tap the button to pin it on the map."); }
  } else {
    const patch = await patchFromUnderstanding(draft ?? EMPTY_DRAFT, u, text, step ?? 'need');
    if (Object.keys(patch).length || (u.intent === 'book' && u.sure)) {
      const d = draft ?? (await openDraft(to, user.id));
      await patchDraft(d.id, patch);
      if (patch.scheduled_date) s.data.dayPick = false;
      await sendStep(to, { ...d, ...patch } as Draft, s.data, lead(await acknowledge(patch)));
    } else if (await tryAgent(to, s, user.id, text, u, step, images)) {
      await logTurn(to, text, u, 'llm', step);
      return; // the agent replied and may have changed the session (hand-off)
    } else {
      route = 'clarify';
      const sorry = "Sorry, I didn't catch that.";
      if (draft) await sendStep(to, draft, s.data, sorry);
      else await sendMenu(to, lead(`${sorry} I can book a home-service pro, check your bookings, or get you a person.`));
    }
  }
  await logTurn(to, text, u, route, step);
  await saveSession(s);
}

/**
 * Where the template's "Pay securely" button goes: a fresh (idempotent) Bachs
 * checkout for this customer's own booking, or null if it is not payable.
 */
export async function payLinkTarget(waId: string, bookingId: string): Promise<{ url: string } | { done: string }> {
  const b = await q<{ user_id: string; status: string; price_kobo: string | null }>(
    `SELECT b.user_id, b.status, b.price_kobo FROM booking.booking b JOIN identity.users u ON u.id = b.user_id WHERE b.id=$1 AND u.phone=$2`, [bookingId, e164(waId)],
  ).catch(() => []);
  if (!b[0]) return { done: 'This payment link is not valid for this number.' };
  if (!['REQUESTED', 'PAYMENT_PENDING'].includes(String(b[0].status).toUpperCase())) return { done: 'This booking is already paid or no longer needs payment.' };
  const paid = await q(`SELECT 1 FROM payment.payment WHERE booking_id=$1 AND status='successful' LIMIT 1`, [bookingId]).catch(() => []);
  if (paid[0]) return { done: 'This booking is already paid. Thank you! We will keep you posted here.' };
  const amount = BigInt(String(b[0].price_kobo ?? '0').split('.')[0] || '0');
  if (!deps || amount <= 0n) return { done: 'Open the Kendibo app to pay for this booking.' };
  const email = await q<{ email: string | null }>(`SELECT email FROM identity.users WHERE id=$1`, [b[0].user_id]);
  const session = await deps.createCheckout({
    bookingId, amountKobo: amount, ...(email[0]?.email ? { customerEmail: email[0].email } : {}),
    reference: `bk_${bookingId}_wa`, idempotencyKey: `wa_accept_${bookingId}`,
  });
  return session.checkoutUrl ? { url: session.checkoutUrl } : { done: 'Open the Kendibo app to pay for this booking.' };
}

// ── Onboarding (after consent) ─────────────────────────────────────────────
// Number = account (created on first message). Here we add a name and an email
// the person has confirmed, without slowing the booking down.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** One welcome text message per number, by SMS so it lands even off WhatsApp. */
async function sendWelcomeSms(to: string, userId: string, name?: string): Promise<void> {
  const first = await q<{ id: string }>(`UPDATE identity.users SET welcome_sent_at=now() WHERE id=$1 AND welcome_sent_at IS NULL RETURNING id`, [userId]).catch(() => []);
  if (!first[0]) return;
  const app = (process.env.APP_URL || 'https://kendibo-app.pxxl.click').replace(/\/+$/, '');
  const hi = firstName(name) ? `Welcome to Kendibo, ${firstName(name)}!` : 'Welcome to Kendibo!';
  try {
    const { sms } = await import('../notifications/channels.js');
    await sms.send(`+${to.replace(/\D/g, '')}`, `${hi} Book ID-checked pros on WhatsApp any time, or in the app: ${app} . Kendibo will never ask for your PIN or OTP.`, { type: 'transactional' });
  } catch (e) { observability.captureException(e); }
}

async function askName(to: string, s: Session, profileName?: string): Promise<void> {
  if (firstName(profileName)) {
    s.data.onboard = 'name';
    await wa.buttons(to, `Thanks! Shall I call you ${firstName(profileName)}?`, [
      { id: 'onb:name:yes', title: "Yes, that's me" },
      { id: 'onb:name:change', title: 'Use another name' },
    ]);
  } else {
    s.data.onboard = 'name_text';
    await wa.text(to, "Thanks! What's your name?");
  }
}

async function askEmail(to: string, s: Session, userId: string): Promise<boolean> {
  const has = await q<{ email: string | null }>(`SELECT email FROM identity.users WHERE id=$1`, [userId]).catch(() => []);
  if (has[0]?.email) return true; // already have it (e.g. signed up in the app)
  s.data.onboard = 'email';
  await wa.buttons(to, "What's your email? We send receipts there, and you can use it to sign in to the Kendibo app.", [{ id: 'onb:email:skip', title: 'Skip for now' }]);
  return false;
}

/** Returns true when onboarding is finished (caller resumes the first request). */
async function handleOnboarding(to: string, s: Session, userId: string, text: string, id: string, profileName?: string): Promise<boolean> {
  const step = s.data.onboard;
  if (step === 'name') {
    if (id === 'onb:name:change') { s.data.onboard = 'name_text'; await wa.text(to, 'Type the name you would like us to use.'); return false; }
    const name = id === 'onb:name:yes' ? (profileName ?? '').trim() : text.trim();
    if (name.length >= 2) await q(`UPDATE identity.users SET name=$2, updated_at=now() WHERE id=$1`, [userId, name.slice(0, 80)]);
    if (await askEmail(to, s, userId)) { delete s.data.onboard; return true; }
    return false;
  }
  if (step === 'name_text') {
    const name = text.trim();
    if (name.length < 2 || name.length > 80 || /\d{4,}/.test(name)) { await wa.text(to, 'Please type your name (just your name is fine).'); return false; }
    await q(`UPDATE identity.users SET name=$2, updated_at=now() WHERE id=$1`, [userId, name]);
    if (await askEmail(to, s, userId)) { delete s.data.onboard; return true; }
    return false;
  }
  // step === 'email'
  if (id === 'onb:email:skip') {
    delete s.data.onboard;
    await wa.text(to, 'No problem. You can add it later in the app.');
    return true;
  }
  const email = text.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) { await wa.buttons(to, "That doesn't look like an email. Type it again, or tap Skip.", [{ id: 'onb:email:skip', title: 'Skip for now' }]); return false; }
  const taken = await q(`SELECT 1 FROM identity.users WHERE lower(email)=$1 AND id<>$2`, [email, userId]).catch(() => []);
  delete s.data.onboard;
  if (taken[0]) {
    await wa.text(to, 'That email is already on another Kendibo account, so we have not added it here. You can sign in with it in the app.');
    return true;
  }
  await q(`UPDATE identity.users SET email_pending=$2 WHERE id=$1`, [userId, email]);
  const nameRow = await q<{ name: string | null }>(`SELECT name FROM identity.users WHERE id=$1`, [userId]).catch(() => []);
  try {
    const [{ email: mailer }, { templates }] = await Promise.all([import('../notifications/channels.js'), import('../notifications/mail.templates.js')]);
    const mail = templates.confirmEmail({ name: nameRow[0]?.name ?? undefined, link: emailConfirmLink(to, userId) }, { recipientEmail: email });
    await mailer.send(email, 'Confirm your email for Kendibo', mail.html);
    await wa.text(to, `I've sent a link to ${email}. Tap it to confirm. Meanwhile, let's get your job sorted.`);
  } catch (e) {
    observability.captureException(e);
    await wa.text(to, "I couldn't send the confirmation email just now. You can add it later in the app.");
  }
  return true;
}

/** The email link was opened: attach the confirmed email and say so in the chat. */
export async function confirmPendingEmail(waId: string, userId: string): Promise<'confirmed' | 'taken' | 'none'> {
  const r = await q<{ email_pending: string | null }>(`SELECT email_pending FROM identity.users WHERE id=$1`, [userId]).catch(() => []);
  const email = r[0]?.email_pending;
  if (!email) return 'none';
  const taken = await q(`SELECT 1 FROM identity.users WHERE lower(email)=$1 AND id<>$2`, [email, userId]).catch(() => []);
  if (taken[0]) { await q(`UPDATE identity.users SET email_pending=NULL WHERE id=$1`, [userId]); return 'taken'; }
  await q(`UPDATE identity.users SET email=$2, email_verified_at=now(), email_pending=NULL, updated_at=now() WHERE id=$1`, [userId, email]);
  emit('whatsapp.email_confirmed', { userId });
  await notifyCustomer(waId, `Email confirmed: ${email}. Your receipts will go there, and you can use it to sign in to the app.`).catch(() => undefined);
  return 'confirmed';
}

/** PAY: the latest booking still waiting for payment gets a fresh pay button. */
async function sendPayButton(to: string, userId: string): Promise<void> {
  const b = await q<{ id: string; price_kobo: string | null }>(
    `SELECT b.id, b.price_kobo FROM booking.booking b
      WHERE b.user_id=$1 AND upper(b.status) IN ('REQUESTED','PAYMENT_PENDING')
        AND NOT EXISTS (SELECT 1 FROM payment.payment p WHERE p.booking_id=b.id AND p.status='successful')
      ORDER BY b.created_at DESC LIMIT 1`, [userId],
  ).catch(() => []);
  if (!b[0]) { await sendMenu(to, "You don't have anything to pay right now. When a pro accepts a job, the pay button comes here."); return; }
  const amount = String(b[0].price_kobo ?? '0').split('.')[0] || '0';
  const url = `${webBase()}/w/pay?t=${encodeURIComponent(payToken(to, String(b[0].id)))}`;
  await wa.ctaUrl(to, Number(amount) > 0 ? `Pay ${naira(amount)} to confirm your booking. Kendibo holds it until the job is done.` : 'Confirm and pay for your booking.', 'Pay securely', url);
}

/** The ID-check page finished: tell the customer and pick their request back up. */
export async function continueAfterVerification(waId: string, status: string): Promise<void> {
  await runSerially(waId, async () => {
    if (status === 'VERIFIED') {
      const d = await currentDraft(waId);
      if (d) {
        const s = await loadSession(waId);
        await sendStep(waId, d, s.data, "You're verified.");
      } else {
        await notifyCustomer(waId, "You're verified. Thanks! Reply MENU when you're ready to book.");
      }
    } else if (status === 'REJECTED') {
      await notifyCustomer(waId, "We couldn't verify that NIN. Check the number and reply VERIFY to try again, or AGENT for a person.");
    } else {
      await notifyCustomer(waId, "Thanks, we're confirming your details and will message you here as soon as it's done.");
    }
  });
}

/** The map page saved a pin: carry on in WhatsApp without waiting for the customer. */
export async function continueAfterLocation(waId: string): Promise<void> {
  await runSerially(waId, async () => {
    const s = await loadSession(waId);
    const d = await currentDraft(waId);
    if (!d) return;
    await sendStep(waId, d, s.data, `Location saved${d.address_text ? `: ${d.address_text}` : ''}.`);
  });
}

// ── Crash recovery ──────────────────────────────────────────────────────────
// A turn the process died in the middle of (started, never processed) is
// retried once, ten minutes later. Messages older than six hours are left
// alone: a reply that late would only confuse.
let sweeper: NodeJS.Timeout | null = null;
export function startInboundSweeper(everyMs = 60_000) {
  if (sweeper) return;
  sweeper = setInterval(() => { void sweepInbound().catch((e) => observability.captureException(e)); }, everyMs);
  sweeper.unref?.();
}
const PAYLOAD_RETENTION_MS = 7 * 86_400_000;
let lastPurge = 0;
/** Raw message bodies are only kept for crash retries; drop them after a week (the row and timestamp stay). */
export async function purgeInboundPayloads(now = Date.now()): Promise<void> {
  await q(`UPDATE messaging.whatsapp_inbound SET payload = NULL, profile_name = NULL WHERE payload IS NOT NULL AND received_at < $1`,
    [new Date(now - PAYLOAD_RETENTION_MS).toISOString()]);
}
export async function sweepInbound(now = Date.now()): Promise<number> {
  if (now - lastPurge > 3600_000) { lastPurge = now; await purgeInboundPayloads(now).catch((e) => observability.captureException(e)); }
  const rows = await q<{ message_id: string; payload: unknown; profile_name: string | null }>(
    `SELECT message_id, payload, profile_name FROM messaging.whatsapp_inbound
      WHERE processed_at IS NULL AND payload IS NOT NULL AND attempts < 2 AND received_at > $1
        AND received_at < $2 AND (started_at IS NULL OR started_at < $2)
      ORDER BY received_at LIMIT 20`,
    [new Date(now - 6 * 3600_000).toISOString(), new Date(now - RETRY_AFTER_MS).toISOString()],
  ).catch(() => []);
  for (const r of rows) {
    const m = (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as InboundMessage;
    await runSerially(m.from, () => processAndMark(m, r.profile_name ?? undefined));
  }
  return rows.length;
}

/**
 * A vendor accepted a request that came in over WhatsApp: tell the customer,
 * and send the secure Bachs checkout link when the job has a fixed price.
 * Quote-first jobs get a "they'll inspect and quote" note instead.
 */
export async function notifyRequestAccepted(requestId: string, bookingId: string | null): Promise<void> {
  const rows = await q<{ source: string; contact_phone: string | null; user_id: string; title: string }>(
    `SELECT source, contact_phone, user_id, title FROM booking.service_request WHERE id=$1`, [requestId],
  );
  const r = rows[0];
  if (!r || r.source !== 'whatsapp' || !r.contact_phone) return;
  const to = String(r.contact_phone).replace(/\D/g, '');
  const vendor = await q<{ name: string | null }>(
    `SELECT p.business_name AS name FROM booking.request_offer o JOIN provider.provider p ON p.id=o.provider_id WHERE o.request_id=$1 AND o.status='accepted' LIMIT 1`, [requestId],
  );
  const who = vendor[0]?.name ? String(vendor[0].name) : 'A verified vendor';
  if (!bookingId) {
    await notifyCustomer(to, `${who} accepted your job. They'll inspect first and send a quote here for you to approve. You only pay after you accept it.`);
    return;
  }
  const b = await q<{ price_kobo: string | null; total_kobo: string | null }>(`SELECT * FROM booking.booking WHERE id=$1`, [bookingId]).catch(() => []);
  const amount = BigInt(String(b[0]?.price_kobo ?? b[0]?.total_kobo ?? '0').split('.')[0] || '0');
  const email = await q<{ email: string | null }>(`SELECT email FROM identity.users WHERE id=$1`, [r.user_id]);
  if (!deps || amount <= 0n) {
    await notifyCustomer(to, `${who} accepted your job. Open the Kendibo app to confirm and pay.`);
    return;
  }
  const session = await deps.createCheckout({
    bookingId, amountKobo: amount, ...(email[0]?.email ? { customerEmail: email[0].email } : {}),
    reference: `bk_${bookingId}_wa`, idempotencyKey: `wa_accept_${bookingId}`,
  });
  if (!session.checkoutUrl) {
    await notifyCustomer(to, `${who} accepted your job. Open the Kendibo app to confirm and pay.`);
    return;
  }
  const checkoutUrl = session.checkoutUrl;
  const line = `${who} accepted your job. Pay ${naira(amount)} to confirm.`;
  await sendBusinessInitiated({
    waId: to,
    whatsapp: () => wa.ctaUrl(to, line, 'Pay securely', checkoutUrl),
    template: { key: 'request_update', params: [`${line} ${checkoutUrl}`] },
    sms: `${line} ${checkoutUrl}`,
  });
}
