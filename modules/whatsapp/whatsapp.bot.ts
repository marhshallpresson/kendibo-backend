// WhatsApp booking assistant — the second front door next to the app.
//
// Customer path (all server-authoritative, same rules as the app):
//   MENU → pick trade → pick service → share location → pick day + window →
//   confirm (price from the pricing engine, or "get quotes" for quote-only work)
//   → secure Bachs checkout link. Payment is confirmed by the
//   PSP webhook, never by anything typed in the chat.
// Vendor path: offer notifications carry Accept / Decline buttons; the tap is
//   matched to the vendor who owns the WhatsApp number and re-checked against
//   category rules before it counts.
//
// Identity: Meta verifies the sender's phone number, so wa_id links to the
// account with that number (or creates a CUSTOMER account). Money and personal
// data never travel through message text beyond what the user typed.
import { q } from '../../packages/database/db.js';
import { emit } from '../../packages/observability/emit.js';
import { observability } from '../../packages/observability/watchup.adapter.js';
import { wa } from './whatsapp.client.js';

type State = 'MENU' | 'HUMAN' | 'PICK_CATEGORY' | 'PICK_SERVICE' | 'ASK_LOCATION' | 'ASK_DAY' | 'ASK_WINDOW' | 'CONFIRM';
interface Session { waId: string; userId: string | null; state: State; data: Record<string, unknown>; updatedAt: number }

export interface InboundMessage {
  id: string; from: string; type: string;
  text?: { body?: string };
  interactive?: { button_reply?: { id: string; title: string }; list_reply?: { id: string; title: string } };
  button?: { payload?: string; text?: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  image?: { id: string; mime_type?: string; caption?: string };
}

interface Deps {
  createCheckout: (input: { bookingId: string; amountKobo: bigint; customerEmail: string; reference: string; idempotencyKey: string }) => Promise<{ checkoutUrl?: string | null; psp?: string }>;
}
let deps: Deps | null = null;
export function configureWhatsappBot(d: Deps) { deps = d; }

const SESSION_TTL_MS = 30 * 60_000;
const WINDOWS: Record<string, string> = { morning: '08:00-12:00', afternoon: '12:00-16:00', evening: '16:00-19:00' };
const naira = (kobo: bigint | string | number) => `₦${(Number(kobo) / 100).toLocaleString('en-NG', { maximumFractionDigits: 0 })}`;
const e164 = (waId: string) => `+${waId.replace(/\D/g, '')}`;

async function loadSession(waId: string): Promise<Session> {
  const rows = await q<Record<string, unknown>>(`SELECT * FROM messaging.whatsapp_session WHERE wa_id=$1`, [waId]);
  const r = rows[0];
  if (!r) return { waId, userId: null, state: 'MENU', data: {}, updatedAt: 0 };
  const s: Session = { waId, userId: r.user_id ? String(r.user_id) : null, state: String(r.state) as State, data: (r.data ?? {}) as Record<string, unknown>, updatedAt: new Date(String(r.updated_at)).getTime() };
  if (Date.now() - s.updatedAt > SESSION_TTL_MS) { s.state = 'MENU'; s.data = {}; }
  return s;
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

function replyId(m: InboundMessage): string {
  return m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id ?? m.button?.payload ?? '';
}
function replyText(m: InboundMessage): string {
  return (m.text?.body ?? m.image?.caption ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? m.button?.text ?? '').trim();
}

async function sendMenu(to: string, name?: string) {
  await wa.buttons(to, `${name ? `Hi ${name.split(' ')[0]}, ` : 'Hi, '}this is Kendibo. Verified cleaners, electricians, plumbers and more, booked and paid safely. What would you like to do?`, [
    { id: 'menu:book', title: 'Book a service' },
    { id: 'menu:bookings', title: 'My bookings' },
    { id: 'menu:help', title: 'Talk to a person' },
  ]);
}

async function sendCategories(to: string) {
  const cats = await q<{ id: string; name: string; description: string | null }>(
    `SELECT id, name, description FROM catalog.category WHERE active ORDER BY sort_order LIMIT 10`,
  );
  await wa.list(to, 'Which kind of job is it?', 'Choose a service', cats.map((c) => ({ id: `cat:${c.id}`, title: String(c.name), description: c.description ? String(c.description) : undefined })));
}

/** Vendor tapped Accept/Decline on an offer notification. */
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
      await wa.text(waId, 'You can\'t accept jobs in this trade yet. Open the Kendibo app to finish your verification.');
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

export async function notifyProviderOfOffer(providerPhone: string, offerId: string, summary: string) {
  await wa.buttons(providerPhone.replace(/^\+/, ''), `New job near you: ${summary}`, [
    { id: `offer:${offerId}:accept`, title: 'Accept' },
    { id: `offer:${offerId}:decline`, title: 'Decline' },
  ]).catch((e) => observability.captureException(e));
}

export async function handleInbound(m: InboundMessage, profileName?: string): Promise<void> {
  // At-least-once delivery: the message id is the idempotency key.
  try { await q(`INSERT INTO messaging.whatsapp_inbound (message_id, wa_id) VALUES ($1,$2)`, [m.id, m.from]); }
  catch { return; }
  void wa.markRead(m.id);

  const to = m.from;
  const id = replyId(m);
  const text = replyText(m);
  const lower = text.toLowerCase();

  const offerTap = id.match(/^offer:([0-9a-f-]{36}):(accept|decline)$/i);
  if (offerTap) return handleOfferTap(to, offerTap[1], offerTap[2] === 'accept');

  const s = await loadSession(to);
  const user = await userFor(to, profileName);
  s.userId = user.id;

  // Marketing opt-out (Meta policy, NDPA 2023): STOP turns promotions off on every
  // channel; START turns them back on for someone who opted out. Booking updates
  // still go out, because the customer asked for those.
  if (!id && /^(stop|unsubscribe|stop promos?|stop promotions?)$/.test(lower)) {
    const { notificationService } = await import('../notifications/notification.service.js');
    await notificationService.updateUserPreferences(user.id, { promo: false });
    emit('whatsapp.opt_out', { userId: user.id });
    s.state = 'MENU'; s.data = {};
    await saveSession(s);
    await wa.text(to, "Done. You won't get offers or promotions from Kendibo. You'll still get messages about your own bookings. Reply START to get offers again.");
    return;
  }
  if (!id && lower === 'start') {
    const { notificationService } = await import('../notifications/notification.service.js');
    if (!(await notificationService.getUserPreferences(user.id)).promo) {
      await notificationService.updateUserPreferences(user.id, { promo: true });
      emit('whatsapp.opt_in', { userId: user.id });
      await wa.text(to, "You're back on Kendibo offers. Reply STOP any time to opt out.");
      return;
    }
  }

  // ── AI agent path ────────────────────────────────────────────────────────
  const { aiConfigured, runAgent, addPhotoToDraft } = await import('./agent.js');
  if (aiConfigured()) {
    // Abuse / cost guard: at most 40 inbound messages per number per hour.
    const recent = await q<{ n: string }>(
      `SELECT COUNT(*) AS n FROM messaging.whatsapp_inbound WHERE wa_id=$1 AND received_at > $2`, [to, new Date(Date.now() - 3600_000).toISOString()],
    ).catch(() => [{ n: '0' }]);
    if (Number(recent[0]?.n ?? 0) > 40) return;

    // Human hand-off: the team owns the chat until it goes quiet for 12h or the customer types "bot".
    if (s.state === ('HUMAN' as State) && Date.now() - s.updatedAt < 12 * 3600_000 && lower !== 'bot') {
      const { supportService } = await import('../warranties/warranty.service.js');
      void supportService; // messages are visible to agents in the support inbox via whatsapp_turn
      await q(`INSERT INTO messaging.whatsapp_turn (wa_id, role, content) VALUES ($1,'user',$2)`, [to, text.slice(0, 2000) || `(${m.type})`]).catch(() => undefined);
      return;
    }

    const images: { mime: string; base64: string }[] = [];
    if (m.type === 'image' && (m as { image?: { id?: string } }).image?.id) {
      const media = await wa.downloadMedia(String((m as { image?: { id?: string } }).image!.id)).catch(() => null);
      if (media) {
        const { mediaService } = await import('../media/media.service.js');
        const { assetId } = await mediaService.presign('photo');
        const done = await mediaService.ingest(assetId, media.bytes, media.mime).catch(() => null);
        if (done && (done as { status?: string }).status === 'clean') {
          await addPhotoToDraft(to, user.id, assetId);
          images.push({ mime: media.mime, base64: media.bytes.toString('base64') });
        }
      }
    }

    let event: string | undefined;
    if (m.type === 'location' && m.location) {
      // Shared WhatsApp location is an alternative to the map page.
      const { geoService } = await import('../geo/geo.service.js');
      const zone = await geoService.checkZone(m.location.latitude, m.location.longitude);
      const rows = await q<{ id: string }>(`SELECT id FROM messaging.whatsapp_job_draft WHERE wa_id=$1 AND status='collecting' ORDER BY created_at DESC LIMIT 1`, [to]);
      if (rows[0] && zone.serviceable) {
        const { saveDraftLocation } = await import('./agent.js');
        await saveDraftLocation(to, String(rows[0].id), { lat: m.location.latitude, lng: m.location.longitude, address: m.location.address || m.location.name || 'Shared location' });
        event = 'location_saved (shared from WhatsApp)';
      } else {
        event = zone.serviceable ? 'location shared but no open job draft' : 'location_outside_coverage';
      }
    }

    // First contact: a fixed, fast welcome with the format we need.
    const seen = await q(`SELECT 1 FROM messaging.whatsapp_turn WHERE wa_id=$1 LIMIT 1`, [to]).catch(() => []);
    if (!seen[0] && !id && ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening', 'start', 'menu', ''].includes(lower)) {
      await wa.buttons(to, `${profileName ? `Hi ${profileName.split(' ')[0]}! ` : 'Hi! '}I'm Kendibo's assistant. Tell me what needs fixing or cleaning, and if you can:\n\n1. Send a photo of the problem\n2. Your budget (optional)\n3. When you want it done\n\nI'll find verified vendors near you.`, [
        { id: 'menu:book', title: 'Book a service' }, { id: 'menu:bookings', title: 'My bookings' }, { id: 'menu:help', title: 'Talk to a person' },
      ]);
      await q(`INSERT INTO messaging.whatsapp_turn (wa_id, role, content) VALUES ($1,'user',$2), ($1,'assistant','(welcome with format + menu buttons)')`, [to, text || 'hi']).catch(() => undefined);
      await saveSession(s);
      return;
    }

    const asText = id === 'menu:book' ? 'I want to book a service'
      : id === 'menu:bookings' ? 'Show my bookings'
        : id === 'menu:help' ? 'I want to talk to a person'
          : text;
    // Persist BEFORE the agent runs: talk_to_human flips the stored state to
    // HUMAN mid-turn, and saving afterwards would overwrite it.
    if (lower === 'bot' || s.state === ('HUMAN' as State)) s.state = 'MENU';
    await saveSession(s);
    const ok = await runAgent({ waId: to, userId: user.id, text: asText, images, event });
    if (ok) return;
    // AI failed (outage/timeout): fall through to the deterministic menu flow.
  }

  if (!id && ['hi', 'hello', 'menu', 'start', 'restart', 'cancel'].includes(lower)) {
    s.state = 'MENU'; s.data = {};
    await saveSession(s);
    return sendMenu(to, profileName);
  }

  try {
    switch (true) {
      case id === 'menu:book': {
        s.state = 'PICK_CATEGORY'; s.data = {};
        await sendCategories(to);
        break;
      }
      case id === 'menu:bookings': {
        const rows = await q<{ id: string; status: string; service_id: string; scheduled_at: string | null }>(
          `SELECT id, status, service_id, scheduled_at FROM booking.booking WHERE user_id=$1 ORDER BY created_at DESC LIMIT 3`, [user.id],
        );
        await wa.text(to, rows.length
          ? rows.map((b) => `• ${String(b.service_id)} — ${String(b.status).replace(/_/g, ' ').toLowerCase()}${b.scheduled_at ? `, ${new Date(String(b.scheduled_at)).toDateString()}` : ''}`).join('\n')
          : 'You have no bookings yet. Reply "menu" to book one.');
        break;
      }
      case id === 'menu:help': {
        const { supportService } = await import('../warranties/warranty.service.js');
        await supportService.open(user.id, 'whatsapp_handoff');
        await wa.text(to, 'Thanks — someone from the Kendibo team will reply here shortly (8am–8pm daily).');
        s.state = 'MENU';
        break;
      }
      case id.startsWith('cat:'): {
        const categoryId = id.slice(4);
        const svcs = await q<{ id: string; name: string; base_price_kobo: string; booking_type: string }>(
          `SELECT id, name, base_price_kobo, booking_type FROM catalog.service WHERE category_id=$1 AND active ORDER BY name LIMIT 10`, [categoryId],
        );
        s.data = { categoryId };
        if (!svcs.length) {
          s.data.quoteOnly = true; s.state = 'ASK_LOCATION';
          await wa.locationRequest(to, 'We\'ll get you quotes from verified pros. Where is the job? Share your location, or type the address.');
          break;
        }
        s.state = 'PICK_SERVICE';
        await wa.list(to, 'Pick the closest match. You can add details later.', 'Choose', svcs.map((v) => ({
          id: `svc:${v.id}`, title: String(v.name),
          description: String(v.booking_type) === 'quote' ? 'Priced after inspection' : `From ${naira(v.base_price_kobo)}`,
        })));
        break;
      }
      case id.startsWith('svc:'): {
        s.data.serviceId = id.slice(4);
        s.state = 'ASK_LOCATION';
        await wa.locationRequest(to, 'Where is the job? Tap "Send location", or type the address with a landmark.');
        break;
      }
      case s.state === 'ASK_LOCATION' && (m.type === 'location' || text.length >= 6): {
        const { geoService } = await import('../geo/geo.service.js');
        let lat = m.location?.latitude; let lng = m.location?.longitude;
        let label = m.location?.address || m.location?.name || text;
        if (lat === undefined || lng === undefined) {
          const { maps } = await import('../geo/maps.port.js');
          const g = await maps.geocode(text).catch(() => null);
          if (!g) { await wa.text(to, 'I couldn\'t find that address. Try adding the area and a landmark, or send your location.'); break; }
          lat = g.lat; lng = g.lng; label = g.formatted || text;
        }
        const zone = await geoService.checkZone(lat, lng);
        if (!zone.serviceable) { await wa.text(to, 'Sorry, we don\'t cover that area yet. Reply "menu" to start again.'); s.state = 'MENU'; break; }
        s.data = { ...s.data, lat, lng, address: String(label).slice(0, 160), city: (zone as { city?: string }).city ?? '' };
        s.state = 'ASK_DAY';
        await wa.buttons(to, 'When should the pro come?', [
          { id: 'day:0', title: 'Today' }, { id: 'day:1', title: 'Tomorrow' }, { id: 'day:2', title: 'In 2 days' },
        ]);
        break;
      }
      case id.startsWith('day:'): {
        s.data.dayOffset = Math.min(Math.max(Number(id.slice(4)) || 0, 0), 6);
        s.state = 'ASK_WINDOW';
        await wa.buttons(to, 'What time suits you?', [
          { id: 'win:morning', title: 'Morning 8–12' }, { id: 'win:afternoon', title: 'Afternoon 12–4' }, { id: 'win:evening', title: 'Evening 4–7' },
        ]);
        break;
      }
      case id.startsWith('win:') && !!WINDOWS[id.slice(4)]: {
        s.data.window = id.slice(4);
        s.state = 'CONFIRM';
        const when = new Date(Date.now() + Number(s.data.dayOffset ?? 0) * 86_400_000);
        const whenText = `${when.toDateString()}, ${WINDOWS[String(s.data.window)]}`;
        if (s.data.quoteOnly || !s.data.serviceId) {
          await wa.buttons(to, `Quote request\n${String(s.data.address)}\n${whenText}\n\nVerified pros near you will send prices. You only pay after you accept one.`, [
            { id: 'confirm:yes', title: 'Request quotes' }, { id: 'menu:book', title: 'Change' },
          ]);
          break;
        }
        const { price } = await import('../pricing/pricing.engine.js');
        try {
          const p = await price({ serviceId: String(s.data.serviceId) }); // same inputs bookingService.create prices with
          s.data.quotedKobo = String(p.totalKobo);
          await wa.buttons(to, `Booking summary\n${String(s.data.address)}\n${whenText}\nTotal: ${naira(p.totalKobo)}\n\nYour money is held by Kendibo until the job is done.`, [
            { id: 'confirm:yes', title: 'Confirm and pay' }, { id: 'menu:book', title: 'Change' },
          ]);
        } catch (e) {
          if ((e as Error).message !== 'QUOTE_REQUIRED') throw e;
          s.data.quoteOnly = true;
          await wa.buttons(to, `This job is priced after inspection.\n${String(s.data.address)}\n${whenText}`, [
            { id: 'confirm:yes', title: 'Request quotes' }, { id: 'menu:book', title: 'Change' },
          ]);
        }
        break;
      }
      case id === 'confirm:yes' && s.state === 'CONFIRM': {
        await confirmBooking(s, user, to, m.id);
        s.state = 'MENU'; s.data = {};
        break;
      }
      default:
        await sendMenu(to, profileName);
        s.state = 'MENU';
    }
  } catch (e) {
    observability.captureException(e);
    await wa.text(to, 'Something went wrong on our side. Reply "menu" to try again.').catch(() => undefined);
    s.state = 'MENU'; s.data = {};
  }
  await saveSession(s);
}

async function confirmBooking(s: Session, user: { id: string; email: string | null }, to: string, messageId: string) {
  const { propertyService } = await import('../properties/property.service.js');
  const address = await propertyService.createAddress(user.id, {
    houseNumber: '-', street: String(s.data.address ?? 'Shared location'), city: String(s.data.city || 'Unknown'),
    state: String(s.data.city || 'Unknown'), contactPhone: e164(to), latitude: Number(s.data.lat), longitude: Number(s.data.lng),
    landmark: 'Added from WhatsApp',
  });
  const when = new Date(Date.now() + Number(s.data.dayOffset ?? 0) * 86_400_000);
  const scheduledDate = when.toISOString().slice(0, 10);

  if (s.data.quoteOnly || !s.data.serviceId) {
    const { requestService } = await import('../requests/request.service.js');
    const r = await requestService.create(user.id, {
      categoryId: s.data.categoryId ? String(s.data.categoryId) : undefined,
      title: 'WhatsApp quote request', addressId: address.id, scheduledDate, timeWindow: WINDOWS[String(s.data.window)],
      contactPhone: e164(to), idempotencyKey: `wa_${messageId}`, source: 'whatsapp',
    });
    emit('whatsapp.request_created', { requestId: r.id });
    await wa.text(to, 'Request sent. We\'ll message you here as soon as verified pros reply with prices.');
    return;
  }

  const { bookingService } = await import('../bookings/booking.service.js');
  const booking = await bookingService.create(user.id, {
    serviceId: String(s.data.serviceId), addressId: address.id,
    scheduledAt: `${scheduledDate}T${WINDOWS[String(s.data.window)].slice(0, 5)}:00+01:00`,
    customerNotes: 'Booked on WhatsApp', idempotencyKey: `wa_${messageId}`,
  });
  if (!deps) throw new Error('WHATSAPP_PAYMENTS_NOT_CONFIGURED');
  const amount = BigInt(String((booking as unknown as { priceKobo: string }).priceKobo ?? s.data.quotedKobo ?? '0'));
  const session = await deps.createCheckout({
    bookingId: booking.id, amountKobo: amount,
    customerEmail: user.email || `wa${to.replace(/\D/g, '')}@customers.kendibo.ng`,
    reference: `bk_${booking.id}_wa`, idempotencyKey: `wa_${messageId}`,
  });
  emit('whatsapp.booking_created', { bookingId: booking.id, psp: session.psp ?? 'unknown' });
  if (session.checkoutUrl) {
    await wa.ctaUrl(to, `Booking created. Pay ${naira(amount)} to confirm — we match your pro as soon as payment clears.`, 'Pay securely', session.checkoutUrl);
  } else {
    await wa.text(to, 'Booking created. Open the Kendibo app to pay and confirm it.');
  }
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
    await wa.text(to, `${who} accepted your job. They'll inspect first and send a quote here for you to approve — you only pay after you accept it.`);
    return;
  }
  const b = await q<{ price_kobo: string | null; total_kobo: string | null }>(`SELECT * FROM booking.booking WHERE id=$1`, [bookingId]).catch(() => []);
  const amount = BigInt(String(b[0]?.price_kobo ?? b[0]?.total_kobo ?? '0').split('.')[0] || '0');
  const email = await q<{ email: string | null }>(`SELECT email FROM identity.users WHERE id=$1`, [r.user_id]);
  if (!deps || amount <= 0n) {
    await wa.text(to, `${who} accepted your job. Open the Kendibo app to confirm and pay.`);
    return;
  }
  const session = await deps.createCheckout({
    bookingId, amountKobo: amount, customerEmail: email[0]?.email || `wa${to}@customers.kendibo.ng`,
    reference: `bk_${bookingId}_wa`, idempotencyKey: `wa_accept_${bookingId}`,
  });
  if (session.checkoutUrl) {
    await wa.ctaUrl(to, `${who} accepted your job. Pay ${`₦${(Number(amount) / 100).toLocaleString('en-NG')}`} to confirm — Kendibo holds it until you say the job is done.`, 'Pay securely', session.checkoutUrl);
  } else {
    await wa.text(to, `${who} accepted your job. Open the Kendibo app to confirm and pay.`);
  }
}
