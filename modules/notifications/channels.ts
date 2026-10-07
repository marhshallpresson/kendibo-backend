// Notify channels — one port per provider family (PRD App P: no vendor lock-in).
// Dev: logs to console. Prod: set keys -> Termii (SMS), Resend or SMTP (email), FCM (push).
export interface SmsPort { send(to: string, body: string): Promise<{ id: string }>; }
export interface EmailPort { send(to: string, subject: string, html: string): Promise<{ id: string }>; }
export interface PushPort { send(pushToken: string, title: string, body: string, data?: Record<string, string>): Promise<{ id: string }>; }

const id = (p: string) => `${p}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
const devLog = process.env.NODE_ENV !== 'production';

export class TermiiSmsAdapter implements SmsPort {
  async send(to: string, body: string) {
    if (process.env.TERMII_API_KEY && process.env.TERMII_SENDER) {
      const r = await fetch('https://api.ng.termii.com/api/sms/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, from: process.env.TERMII_SENDER, sms: body, type: 'plain', channel: 'dnd', api_key: process.env.TERMII_API_KEY }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok || (data && data.code && data.code !== 'ok' && data.message !== 'Successfully Sent')) {
        console.error('[termii error]', data);
        throw new Error(`SMS_SEND_FAILED: ${data?.message || r.statusText}`);
      }
      return { id: data?.message_id || id('sms') };
    }
    if (devLog) console.log(`[sms] to=${to} body=${body.slice(0, 120)}`);
    return { id: id('sms_dev') };
  }
}
export class ResendEmailAdapter implements EmailPort {
  async send(to: string, subject: string, html: string) {
    if (process.env.RESEND_API_KEY) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: process.env.EMAIL_FROM ?? 'KENDIBO <hello@kendibo.com>', to, subject, html }),
      });
      if (!r.ok) throw new Error('EMAIL_SEND_FAILED');
      return { id: id('em') };
    }
    if (devLog) console.log(`[email] to=${to} subject=${subject}`);
    return { id: id('em_dev') };
  }
}
import { initializeApp, cert, getApps, type App } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

let fcmApp: App | null = null;
/** Lazy init from env — never a hardcoded path. Set FCM_SERVICE_ACCOUNT_JSON
 *  (inline JSON of the KENDIBO Firebase project's service account) or
 *  GOOGLE_APPLICATION_CREDENTIALS (path). Without either, push degrades to
 *  console log in dev and throws PUSH_UNCONFIGURED in production. */
function fcm(): App | null {
  if (fcmApp) return fcmApp;
  try {
    const inline = process.env.FCM_SERVICE_ACCOUNT_JSON;
    const sa = inline ? JSON.parse(inline) : undefined;
    if (!sa && !process.env.GOOGLE_APPLICATION_CREDENTIALS) return null;
    fcmApp = getApps()[0] ?? initializeApp(sa ? { credential: cert(sa) } : undefined);
    return fcmApp;
  } catch (e) {
    if (devLog) console.log('[fcm] init skipped:', (e as Error).message);
    return null;
  }
}

export class FcmPushAdapter implements PushPort {
  async send(pushToken: string, title: string, body: string, data: Record<string, string> = {}) {
    const app = fcm();
    if (app && pushToken) {
      const res = await getMessaging(app).send({ notification: { title, body }, data, token: pushToken });
      return { id: res };
    }
    if (devLog) console.log(`[push] token=${pushToken.slice(0, 12)}… title=${title}`);
    if (process.env.NODE_ENV === 'production') throw new Error('PUSH_UNCONFIGURED');
    return { id: id('push_dev') };
  }
}
export const sms: SmsPort = new TermiiSmsAdapter();
export const email: EmailPort = new ResendEmailAdapter();
export const push: PushPort = new FcmPushAdapter();
