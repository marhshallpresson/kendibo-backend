// /invoice on WhatsApp. The invoices module (modules/invoices/invoice.service.ts,
// with sendInvoice / latestInvoiceFor) is built on another branch; until it is
// present this falls back to a friendly note.
import { observability } from '../../packages/observability/watchup.adapter.js';
import { wa } from './whatsapp.client.js';

export interface InvoiceModule {
  /** (Re)send the booking's newest receipt/invoice to the customer; null when there is none yet. */
  sendInvoice?: (bookingId: string) => Promise<{ number: string; url: string } | null>;
  /** The customer's most recent document on any booking. */
  latestInvoiceFor?: (userId: string) => Promise<{ number: string; url: string; kind?: string } | null>;
}

const PATH = '../invoices/invoice.service.js';
let override: (() => Promise<InvoiceModule | null>) | null = null;
/** Tests only: pretend the invoices module is (or isn't) there. */
export function setInvoiceModuleForTests(fn: (() => Promise<InvoiceModule | null>) | null): void { override = fn; }

async function loadInvoices(): Promise<InvoiceModule | null> {
  if (override) return override();
  try {
    const mod = (await import(PATH)) as InvoiceModule;
    return typeof mod.sendInvoice === 'function' || typeof mod.latestInvoiceFor === 'function' ? mod : null;
  } catch (e) {
    // Not built on this branch yet: that's expected. Anything else is a real bug.
    const code = (e as { code?: string }).code;
    if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') observability.captureException(e);
    return null;
  }
}

/**
 * Send the invoice for the active session's booking. With no open session at
 * all (most invoices are for finished jobs) the customer's latest document is sent.
 */
export async function replyWithInvoice(to: string, userId: string, active: { bookingId: string | null } | null, prefix = ''): Promise<void> {
  const mod = await loadInvoices();
  const bookingId = active?.bookingId ?? null;
  try {
    if (mod?.sendInvoice && bookingId) {
      // sendInvoice delivers the document (link button) itself.
      if (await mod.sendInvoice(bookingId)) return;
    } else if (mod?.latestInvoiceFor && !active) {
      const inv = await mod.latestInvoiceFor(userId);
      if (inv) {
        await wa.ctaUrl(to, `${prefix}Here is your latest Kendibo ${inv.kind === 'receipt' ? 'receipt' : 'invoice'}, ${inv.number}.`, inv.kind === 'receipt' ? 'View receipt' : 'View invoice', inv.url);
        return;
      }
    }
  } catch (e) { observability.captureException(e); }
  await wa.text(to, `${prefix}Your invoice will arrive here after payment.`);
}
