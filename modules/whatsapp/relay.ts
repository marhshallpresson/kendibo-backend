// Masked client ↔ vendor chat through Kendibo. Once a vendor accepts a
// WhatsApp request, both sides write to Kendibo's number and the bot passes
// each message on word for word, labelled with who sent it. Phone numbers,
// emails and links are hidden so the job, the payment and any dispute stay on
// Kendibo. Either side types END to close it; it also closes after 14 days.
import { q } from '../../packages/database/db.js';
import { emit } from '../../packages/observability/emit.js';
import { wa } from './whatsapp.client.js';
import { notifyCustomer } from './policy.js';

const LIFETIME_MS = 14 * 86_400_000;
export interface Relay { id: string; side: 'customer' | 'vendor'; counterpart: string; vendorName: string; requestId: string }

/** Hide anything that would take the conversation off Kendibo. */
export function maskContacts(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email hidden]')
    .replace(/https?:\/\/\S+|www\.\S+|wa\.me\/\S+/gi, '[link hidden]')
    .replace(/(\+?\d[\d\s-]{8,}\d)/g, (m) => (m.replace(/\D/g, '').length >= 10 ? '[number hidden]' : m));
}

export async function openRelay(requestId: string): Promise<void> {
  const r = await q<{ contact_phone: string | null; provider_id: string; name: string | null; phone: string | null }>(
    `SELECT sr.contact_phone, o.provider_id, p.business_name AS name, u.phone
       FROM booking.service_request sr
       JOIN booking.request_offer o ON o.request_id = sr.id AND o.status = 'accepted'
       JOIN provider.provider p ON p.id = o.provider_id
       JOIN identity.users u ON u.id = p.user_id
      WHERE sr.id = $1 AND sr.source = 'whatsapp' LIMIT 1`, [requestId],
  ).catch(() => []);
  const row = r[0];
  if (!row?.contact_phone || !row.phone) return;
  const customer = String(row.contact_phone).replace(/\D/g, '');
  const vendor = String(row.phone).replace(/\D/g, '');
  const existing = await q(`SELECT 1 FROM messaging.whatsapp_relay WHERE request_id=$1 AND status='active'`, [requestId]);
  if (existing[0]) return;
  await q(`UPDATE messaging.whatsapp_relay SET status='closed', closed_at=now() WHERE status='active' AND (customer_wa=$1 OR vendor_wa=$2)`, [customer, vendor]);
  await q(`INSERT INTO messaging.whatsapp_relay (request_id, provider_id, customer_wa, vendor_wa) VALUES ($1,$2,$3,$4)`, [requestId, row.provider_id, customer, vendor]);
  emit('whatsapp.relay_opened', { requestId });
  await notifyCustomer(vendor, 'You are now connected with the customer through Kendibo. Reply here and I will pass your messages on word for word. Type END when you are done.').catch(() => undefined);
  await notifyCustomer(customer, `You can now chat with ${row.name ?? 'your vendor'} right here. Your messages go through Kendibo, so your number stays private. Type END to stop, or MENU for other options.`).catch(() => undefined);
}

export async function activeRelay(waId: string): Promise<Relay | null> {
  const rows = await q<{ id: string; customer_wa: string; vendor_wa: string; request_id: string; created_at: string; name: string | null }>(
    `SELECT r.id, r.customer_wa, r.vendor_wa, r.request_id, r.created_at, p.business_name AS name
       FROM messaging.whatsapp_relay r JOIN provider.provider p ON p.id = r.provider_id
      WHERE r.status='active' AND (r.customer_wa=$1 OR r.vendor_wa=$1) ORDER BY r.created_at DESC LIMIT 1`, [waId],
  ).catch(() => []);
  const r = rows[0];
  if (!r) return null;
  if (Date.now() - new Date(String(r.created_at)).getTime() > LIFETIME_MS) {
    await closeRelay(String(r.id));
    return null;
  }
  const isCustomer = String(r.customer_wa) === waId;
  return { id: String(r.id), side: isCustomer ? 'customer' : 'vendor', counterpart: String(isCustomer ? r.vendor_wa : r.customer_wa), vendorName: r.name ?? 'Vendor', requestId: String(r.request_id) };
}

export async function closeRelay(id: string): Promise<void> {
  await q(`UPDATE messaging.whatsapp_relay SET status='closed', closed_at=now() WHERE id=$1`, [id]);
}

/** Pass a text on, labelled and masked. Outside the 24h window it goes as a template or SMS. */
export async function relayText(relay: Relay, text: string): Promise<void> {
  const label = relay.side === 'vendor' ? relay.vendorName : 'Customer';
  await notifyCustomer(relay.counterpart, `${label}: ${maskContacts(text).slice(0, 3500)}`);
}

/** Pass a photo, voice note, video or document on (by signed storage link). */
export async function relayMedia(relay: Relay, kind: 'image' | 'audio' | 'video' | 'document', url: string, caption?: string): Promise<void> {
  const label = relay.side === 'vendor' ? relay.vendorName : 'Customer';
  await wa.media(relay.counterpart, kind, url, caption ? `${label}: ${maskContacts(caption)}` : `From ${label}`);
}
