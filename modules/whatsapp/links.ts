// Signed, short-lived links the WhatsApp assistant sends ("Set your location",
// "See vendors near you"). They open in WhatsApp's in-app browser with no
// login, so the token IS the authorisation: HMAC-SHA256 over the payload,
// bound to one WhatsApp user + one job draft + one purpose, with an expiry.
import crypto from 'node:crypto';

export type LinkPurpose = 'loc' | 'vendors' | 'pay' | 'verify' | 'email' | 'invoice' | 'paga';
export interface LinkClaims { w: string; d: string; p: LinkPurpose; exp: number }

const secret = () => process.env.WHATSAPP_LINK_SECRET || process.env.JWT_ACCESS_SECRET || 'dev-wa-links-INSECURE';
const b64 = (s: Buffer | string) => Buffer.from(s).toString('base64url');

export function signLink(claims: Omit<LinkClaims, 'exp'>, ttlSeconds = 2 * 3600): string {
  const body = b64(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyLink(token: string | undefined, purpose: LinkPurpose): LinkClaims | null {
  if (!token || token.length > 600) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const want = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  const a = Buffer.from(mac); const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as LinkClaims;
    if (c.p !== purpose || typeof c.w !== 'string' || typeof c.d !== 'string') return null;
    if (!Number.isFinite(c.exp) || c.exp < Math.floor(Date.now() / 1000)) return null;
    return c;
  } catch { return null; }
}

/** Public origin the pages are served from (the API host serves them). */
export const webBase = () => (process.env.WHATSAPP_WEB_BASE_URL || process.env.STOREFRONT_BASE_URL || process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');

export const locationLink = (waId: string, draftId: string) => `${webBase()}/w/location?t=${encodeURIComponent(signLink({ w: waId, d: draftId, p: 'loc' }))}`;
/** Token for the "Pay securely" template button (d = booking id). */
export const payToken = (waId: string, bookingId: string) => signLink({ w: waId, d: bookingId, p: 'pay' }, 72 * 3600);
export const vendorsLink = (waId: string, draftId: string) => `${webBase()}/w/vendors?t=${encodeURIComponent(signLink({ w: waId, d: draftId, p: 'vendors' }, 24 * 3600))}`;
/** Secure ID-check page (d = user id). NIN is typed on Kendibo's page, never in the chat. */
export const idCheckLink = (waId: string, userId: string) => `${webBase()}/w/verify?t=${encodeURIComponent(signLink({ w: waId, d: userId, p: 'verify' }, 24 * 3600))}`;
/** Where would-be providers and vendors sign up (VENDOR_SIGNUP_URL). Read only here. */
export const vendorSignupUrl = () => (process.env.VENDOR_SIGNUP_URL || '').trim() || 'https://kendibo.ng/#join-provider';
/** Public terms & privacy summary the onboarding message links to. */
export const termsLink = () => `${webBase()}/w/terms`;
/** Email confirmation link (d = user id). The email is attached only once this is opened. */
export const emailConfirmLink = (waId: string, userId: string) => `${webBase()}/w/confirm-email?t=${encodeURIComponent(signLink({ w: waId, d: userId, p: 'email' }, 24 * 3600))}`;
/** Printable invoice / receipt page (w = customer user id, d = invoice id). Long-lived: people keep receipts. */
export const invoiceLink = (userId: string, invoiceId: string) => `${webBase()}/w/invoice/${encodeURIComponent(signLink({ w: userId, d: invoiceId, p: 'invoice' }, 365 * 86_400))}`;
