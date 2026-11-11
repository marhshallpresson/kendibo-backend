// Invoices / receipts and booking-time changes.
// - GET /w/invoice/:token: printable page; the signed link (purpose 'invoice',
//   bound to the customer + invoice) is the only credential.
// - GET /v1/bookings/:id/invoice: customer or admin get the newest document;
//   the assigned pro gets their earnings statement instead.
// - POST /v1/bookings/:id/invoice/send: resend it to the customer.
// - POST /v1/bookings/:id/change-time: customer/admin move it; the pro proposes.
// - POST /v1/bookings/:id/schedule-changes/:changeId: customer accepts/declines.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { verifyLink, invoiceLink } from '../../../modules/whatsapp/links.js';
import { currentInvoice, invoiceById, issueInvoice, sendInvoice, earningsStatement } from '../../../modules/invoices/invoice.service.js';
import { renderInvoicePage } from '../../../modules/invoices/invoice.page.js';
import { changeBookingTime, proposeNewTime, answerScheduleChange } from '../../../modules/job-engine/schedule-updates.js';
import { providerService } from '../../../modules/providers/provider.service.js';

export const INVOICE_ROUTE_POLICY: Record<string, 'public'> = {
  'GET /w/invoice/*': 'public', // signed link checked in the handler (wildcard: tokens are longer than a route param allows)
};

type Party = { sub: string; as: 'customer' | 'provider' | 'admin' };
interface Helpers {
  fail: (reply: FastifyReply, code: string, message: string, status?: number, retryable?: boolean) => unknown;
  bookingParty: (req: never, reply: FastifyReply, bookingId: string) => Promise<Party | null>;
  providerActor: (req: never, reply: FastifyReply) => Promise<{ id: string } | null>;
}

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const page = (reply: FastifyReply, status: number, html: string) => reply.code(status)
  .header('Content-Security-Policy', PAGE_CSP).header('Cache-Control', 'private, no-store')
  .header('Referrer-Policy', 'no-referrer').header('X-Robots-Tag', 'noindex').type('text/html; charset=utf-8').send(html);
const notice = (title: string, msg: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title} — Kendibo</title></head><body style="font:16px/1.5 system-ui,sans-serif;color:#0F172A;background:#F6F7F9;margin:0"><main style="max-width:560px;margin:0 auto;padding:40px 16px;text-align:center"><h2>${title}</h2><p style="color:#475569">${msg}</p></main></body></html>`;

const timeBody = z.object({ scheduledAt: z.string().min(10).max(40), window: z.enum(['morning', 'afternoon', 'evening']).nullish() });

const ERRORS: Record<string, [number, string]> = {
  BAD_TIME: [400, 'That time is not valid.'],
  TIME_IN_PAST: [400, 'Pick a time in the future.'],
  BAD_WINDOW: [400, 'Pick morning, afternoon or evening.'],
  TOO_LATE_TO_MOVE: [409, 'This job has already started, so the time can no longer change.'],
  NOT_YOUR_JOB: [403, 'This job is not assigned to you.'],
  NOT_FOUND: [404, 'Booking not found'],
};

export function registerInvoiceRoutes(app: FastifyInstance, h: Helpers) {
  const err = (reply: FastifyReply, e: unknown) => {
    const m = (e as Error).message;
    const [status, text] = ERRORS[m] ?? [500, 'Something went wrong'];
    if (!ERRORS[m]) app.log.error({ err: e }, 'invoice/schedule route failed');
    return h.fail(reply, ERRORS[m] ? m : 'INTERNAL', text, status);
  };

  app.get('/w/invoice/*', async (req, reply) => {
    let token = String((req.params as Record<string, string>)['*'] ?? '');
    try { token = decodeURIComponent(token); } catch { token = ''; }
    const claims = verifyLink(token, 'invoice');
    if (!claims) return page(reply, 403, notice('Link not valid', 'This receipt link is not valid. Ask for a new one on WhatsApp by typing /invoice.'));
    const inv = await invoiceById(claims.d);
    if (!inv || inv.userId !== claims.w) return page(reply, 404, notice('Not found', 'We could not find this document.'));
    return page(reply, 200, renderInvoicePage(inv));
  });

  app.get('/v1/bookings/:id/invoice', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const party = await h.bookingParty(req as never, reply, id); if (!party) return reply;
    if (party.as === 'provider') {
      const me = await providerService.byUserId(party.sub);
      return { data: { kind: 'earnings_statement', ...(await earningsStatement(id, String(me?.id))) } };
    }
    const inv = (await currentInvoice(id)) ?? (await issueInvoice(id, 'receipt'));
    if (!inv) return h.fail(reply, 'NOT_PAID', 'There is no receipt yet: this booking has not been paid.', 404);
    return { data: { id: inv.id, number: inv.number, kind: inv.kind, issuedAt: inv.issuedAt, amountKobo: inv.amountKobo, ...inv.data, url: invoiceLink(inv.userId, inv.id) } };
  });

  app.post('/v1/bookings/:id/invoice/send', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const party = await h.bookingParty(req as never, reply, id); if (!party) return reply;
    if (party.as === 'provider') return h.fail(reply, 'FORBIDDEN', 'Only the customer or the team can resend the invoice', 403);
    const out = await sendInvoice(id);
    if (!out) return h.fail(reply, 'NOT_PAID', 'There is no receipt yet: this booking has not been paid.', 404);
    return { data: out };
  });

  app.post('/v1/bookings/:id/change-time', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const party = await h.bookingParty(req as never, reply, id); if (!party) return reply;
    const body = timeBody.safeParse(req.body);
    if (!body.success) return h.fail(reply, 'VALIDATION', 'Send scheduledAt (ISO time) and an optional window', 400);
    try {
      if (party.as === 'provider') {
        const me = await h.providerActor(req as never, reply); if (!me) return reply;
        const out = await proposeNewTime(id, me.id, body.data.scheduledAt, body.data.window ?? null);
        return { data: { status: 'proposed', changeId: out.id } };
      }
      const out = await changeBookingTime(id, body.data.scheduledAt, body.data.window ?? null, { as: party.as, id: party.sub });
      return { data: { status: 'moved', ...out } };
    } catch (e) { return err(reply, e); }
  });

  app.post('/v1/bookings/:id/schedule-changes/:changeId', async (req, reply) => {
    const { id, changeId } = req.params as { id: string; changeId: string };
    const party = await h.bookingParty(req as never, reply, id); if (!party) return reply;
    if (party.as !== 'customer') return h.fail(reply, 'FORBIDDEN', 'Only the customer can answer this', 403);
    const body = z.object({ accept: z.boolean() }).safeParse(req.body);
    if (!body.success) return h.fail(reply, 'VALIDATION', 'Send accept: true or false', 400);
    try {
      const out = await answerScheduleChange(changeId, party.sub, body.data.accept);
      if (out === 'gone') return h.fail(reply, 'CHANGE_GONE', 'This change was already answered or replaced.', 409);
      return { data: { status: out } };
    } catch (e) { return err(reply, e); }
  });
}
