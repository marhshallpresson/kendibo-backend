// Invoices and receipts for customers.
//
// - Receipt: issued when a payment succeeds. Says what was paid and that
//   Kendibo holds it until the customer confirms the job.
// - Final invoice: issued at settlement (customer confirmed, or the 48h timer).
//   Service, date, pro, listed price, approved extras, total paid, payment
//   reference and Kendibo's company details.
//
// Numbers are sequential per year (KND-2026-000123). One invoice of each kind
// per booking, ever: creation is idempotent, and so is delivery (WhatsApp with
// a signed link to a printable page, plus email when the email is verified).
// VAT on Kendibo's commission is charged to the provider, so the customer's
// documents show the listed price only.
import { q } from '../../packages/database/db.js';
import { emit } from '../../packages/observability/emit.js';
import { observability } from '../../packages/observability/watchup.adapter.js';
import { bookingFacts } from './when.js';

export type InvoiceKind = 'receipt' | 'final';

export interface InvoiceLine { label: string; amountKobo: string }
export interface InvoiceData {
  service: string;
  scheduledAt: string | null;
  timeWindow: string | null;
  when: string | null;
  proName: string | null;
  customerName: string | null;
  address: string | null;
  lines: InvoiceLine[];
  totalKobo: string;
  paidKobo: string;
  paymentReference: string | null;
  paidAt: string | null;
  status: 'held' | 'released';
  company: CompanyDetails;
}
export interface CompanyDetails { name: string; address: string; email: string; phone: string | null; rc: string | null; website: string }
export interface Invoice {
  id: string; number: string; bookingId: string; userId: string; kind: InvoiceKind;
  amountKobo: string; paymentReference: string | null; issuedAt: string; data: InvoiceData;
  waSentAt: string | null; emailSentAt: string | null;
}

export const company = (): CompanyDetails => ({
  name: process.env.KENDIBO_COMPANY_NAME || 'Kendibo Technologies Ltd',
  address: process.env.KENDIBO_COMPANY_ADDRESS || 'Uyo, Akwa Ibom State, Nigeria',
  email: process.env.KENDIBO_COMPANY_EMAIL || 'hello@kendibo.ng',
  phone: process.env.WHATSAPP_BUSINESS_NUMBER || null,
  rc: process.env.KENDIBO_COMPANY_RC || null,
  website: 'kendibo.ng',
});

export const naira = (kobo: bigint | string | number) => {
  const k = Number(kobo);
  const d = k % 100 === 0 ? 0 : 2;
  return `₦${(k / 100).toLocaleString('en-NG', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
};
const big = (v: unknown) => BigInt(String(v ?? '0').split('.')[0] || '0');
const lagosYear = (d = new Date()) => Number(new Intl.DateTimeFormat('en-GB', { year: 'numeric', timeZone: 'Africa/Lagos' }).format(d));
export const formatNumber = (year: number, n: number) => `KND-${year}-${String(n).padStart(6, '0')}`;

function toInvoice(r: Record<string, unknown>): Invoice {
  const data = (typeof r.data === 'string' ? JSON.parse(r.data) : r.data) as InvoiceData;
  return {
    id: String(r.id), number: String(r.number), bookingId: String(r.booking_id), userId: String(r.user_id),
    kind: r.kind as InvoiceKind, amountKobo: String(r.amount_kobo), paymentReference: r.payment_reference ? String(r.payment_reference) : null,
    issuedAt: new Date(String(r.issued_at)).toISOString(), data,
    waSentAt: r.wa_sent_at ? String(r.wa_sent_at) : null, emailSentAt: r.email_sent_at ? String(r.email_sent_at) : null,
  };
}

/** Next number for this year (row-locked UPDATE, so concurrent issuers never share one). */
async function nextNumber(): Promise<string> {
  const year = lagosYear();
  await q(`INSERT INTO billing.invoice_counter (year, last_no) VALUES ($1, 0) ON CONFLICT (year) DO NOTHING`, [year]).catch(() => undefined);
  const r = await q<{ last_no: number }>(`UPDATE billing.invoice_counter SET last_no = last_no + 1 WHERE year=$1 RETURNING last_no`, [year]);
  return formatNumber(year, Number(r[0].last_no));
}

export async function invoiceFor(bookingId: string, kind: InvoiceKind): Promise<Invoice | null> {
  const r = await q<Record<string, unknown>>(`SELECT * FROM billing.invoice WHERE booking_id=$1 AND kind=$2`, [bookingId, kind]).catch(() => []);
  return r[0] ? toInvoice(r[0]) : null;
}

export async function invoiceById(id: string): Promise<Invoice | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await q<Record<string, unknown>>(`SELECT * FROM billing.invoice WHERE id=$1`, [id]).catch(() => []);
  return r[0] ? toInvoice(r[0]) : null;
}

/** The newest document for a booking: the final invoice once there is one, else the receipt. */
export async function currentInvoice(bookingId: string): Promise<Invoice | null> {
  return (await invoiceFor(bookingId, 'final')) ?? (await invoiceFor(bookingId, 'receipt'));
}

/**
 * The booking's main line. A product order, or any quantity above one (052),
 * reads "3 × Lithium battery 200Ah @ ₦X = ₦Y"; the amount stays the booking price.
 */
async function mainLineLabel(bookingId: string, service: string, priceKobo: bigint): Promise<string> {
  const r = await q<{ title: string | null; quantity: number | null; unit_price_kobo: string | null; offering_id: string | null }>(
    `SELECT title, quantity, unit_price_kobo, offering_id FROM booking.service_request WHERE booking_id=$1 LIMIT 1`, [bookingId],
  ).catch(() => []);
  const req = r[0];
  if (!req) return service;
  const qty = Number(req.quantity ?? 1) || 1;
  let isProduct = false;
  if (req.offering_id) {
    const o = await q<{ kind: string | null }>(`SELECT kind FROM provider.offering WHERE id=$1`, [String(req.offering_id)]).catch(() => []);
    isProduct = o[0]?.kind === 'product';
  }
  if (qty <= 1 && !isProduct) return service;
  const unit = req.unit_price_kobo != null ? big(req.unit_price_kobo) : priceKobo / BigInt(qty);
  const name = req.title ? String(req.title) : service;
  return `${qty} × ${name} @ ${naira(unit)} = ${naira(unit * BigInt(qty))}`;
}

/** Everything the documents show, read fresh from the booking. */
async function gather(bookingId: string, kind: InvoiceKind): Promise<{ userId: string; data: InvoiceData } | null> {
  const f = await bookingFacts(bookingId);
  if (!f) return null;
  const price = await q<{ price_kobo: string }>(`SELECT price_kobo FROM booking.booking WHERE id=$1`, [bookingId]);
  const extras = await q<{ reason: string; amount_kobo: string }>(
    `SELECT reason, amount_kobo FROM booking.change_order WHERE job_id=$1 AND status='approved' ORDER BY created_at`, [bookingId],
  ).catch(() => []);
  const pays = await q<{ reference: string; amount_kobo: string; created_at: string }>(
    `SELECT reference, amount_kobo, created_at FROM payment.payment WHERE booking_id=$1 AND status='successful' ORDER BY created_at`, [bookingId],
  ).catch(() => []);
  const paid = pays.reduce((s, p) => s + big(p.amount_kobo), 0n);
  const service = f.service.charAt(0).toUpperCase() + f.service.slice(1);
  const priceKobo = big(price[0]?.price_kobo);
  const lines: InvoiceLine[] = [{ label: await mainLineLabel(bookingId, service, priceKobo), amountKobo: String(priceKobo) }];
  for (const x of extras) lines.push({ label: `Extra: ${String(x.reason).slice(0, 120)}`, amountKobo: String(big(x.amount_kobo)) });
  const total = lines.reduce((s, l) => s + BigInt(l.amountKobo), 0n);
  const last = pays.at(-1);
  return {
    userId: f.userId,
    data: {
      service, scheduledAt: f.scheduledAt, timeWindow: f.window, when: f.when,
      proName: f.pro?.name ?? null,
      customerName: f.customer.name,
      address: f.address, lines, totalKobo: String(total), paidKobo: String(paid),
      paymentReference: last ? String(last.reference) : null,
      paidAt: last ? new Date(String(last.created_at)).toISOString() : null,
      status: kind === 'final' ? 'released' : 'held',
      company: company(),
    },
  };
}

/**
 * Issue (or return) the booking's receipt / final invoice. Idempotent: a second
 * call returns the first document. Returns null when nothing has been paid.
 */
export async function issueInvoice(bookingId: string, kind: InvoiceKind): Promise<Invoice | null> {
  const existing = await invoiceFor(bookingId, kind);
  if (existing) return existing;
  const g = await gather(bookingId, kind);
  if (!g || BigInt(g.data.paidKobo) <= 0n) return null;
  const number = await nextNumber();
  try {
    const r = await q<Record<string, unknown>>(
      `INSERT INTO billing.invoice (number, booking_id, user_id, kind, amount_kobo, payment_reference, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [number, bookingId, g.userId, kind, g.data.paidKobo, g.data.paymentReference, JSON.stringify(g.data)],
    );
    emit('invoice.issued', { bookingId, kind, number });
    return toInvoice(r[0]);
  } catch (e) {
    // Lost a race with another issuer: theirs is the invoice (this number is skipped).
    const again = await invoiceFor(bookingId, kind);
    if (again) return again;
    throw e;
  }
}

async function contactOf(userId: string): Promise<{ phone: string | null; email: string | null; name: string | null }> {
  const r = await q<{ phone: string | null; email: string | null; email_verified_at: string | null; name: string | null }>(
    `SELECT phone, email, email_verified_at, name FROM identity.users WHERE id=$1`, [userId],
  ).catch(() => []);
  const u = r[0];
  return { phone: u?.phone ?? null, email: u?.email && u.email_verified_at ? String(u.email) : null, name: u?.name ?? null };
}

const docName = (inv: Invoice) => (inv.kind === 'final' ? 'invoice' : 'receipt');

/** WhatsApp text for a document (the page link travels as the button / SMS link). */
export function invoiceMessage(inv: Invoice): string {
  return inv.kind === 'final'
    ? `Your Kendibo invoice ${inv.number} is ready: ${inv.data.service}, ${naira(inv.data.paidKobo)} paid. Thanks for booking with Kendibo!`
    : `Payment received: ${naira(inv.data.paidKobo)}. Kendibo holds it safely until you confirm the job is done. Your receipt is ${inv.number}.`;
}

/**
 * Deliver a document to the customer: WhatsApp (link button inside the 24h
 * window, else template / SMS) and email when the address is verified.
 * Each channel goes once per document unless `force` (the customer asked again).
 */
export async function deliverInvoice(inv: Invoice, opts: { force?: boolean } = {}): Promise<{ whatsapp: boolean; email: boolean; url: string }> {
  const { invoiceLink } = await import('../whatsapp/links.js');
  const url = invoiceLink(inv.userId, inv.id);
  const who = await contactOf(inv.userId);
  let sentWa = false; let sentEmail = false;
  if (who.phone && (opts.force || !inv.waSentAt)) {
    const claimed = opts.force ? [{ id: inv.id }] : await q(`UPDATE billing.invoice SET wa_sent_at=now() WHERE id=$1 AND wa_sent_at IS NULL RETURNING id`, [inv.id]);
    if (claimed[0]) {
      try {
        const to = String(who.phone).replace(/\D/g, '');
        const { sendBusinessInitiated } = await import('../whatsapp/policy.js');
        const { wa } = await import('../whatsapp/whatsapp.client.js');
        const line = invoiceMessage(inv);
        await sendBusinessInitiated({
          waId: to,
          whatsapp: () => wa.ctaUrl(to, line, inv.kind === 'final' ? 'View invoice' : 'View receipt', url),
          template: { key: 'request_update', params: [`${line} ${url}`] },
          sms: `${line} ${url}`,
        });
        sentWa = true;
      } catch (e) { observability.captureException(e); }
    }
  }
  if (who.email && (opts.force || !inv.emailSentAt)) {
    const claimed = opts.force ? [{ id: inv.id }] : await q(`UPDATE billing.invoice SET email_sent_at=now() WHERE id=$1 AND email_sent_at IS NULL RETURNING id`, [inv.id]);
    if (claimed[0]) {
      try {
        const { email } = await import('../notifications/channels.js');
        const { renderInvoiceEmail } = await import('./invoice.page.js');
        const piece = renderInvoiceEmail({
          name: who.name ?? undefined, number: inv.number, kind: inv.kind, service: inv.data.service,
          when: inv.data.when, proName: inv.data.proName, total: naira(inv.data.paidKobo), url,
        });
        await email.send(who.email, `Your Kendibo ${docName(inv)} ${inv.number}`, piece.html, { reference: `invoice_${inv.id}` });
        sentEmail = true;
      } catch (e) { observability.captureException(e); }
    }
  }
  if (sentWa || sentEmail) emit('invoice.delivered', { bookingId: inv.bookingId, kind: inv.kind, whatsapp: sentWa, email: sentEmail });
  return { whatsapp: sentWa, email: sentEmail, url };
}

/** Payment succeeded: issue the receipt and send it. Never throws into the payment path. */
export async function onPaymentSucceeded(bookingId: string): Promise<Invoice | null> {
  try {
    const inv = await issueInvoice(bookingId, 'receipt');
    if (inv) await deliverInvoice(inv);
    return inv;
  } catch (e) { observability.captureException(e); return null; }
}

/** Job settled: issue the final invoice and send it. Never throws into settlement. */
export async function onSettled(bookingId: string): Promise<Invoice | null> {
  try {
    const inv = await issueInvoice(bookingId, 'final');
    if (inv) await deliverInvoice(inv);
    return inv;
  } catch (e) { observability.captureException(e); return null; }
}

/**
 * For the WhatsApp /invoice command: (re)send the booking's newest document.
 * Issues the receipt first if a paid booking somehow has none.
 */
export async function sendInvoice(bookingId: string): Promise<{ number: string; url: string } | null> {
  let inv = await currentInvoice(bookingId);
  if (!inv) inv = await issueInvoice(bookingId, 'receipt');
  if (!inv) return null;
  const out = await deliverInvoice(inv, { force: true });
  return { number: inv.number, url: out.url };
}

/** The customer's most recent document (any booking), for the /invoice command. */
export async function latestInvoiceFor(userId: string): Promise<(Invoice & { url: string }) | null> {
  const r = await q<Record<string, unknown>>(`SELECT * FROM billing.invoice WHERE user_id=$1 ORDER BY issued_at DESC LIMIT 1`, [userId]).catch(() => []);
  if (!r[0]) return null;
  const inv = toInvoice(r[0]);
  const { invoiceLink } = await import('../whatsapp/links.js');
  return { ...inv, url: invoiceLink(inv.userId, inv.id) };
}

/** What a provider sees instead of the customer's invoice: their earnings for the job. */
export async function earningsStatement(bookingId: string, providerId: string) {
  const r = await q<Record<string, unknown>>(
    `SELECT amount_kobo, gross_kobo, commission_kobo, commission_bps, vat_kobo, created_at FROM provider.earning WHERE provider_id=$1 AND job_id=$2 LIMIT 1`,
    [providerId, bookingId],
  ).catch(() => []);
  if (!r[0]) return { bookingId, settled: false as const };
  const e = r[0];
  return {
    bookingId, settled: true as const,
    grossKobo: String(e.gross_kobo ?? '0'), commissionKobo: String(e.commission_kobo ?? '0'), commissionBps: Number(e.commission_bps ?? 0),
    vatOnCommissionKobo: String(e.vat_kobo ?? '0'), netKobo: String(e.amount_kobo), creditedAt: String(e.created_at),
  };
}
