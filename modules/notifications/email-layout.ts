// Shared branded email layout for lifecycle, marketing and admin alerts —
// same colours and table layout as mail.templates.ts, plus what marketing
// mail legally needs: company address footer, preference link and a signed
// one-click unsubscribe (NDPA 2023 / GDPR / CAN-SPAM). Other modules (e.g.
// invoices) may reuse brandedEmail() for consistent branding.
import crypto from 'node:crypto';
import { escapeHtml } from './mail.templates.js';

export const PRIMARY = '#0463ee';
export const NAVY = '#002a63';

const trimUrl = (v: string) => String(v || '').trim().replace(/\/+$/, '');
export const appUrl = () => trimUrl(process.env.APP_URL || 'https://kendibo.ng');
export const apiUrl = () => trimUrl(process.env.PUBLIC_API_URL || process.env.WHATSAPP_WEB_BASE_URL || 'https://api.kendibo.ng');
export const companyAddress = () => process.env.COMPANY_POSTAL_ADDRESS || 'Kendibo Homes, Uyo, Akwa Ibom State, Nigeria';

function unsubSecret(): string {
  return `email-unsub:${process.env.EMAIL_UNSUB_SECRET || process.env.JWT_ACCESS_SECRET || 'dev-unsub-INSECURE-DEV-ONLY'}`;
}

/** Signed, non-expiring token: only proves "this link was mailed to this user". */
export function unsubscribeToken(userId: string): string {
  return crypto.createHmac('sha256', unsubSecret()).update(`unsub:${userId}`).digest('base64url');
}

export function verifyUnsubscribeToken(userId: string, token: string): boolean {
  const want = Buffer.from(unsubscribeToken(userId));
  const got = Buffer.from(String(token || ''));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

export function unsubscribeUrl(userId: string): string {
  return `${apiUrl()}/v1/email/unsubscribe?u=${encodeURIComponent(userId)}&t=${unsubscribeToken(userId)}`;
}

/** RFC 2369 + RFC 8058 one-click headers (Gmail/Yahoo bulk-sender rules). */
export function unsubscribeHeaders(userId: string): Record<string, string> {
  return {
    'List-Unsubscribe': `<${unsubscribeUrl(userId)}>, <mailto:unsubscribe@kendibo.ng?subject=unsubscribe>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

export interface BrandedEmailInput {
  title: string;
  /** Hidden inbox preview line. */
  preheader?: string;
  /** Paragraphs of plain text; escaped here. */
  paragraphs: string[];
  cta?: { label: string; url: string };
  /** 'marketing' and 'lifecycle' add the unsubscribe + preference footer. */
  kind: 'transactional' | 'lifecycle' | 'marketing' | 'admin';
  userId?: string;
  greetingName?: string | null;
}

export interface BrandedEmail { subject: string; html: string; text: string; headers: Record<string, string> }

const firstName = (n?: string | null) => String(n || '').trim().split(/\s+/)[0] || 'there';

export function brandedEmail(i: BrandedEmailInput): BrandedEmail {
  const p = 'font-size:16px;margin:0 0 18px 0;color:#333333;line-height:1.6;';
  const optional = (i.kind === 'marketing' || i.kind === 'lifecycle') && i.userId;
  const unsub = optional ? unsubscribeUrl(i.userId!) : '';
  const prefs = `${appUrl()}/settings/notifications`;
  const greeting = i.kind === 'admin' ? '' : `<p style="${p}">Hi ${escapeHtml(firstName(i.greetingName))},</p>`;
  const body = i.paragraphs.map((x) => `<p style="${p}">${escapeHtml(x)}</p>`).join('\n');
  const cta = i.cta
    ? `<div style="text-align:center;margin:26px 0;"><a href="${escapeHtml(i.cta.url)}" style="display:inline-block;background-color:${PRIMARY};color:#ffffff;font-size:16px;font-weight:800;text-decoration:none;padding:14px 30px;border-radius:10px;">${escapeHtml(i.cta.label)}</a></div>`
    : '';
  const footerLinks = optional
    ? `<p style="margin:10px 0 0 0;font-size:11px;">You are receiving this because you have a Kendibo account. <a href="${escapeHtml(prefs)}" style="color:#8fa0bf;">Email preferences</a> &middot; <a href="${escapeHtml(unsub)}" style="color:#8fa0bf;">Unsubscribe</a></p>`
    : '';
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(i.title)}</title></head>
<body style="margin:0;padding:0;background-color:#eef2fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(i.preheader ?? '')}</span>
<table width="100%" border="0" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:20px 12px;">
<table width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width:600px;background-color:#ffffff;border-radius:16px;overflow:hidden;">
<tr><td style="background-color:${NAVY};padding:24px 20px;text-align:center;">
<p style="color:#ffffff;font-size:26px;font-weight:900;letter-spacing:-0.5px;margin:0;"><a href="${escapeHtml(appUrl())}/" style="color:#ffffff;text-decoration:none;">kendibo<span style="color:#9dbfff;">.</span></a></p>
<p style="color:#9dbfff;font-size:12px;margin:6px 0 0 0;">Good help. Right around the corner.</p></td></tr>
<tr><td style="padding:30px 26px;background-color:#ffffff;">
<h1 style="font-size:20px;color:#111111;margin:0 0 18px 0;">${escapeHtml(i.title)}</h1>
${greeting}
${body}
${cta}
${i.kind === 'admin' ? '' : `<p style="${p}margin:0;">From the Kendibo Team</p>`}
</td></tr>
<tr><td style="background-color:#f8fafd;padding:22px 20px;text-align:center;font-size:12px;color:#8fa0bf;">
<p style="margin:0;">&copy; ${new Date().getFullYear()} Kendibo. ${escapeHtml(companyAddress())}</p>
${footerLinks}
</td></tr></table></td></tr></table></body></html>`;
  const textLines = [
    i.title, '',
    ...(i.kind === 'admin' ? [] : [`Hi ${firstName(i.greetingName)},`, '']),
    ...i.paragraphs.flatMap((x) => [x, '']),
    ...(i.cta ? [`${i.cta.label}: ${i.cta.url}`, ''] : []),
    ...(i.kind === 'admin' ? [] : ['From the Kendibo Team', '']),
    `Kendibo, ${companyAddress()}`,
    ...(optional ? [`Email preferences: ${prefs}`, `Unsubscribe: ${unsub}`] : []),
  ];
  return {
    subject: i.title,
    html,
    text: textLines.join('\n'),
    headers: optional ? unsubscribeHeaders(i.userId!) : {},
  };
}
