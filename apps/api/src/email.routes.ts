// Email: admin alert recipients (stored in the DB), one-click unsubscribe and
// the signed-in user's email-marketing preference. Policies are merged into the
// deny-by-default gate in main.ts.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Permission } from '../../../modules/authorization/rbac.js';
import { auditService } from '../../../modules/audit/audit.service.js';
import { getAlertEmails, setAlertEmails, alertEmailsSchema } from '../../../modules/notifications/admin-alerts.service.js';
import { verifyUnsubscribeToken } from '../../../modules/notifications/email-layout.js';
import { unsubscribe, setMarketingConsent, emailPreferences } from '../../../modules/notifications/lifecycle.service.js';
import { escapeHtml } from '../../../modules/notifications/mail.templates.js';

export const EMAIL_ROUTE_POLICY: Record<string, 'public' | Permission> = {
  'GET /v1/admin/settings/alert-emails': 'configuration:edit',
  'PUT /v1/admin/settings/alert-emails': 'configuration:edit',
  'GET /v1/email/unsubscribe': 'public', // HMAC-signed link checked in the handler
  'POST /v1/email/unsubscribe': 'public', // RFC 8058 one-click; same signed link
  // GET/PUT /v1/me/email-preferences: any signed-in user (default gate).
};

interface Helpers {
  authed: (req: never) => { sub: string } | null;
  fail: (reply: FastifyReply, code: string, message: string, status?: number, retryable?: boolean) => unknown;
}

const linkSchema = z.object({ u: z.string().uuid(), t: z.string().min(10).max(200) });

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;background:#eef2fb;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#333">
<div style="max-width:480px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden">
<div style="background:#002a63;padding:22px;text-align:center;color:#fff;font-size:24px;font-weight:900">kendibo<span style="color:#9dbfff">.</span></div>
<div style="padding:28px 24px"><h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(title)}</h1><p style="font-size:16px;line-height:1.6">${escapeHtml(body)}</p></div></div></body></html>`;
}

export function registerEmailRoutes(app: FastifyInstance, h: Helpers) {
  app.get('/v1/admin/settings/alert-emails', async () => ({ data: { emails: await getAlertEmails() } }));

  app.put('/v1/admin/settings/alert-emails', async (req, reply) => {
    const a = h.authed(req as never);
    const body = z.object({ emails: alertEmailsSchema }).safeParse(req.body ?? {});
    if (!body.success) return h.fail(reply, 'VALIDATION', 'emails must be 1-20 valid email addresses', 400);
    const emails = await setAlertEmails(body.data.emails, a?.sub);
    if (a) await auditService.log(a.sub, 'settings.alert_emails.update', emails.join(',')).catch(() => {});
    return { data: { emails } };
  });

  const doUnsub = async (query: unknown) => {
    const p = linkSchema.safeParse(query);
    if (!p.success || !verifyUnsubscribeToken(p.data.u, p.data.t)) return false;
    await unsubscribe(p.data.u);
    return true;
  };

  app.get('/v1/email/unsubscribe', async (req, reply) => {
    const ok = await doUnsub(req.query);
    reply.code(ok ? 200 : 400).type('text/html; charset=utf-8');
    return ok
      ? page('You are unsubscribed', 'You will no longer get marketing or tips emails from Kendibo. Booking receipts and security messages will still reach you. You can opt back in from the app settings.')
      : page('Link not valid', 'This unsubscribe link is invalid or incomplete. Use the link from the latest email, or change email settings in the Kendibo app.');
  });

  app.post('/v1/email/unsubscribe', async (req, reply) => {
    if (!(await doUnsub(req.query))) return h.fail(reply, 'INVALID_LINK', 'Unsubscribe link is invalid', 400);
    return { data: { unsubscribed: true } };
  });

  app.get('/v1/me/email-preferences', async (req, reply) => {
    const a = h.authed(req as never);
    if (!a) return h.fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
    return { data: await emailPreferences(a.sub) };
  });

  app.put('/v1/me/email-preferences', async (req, reply) => {
    const a = h.authed(req as never);
    if (!a) return h.fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
    const body = z.object({ marketing: z.boolean(), source: z.enum(['app_settings', 'app_signup', 'web', 'whatsapp']).default('app_settings') }).safeParse(req.body ?? {});
    if (!body.success) return h.fail(reply, 'VALIDATION', 'marketing must be true or false', 400);
    return { data: await setMarketingConsent(a.sub, body.data.marketing, body.data.source) };
  });
}
