// Real notification channel adapters — Sling (HelloSling / SlingAfrica) primary omnichannel
// engine across SMS, WhatsApp, RCS, Truecaller & Email + FCM HTTP v1 push + Termii/SMTP/Resend fallbacks.
// Every adapter falls back cleanly to structured log in local dev when keys are unset.
import nodemailer, { type Transporter } from 'nodemailer';
import {
  SlingClient,
  slingClient,
  type SlingMessageType,
  type SlingRcsStandaloneCard,
  type SlingRcsCarouselCard,
  type SlingRcsSuggestion,
} from './sling.client';

export interface SmsPort {
  send(to: string, body: string, opts?: { type?: SlingMessageType; reference?: string }): Promise<{ id: string; provider?: string; reference?: string }>;
}
export interface WhatsAppPort {
  send(to: string, body: string, opts?: { type?: SlingMessageType; reference?: string }): Promise<{ id: string; provider?: string; reference?: string }>;
}
export interface RcsPort {
  send(
    to: string,
    body: string,
    opts?: {
      type?: SlingMessageType;
      reference?: string;
      template_type?: 'text' | 'standalone' | 'carousel';
      standalone?: SlingRcsStandaloneCard;
      carousel?: SlingRcsCarouselCard[];
      suggestions?: SlingRcsSuggestion[];
      fallback_sms?: boolean;
    },
  ): Promise<{ id: string; provider?: string; reference?: string }>;
}
export interface TruecallerPort {
  send(to: string, body: string, opts?: { type?: SlingMessageType; ttl?: number; reference?: string }): Promise<{ id: string; provider?: string; reference?: string }>;
}
export interface EmailPort {
  send(to: string, subject: string, html: string, opts?: { reference?: string }): Promise<{ id: string; provider?: string; reference?: string }>;
}
export interface PushPort {
  send(token: string, title: string, body: string, data?: Record<string, string>): Promise<{ id: string }>;
}

/** Termii fallback SMS adapter */
export class TermiiSmsAdapter implements SmsPort {
  private readonly key = process.env.TERMII_API_KEY || '';
  private readonly sender = process.env.TERMII_SENDER || 'KENDIBO';
  async send(to: string, body: string, opts?: { type?: SlingMessageType; reference?: string }): Promise<{ id: string; provider?: string; reference?: string }> {
    if (!this.key) {
      // Never log message bodies outside dev: they carry OTPs and personal data.
      if (process.env.NODE_ENV === 'production') throw new Error('SMS_NOT_CONFIGURED');
      console.log(`[sms:dev] -> ${to}: ${body}`);
      return { id: `dev_sms_${Date.now()}`, provider: 'termii-dev', reference: opts?.reference };
    }
    const channel = opts?.type === 'otp' || opts?.type === 'transactional' ? 'dnd' : 'generic';
    const r = await fetch('https://api.ng.termii.com/api/sms/send', {
      method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to, from: this.sender, sms: body, type: 'plain', channel, api_key: this.key }),
    });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) throw new Error(String(j.message ?? `Termii HTTP ${r.status}`));
    return { id: String(j.message_id ?? ''), provider: 'termii', reference: opts?.reference };
  }
}

/**
 * Sling Primary SMS Adapter (`POST https://app.sling.com.ng/api/v2/send` with `channel: 'sms'`)
 * Automatically falls back to Termii if SLING_API_TOKEN is unset and TERMII_API_KEY is present.
 */
export class SlingSmsAdapter implements SmsPort {
  constructor(
    private readonly client: SlingClient = slingClient,
    private readonly fallback: SmsPort = new TermiiSmsAdapter(),
  ) {}

  async send(to: string, body: string, opts?: { type?: SlingMessageType; reference?: string }): Promise<{ id: string; provider?: string; reference?: string }> {
    if (!this.client.isConfigured() && process.env.TERMII_API_KEY) {
      return this.fallback.send(to, body, opts);
    }
    try {
      const res = await this.client.sendSms({
        to,
        message: body,
        type: opts?.type ?? 'transactional',
        reference: opts?.reference,
      });
      return { id: res.message_id, provider: res.simulated ? 'sling-sim' : 'sling', reference: res.reference };
    } catch (err) {
      if (process.env.TERMII_API_KEY) {
        return this.fallback.send(to, body, opts);
      }
      throw err;
    }
  }
}

/** Sling WhatsApp Business Adapter (`POST https://app.sling.com.ng/api/v2/send` with `channel: 'whatsapp'`) */
export class SlingWhatsAppAdapter implements WhatsAppPort {
  constructor(private readonly client: SlingClient = slingClient) {}

  async send(to: string, body: string, opts?: { type?: SlingMessageType; reference?: string }): Promise<{ id: string; provider?: string; reference?: string }> {
    const res = await this.client.sendWhatsApp({
      to,
      message: body,
      type: opts?.type ?? 'transactional',
      reference: opts?.reference,
    });
    return { id: res.message_id, provider: res.simulated ? 'sling-whatsapp-sim' : 'sling-whatsapp', reference: res.reference };
  }
}

/** Sling RCS Rich Card & Suggestion Chip Adapter (`POST https://app.sling.com.ng/api/v2/send-rcs`) */
export class SlingRcsAdapter implements RcsPort {
  constructor(private readonly client: SlingClient = slingClient) {}

  async send(
    to: string,
    body: string,
    opts?: {
      type?: SlingMessageType;
      reference?: string;
      template_type?: 'text' | 'standalone' | 'carousel';
      standalone?: SlingRcsStandaloneCard;
      carousel?: SlingRcsCarouselCard[];
      suggestions?: SlingRcsSuggestion[];
      fallback_sms?: boolean;
    },
  ): Promise<{ id: string; provider?: string; reference?: string }> {
    const res = await this.client.sendRcs({
      to,
      message: body,
      type: opts?.type ?? 'transactional',
      template_type: opts?.template_type,
      standalone: opts?.standalone,
      carousel: opts?.carousel,
      suggestions: opts?.suggestions,
      fallback_sms: opts?.fallback_sms ?? true,
      reference: opts?.reference,
    });
    return { id: res.message_id, provider: res.simulated ? 'sling-rcs-sim' : 'sling-rcs', reference: res.reference };
  }
}

/** Sling Truecaller Verified Business Alert Adapter (`POST https://app.sling.com.ng/api/v2/send-truecaller`) */
export class SlingTruecallerAdapter implements TruecallerPort {
  constructor(private readonly client: SlingClient = slingClient) {}

  async send(to: string, body: string, opts?: { type?: SlingMessageType; ttl?: number; reference?: string }): Promise<{ id: string; provider?: string; reference?: string }> {
    const res = await this.client.sendTruecaller({
      to,
      message: body,
      type: opts?.type ?? 'transactional',
      ttl: opts?.ttl ?? 300,
      fallback_sms: true,
      reference: opts?.reference,
    });
    return { id: res.message_id, provider: res.simulated ? 'sling-truecaller-sim' : 'sling-truecaller', reference: res.reference };
  }
}

/**
 * Email adapter:
 *   1. Direct SMTP via Nodemailer when `SMTP_HOST` + `SMTP_USER` + `SMTP_PASS` are set
 *   2. Sling Email (`POST /api/v2/send-email`) when `SLING_API_TOKEN` is set
 *   3. Resend HTTP API when `RESEND_API_KEY` is set
 *   4. Structured console log in local dev
 */
export class ResendEmailAdapter implements EmailPort {
  private readonly smtpHost = process.env.SMTP_HOST || '';
  private readonly smtpPort = Number(process.env.SMTP_PORT || 465);
  private readonly smtpSecure = (process.env.SMTP_SECURE ?? 'true') !== 'false';
  private readonly smtpUser = process.env.SMTP_USER || '';
  private readonly smtpPass = process.env.SMTP_PASS || '';
  private readonly resendKey = process.env.RESEND_API_KEY || '';
  private readonly from = process.env.EMAIL_FROM || (this.smtpUser ? `KENDIBO <${this.smtpUser}>` : 'KENDIBO <hello@kendibo.com>');
  private transporter: Transporter | null = null;

  constructor(private readonly sling: SlingClient = slingClient) {}

  private smtp(): Transporter | null {
    if (!this.smtpHost || !this.smtpUser || !this.smtpPass) return null;
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: this.smtpHost,
        port: this.smtpPort,
        secure: this.smtpSecure,
        auth: { user: this.smtpUser, pass: this.smtpPass },
        connectionTimeout: 10_000,
        socketTimeout: 15_000,
      });
    }
    return this.transporter;
  }

  async send(to: string, subject: string, html: string, opts?: { reference?: string }): Promise<{ id: string; provider?: string; reference?: string }> {
    const t = this.smtp();
    if (t) {
      const info = await t.sendMail({ from: this.from, to, subject, html });
      return { id: String(info.messageId || `smtp_${Date.now()}`), provider: 'smtp', reference: opts?.reference };
    }
    if (this.sling.isConfigured()) {
      const res = await this.sling.sendEmail({ to, subject, message: html, reference: opts?.reference });
      return { id: res.message_id, provider: 'sling-email', reference: res.reference };
    }
    if (this.resendKey) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST', signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${this.resendKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: this.from, to: [to], subject, html }),
      });
      const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (!r.ok) throw new Error(String(j.message ?? `Resend HTTP ${r.status}`));
      return { id: String(j.id ?? ''), provider: 'resend', reference: opts?.reference };
    }
    console.log(`[email:dev] -> ${to} | ${subject}`);
    return { id: `dev_email_${Date.now()}`, provider: 'email-dev', reference: opts?.reference };
  }
}

/**
 * Push adapter — Firebase Admin SDK (HTTP v1) primary, legacy server-key fallback,
 * structured log in dev when neither credential is configured.
 */
export class FcmPushAdapter implements PushPort {
  private readonly legacyKey = process.env.FCM_SERVER_KEY || '';
  private readonly saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '';
  private readonly saPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || '';
  private adminReady: Promise<import('firebase-admin').app.App | null> | null = null;

  private getAdmin(): Promise<import('firebase-admin').app.App | null> {
    if (this.adminReady) return this.adminReady;
    this.adminReady = (async () => {
      if (!this.saJson && !this.saPath) return null;
      try {
        const admin = await import('firebase-admin');
        if (admin.apps.length) return admin.apps[0]!;
        const credential = this.saJson
          ? admin.credential.cert(JSON.parse(this.saJson))
          : admin.credential.applicationDefault();
        return admin.initializeApp({ credential });
      } catch (e) {
        console.warn('[push:fcm] firebase-admin init failed, falling back:', (e as Error).message);
        return null;
      }
    })();
    return this.adminReady;
  }

  async send(token: string, title: string, body: string, data: Record<string, string> = {}): Promise<{ id: string }> {
    const app = await this.getAdmin();
    if (app) {
      const admin = await import('firebase-admin');
      const id = await admin.messaging(app).send({
        token,
        notification: { title, body },
        data,
        android: { priority: 'high', notification: { channelId: 'kendibo_default', sound: 'default' } },
        apns: { payload: { aps: { sound: 'default' } } },
      });
      return { id };
    }
    if (this.legacyKey) {
      const r = await fetch('https://fcm.googleapis.com/fcm/send', {
        method: 'POST', signal: AbortSignal.timeout(10_000),
        headers: { authorization: `key=${this.legacyKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ to: token, notification: { title, body }, data }),
      });
      const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      return { id: String(j.multicast_id ?? `fcm_${Date.now()}`) };
    }
    console.log(`[push:dev] -> ${token.slice(0, 12)}…: ${title} — ${body}`);
    return { id: `dev_push_${Date.now()}` };
  }
}

export const sms: SmsPort = new SlingSmsAdapter();
export const whatsapp: WhatsAppPort = new SlingWhatsAppAdapter();
export const rcs: RcsPort = new SlingRcsAdapter();
export const truecaller: TruecallerPort = new SlingTruecallerAdapter();
export const email: EmailPort = new ResendEmailAdapter();
export const push: PushPort = new FcmPushAdapter();

