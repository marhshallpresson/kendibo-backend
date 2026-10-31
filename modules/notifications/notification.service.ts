// Notifications — Domain Event -> versioned Template -> Omnichannel Router (Sling + FCM + SMTP).
// Persisted to notification.notification & notification.delivery_log; delivery via BullMQ worker
// and direct Sling API v2 omnichannel dispatch (Push -> WhatsApp -> RCS/Truecaller -> SMS -> Email).
import { v4 as uuid } from 'uuid';
import { enqueue } from '../../packages/queue/queues.js';
import { q } from '../../packages/database/db.js';
import {
  sms as defaultSms,
  whatsapp as defaultWhatsApp,
  rcs as defaultRcs,
  truecaller as defaultTruecaller,
  email as defaultEmail,
  push as defaultPush,
  type SmsPort,
  type WhatsAppPort,
  type RcsPort,
  type TruecallerPort,
  type EmailPort,
  type PushPort,
} from './channels.js';
import { templates } from './mail.templates.js';
import {
  type SlingMessageType,
  type SlingRcsStandaloneCard,
  type SlingRcsSuggestion,
} from './sling.client.js';

export const TEMPLATES = [
  'booking.confirmed',
  'provider.assigned',
  'provider.en_route',
  'provider.arrived',
  'quote.ready',
  'quote.approved',
  'payment.success',
  'payment.failed',
  'wallet.topup',
  'payout.sent',
  'refund.completed',
  'warranty.expiring',
  'kyc.status',
  'ai.retainer.cta',
  'otp',
  'welcome',
] as const;

export type Template = (typeof TEMPLATES)[number];
export type NotificationChannel = 'push' | 'sms' | 'whatsapp' | 'rcs' | 'truecaller' | 'email' | 'inapp';

export interface Notification {
  id: string;
  recipientId: string;
  channel: NotificationChannel;
  template: string;
  status: 'queued' | 'sent' | 'delivered' | 'failed';
  sentAt?: string;
  externalId?: string;
  reference?: string;
  title?: string;
  body?: string;
  ctaLabel?: string;
  ctaUrl?: string;
  route?: string;
  aiAssisted?: boolean;
  read?: boolean;
}

export interface UserNotificationPreferences {
  userId: string;
  order: boolean;
  chat: boolean;
  maint: boolean;
  promo: boolean;
  cashback: boolean;
  push: boolean;
  sms: boolean;
  wa: boolean;
  rcs: boolean;
  email: boolean;
  tips: boolean;
  preferredChannel: 'whatsapp' | 'sms' | 'push' | 'rcs' | 'email';
  slingContactId?: string | null;
}

const COPY_BUILDERS: Record<string, (v: Record<string, string>) => { title: string; body: string }> = {
  otp: (v) => ({
    title: 'Your KENDIBO verification code',
    body: `Your KENDIBO verification code is ${v.code ?? ''}. Expires in 5 minutes. Never share it with anyone.`,
  }),
  welcome: (v) => ({
    title: `Welcome to KENDIBO, ${v.name || 'friend'}!`,
    body: `Hi ${v.name || 'there'}, welcome to KENDIBO — verified home cleaning & maintenance pros with escrow protection.`,
  }),
  'booking.confirmed': (v) => ({
    title: 'Booking confirmed',
    body: `Your ${v.service ?? 'home service'} booking (${v.id ?? v.bookingId ?? ''}) is confirmed for ${v.slot ?? 'the scheduled window'}.`,
  }),
  booking_confirmed: (v) => ({
    title: 'Booking confirmed',
    body: `Your ${v.service ?? 'home service'} booking (${v.id ?? v.bookingId ?? ''}) is confirmed for ${v.slot ?? 'the scheduled window'}.`,
  }),
  'provider.assigned': (v) => ({
    title: 'Verified technician assigned',
    body: `${v.provider ?? 'Your KENDIBO technician'} has accepted your ${v.service ?? 'service'} job and is preparing for dispatch.`,
  }),
  provider_assigned: (v) => ({
    title: 'Verified technician assigned',
    body: `${v.provider ?? 'Your KENDIBO technician'} has accepted your ${v.service ?? 'service'} job and is preparing for dispatch.`,
  }),
  'provider.en_route': (v) => ({
    title: 'Technician is on the way',
    body: `${v.provider ?? 'Your provider'} is en route (${v.eta ?? 'arriving soon'}). Track live in the KENDIBO app.`,
  }),
  provider_en_route: (v) => ({
    title: 'Technician is on the way',
    body: `${v.provider ?? 'Your provider'} is en route (${v.eta ?? 'arriving soon'}). Track live in the KENDIBO app.`,
  }),
  'provider.arrived': (v) => ({
    title: 'Technician has arrived',
    body: `${v.provider ?? 'Your provider'} has arrived at your property gate. Verify their badge in the app.`,
  }),
  provider_arrived: (v) => ({
    title: 'Technician has arrived',
    body: `${v.provider ?? 'Your provider'} has arrived at your property gate. Verify their badge in the app.`,
  }),
  'quote.ready': (v) => ({
    title: 'Quote ready for review',
    body: `A quote of ₦${v.amount ?? ''} is ready on job ${v.jobId ?? ''}. Review & approve in escrow to begin work.`,
  }),
  quote_ready: (v) => ({
    title: 'Quote ready for review',
    body: `A quote of ₦${v.amount ?? ''} is ready on job ${v.jobId ?? ''}. Review & approve in escrow to begin work.`,
  }),
  'quote.approved': (v) => ({
    title: 'Quote approved',
    body: `Your quote for job ${v.jobId ?? ''} has been approved. Work is now underway.`,
  }),
  quote_approved: (v) => ({
    title: 'Quote approved',
    body: `Your quote for job ${v.jobId ?? ''} has been approved. Work is now underway.`,
  }),
  'payment.success': (v) => ({
    title: 'Payment received in escrow',
    body: `₦${v.amount ?? ''} received (ref ${v.ref ?? ''}). Held safely in escrow until job completion.`,
  }),
  payment_confirmed: (v) => ({
    title: 'Payment received in escrow',
    body: `₦${v.amount ?? ''} received (ref ${v.ref ?? ''}). Held safely in escrow until job completion.`,
  }),
  'payment.failed': (v) => ({
    title: 'Payment requires attention',
    body: `We could not complete payment ${v.ref ?? ''}. Tap to retry securely.`,
  }),
  'wallet.topup': (v) => ({
    title: 'Wallet funded successfully',
    body: `₦${v.amount ?? ''} has been credited to your KENDIBO Wallet.`,
  }),
  'payout.sent': (v) => ({
    title: 'Payout disbursed',
    body: `₦${v.amount ?? ''} has been sent to your bank account (ref ${v.ref ?? ''}).`,
  }),
  payout_sent: (v) => ({
    title: 'Payout disbursed',
    body: `₦${v.amount ?? ''} has been sent to your bank account (ref ${v.ref ?? ''}).`,
  }),
  'refund.completed': (v) => ({
    title: 'Refund processed',
    body: `Your refund of ₦${v.amount ?? ''} for booking ${v.bookingId ?? ''} has been processed.`,
  }),
  'warranty.expiring': (v) => ({
    title: 'Warranty & preventive checkup reminder',
    body: `Your warranty on ${v.service ?? 'recent service'} ends soon. Book a preventive tune-up with 1 tap.`,
  }),
  warranty_expiring: (v) => ({
    title: 'Warranty & preventive checkup reminder',
    body: `Your warranty on ${v.service ?? 'recent service'} ends soon. Book a preventive tune-up with 1 tap.`,
  }),
  'kyc.status': (v) => ({
    title: `KYC Verification: ${v.status ?? 'Updated'}`,
    body: v.message || `Your identity verification status is now ${v.status ?? 'updated'}.`,
  }),
  'ai.retainer.cta': (v) => ({
    title: v.title || 'Scheduled Home Maintenance Retainer',
    body: v.body || `Hi ${v.name || 'there'}, your scheduled home maintenance retainer slot is ready.`,
  }),
  ai_retainer_cta: (v) => ({
    title: v.title || 'Scheduled Home Maintenance Retainer',
    body: v.body || `Hi ${v.name || 'there'}, your scheduled home maintenance retainer slot is ready.`,
  }),
};

export class NotificationService {
  constructor(
    private readonly sms: SmsPort = defaultSms,
    private readonly email: EmailPort = defaultEmail,
    private readonly push: PushPort = defaultPush,
    private readonly whatsapp: WhatsAppPort = defaultWhatsApp,
    private readonly rcs: RcsPort = defaultRcs,
    private readonly truecaller: TruecallerPort = defaultTruecaller,
  ) {}

  /**
   * Backward-compatible `dispatch` method used by `/v1/notify` and legacy callers.
   * Also dispatches via Sling SMS / WhatsApp when `phone` is provided.
   */
  public async dispatch(
    template: string,
    to: { userId?: string; push?: string; phone?: string; whatsapp?: string; email?: string },
    vars: Record<string, string> = {},
  ) {
    const channel: NotificationChannel = to.push
      ? 'push'
      : to.whatsapp
        ? 'whatsapp'
        : to.phone
          ? 'sms'
          : to.email
            ? 'email'
            : 'inapp';
    const recipient = to.userId ?? to.phone ?? to.whatsapp ?? to.email ?? 'unknown';
    await q(`INSERT INTO notification.notification (recipient_id, channel, template) VALUES ($1,$2,$3)`, [
      recipient,
      channel,
      `${template}@v1`,
    ]);
    await enqueue('notifications', 'notification.send', {
      template: `${template}@v1`,
      to,
      vars,
      idempotencyKey: `${template}:${JSON.stringify(vars)}`,
    });
    if (to.phone) {
      const render = COPY_BUILDERS[template] ?? ((v: Record<string, string>) => ({ title: template, body: JSON.stringify(v) }));
      const { body } = render(vars);
      await this.sms.send(to.phone, body, { type: 'transactional' }).catch(() => {});
    }
    return { queued: true, template };
  }

  public async getUserPreferences(userId: string): Promise<UserNotificationPreferences> {
    const defaults: UserNotificationPreferences = {
      userId,
      order: true,
      chat: true,
      maint: true,
      promo: true,
      cashback: true,
      push: true,
      sms: true,
      wa: true,
      rcs: true,
      email: true,
      tips: true,
      preferredChannel: 'whatsapp',
      slingContactId: null,
    };
    if (!userId) return defaults;
    try {
      const rows = await q<Record<string, unknown>>(
        `SELECT * FROM notification.user_preference WHERE user_id = $1`,
        [userId],
      );
      const row = rows[0];
      if (!row) return defaults;
      return {
        userId,
        order: row.order_enabled !== false,
        chat: row.chat_enabled !== false,
        maint: row.maint_enabled !== false,
        promo: row.promo_enabled !== false,
        cashback: row.cashback_enabled !== false,
        push: row.push_enabled !== false,
        sms: row.sms_enabled !== false,
        wa: row.whatsapp_enabled !== false,
        rcs: row.rcs_enabled !== false,
        email: row.email_enabled !== false,
        tips: row.tips_enabled !== false,
        preferredChannel: String(row.preferred_channel || 'whatsapp') as UserNotificationPreferences['preferredChannel'],
        slingContactId: row.sling_contact_id ? String(row.sling_contact_id) : null,
      };
    } catch {
      return defaults;
    }
  }

  public async updateUserPreferences(
    userId: string,
    patch: Partial<Omit<UserNotificationPreferences, 'userId'>>,
  ): Promise<UserNotificationPreferences> {
    const current = await this.getUserPreferences(userId);
    const merged: UserNotificationPreferences = {
      ...current,
      ...patch,
      userId,
    };
    await q(`DELETE FROM notification.user_preference WHERE user_id = $1`, [userId]).catch(() => {});
    await q(
      `INSERT INTO notification.user_preference
        (user_id, order_enabled, chat_enabled, maint_enabled, promo_enabled, cashback_enabled,
         push_enabled, sms_enabled, whatsapp_enabled, rcs_enabled, email_enabled, tips_enabled,
         preferred_channel, sling_contact_id, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())`,
      [
        userId,
        merged.order,
        merged.chat,
        merged.maint,
        merged.promo,
        merged.cashback,
        merged.push,
        merged.sms,
        merged.wa,
        merged.rcs,
        merged.email,
        merged.tips,
        merged.preferredChannel,
        merged.slingContactId ?? null,
      ],
    ).catch(() => {});
    return merged;
  }

  public async listInbox(userId: string, limit = 50): Promise<Notification[]> {
    const rows = await q<Record<string, unknown>>(
      `SELECT * FROM notification.notification WHERE recipient_id = $1 ORDER BY created_at DESC NULLS LAST LIMIT $2`,
      [userId, limit],
    ).catch(() => [] as Record<string, unknown>[]);
    return rows.map((r) => ({
      id: String(r.id),
      recipientId: String(r.recipient_id),
      channel: String(r.channel || 'inapp') as NotificationChannel,
      template: String(r.template || 'notification'),
      status: String(r.status || 'sent') as Notification['status'],
      sentAt: r.sent_at ? String(r.sent_at) : r.created_at ? String(r.created_at) : new Date().toISOString(),
      title: r.title ? String(r.title) : String(r.template || 'KENDIBO Update'),
      body: r.body ? String(r.body) : '',
      ctaLabel: r.cta_label ? String(r.cta_label) : undefined,
      ctaUrl: r.cta_url ? String(r.cta_url) : undefined,
      route: r.route ? String(r.route) : undefined,
      aiAssisted: Boolean(r.ai_assisted),
      read: Boolean(r.read),
    }));
  }

  public async markRead(userId: string, notificationId: string): Promise<boolean> {
    const rows = await q(
      `UPDATE notification.notification SET read = TRUE WHERE id = $1 AND recipient_id = $2 RETURNING id`,
      [notificationId, userId],
    ).catch(() => []);
    return rows.length > 0;
  }

  private async resolveContact(recipientId: string): Promise<{ phone?: string; email?: string; name?: string; pushTokens: string[] }> {
    if (recipientId.startsWith('+') || /^\d{10,15}$/.test(recipientId)) {
      return { phone: recipientId, pushTokens: [] };
    }
    if (recipientId.includes('@')) {
      return { email: recipientId, pushTokens: [] };
    }
    const u = await q<{ phone: string | null; email: string | null; name: string | null }>(
      `SELECT phone, email, name FROM identity.users WHERE id::text = $1`,
      [recipientId],
    ).catch(() => []);
    const d = await q<{ push_token: string }>(
      `SELECT push_token FROM identity.device WHERE user_id::text = $1`,
      [recipientId],
    ).catch(() => []);
    return {
      phone: u[0]?.phone ?? undefined,
      email: u[0]?.email ?? undefined,
      name: u[0]?.name ?? undefined,
      pushTokens: d.map((r) => r.push_token),
    };
  }

  public async send(
    recipientId: string,
    channel: NotificationChannel,
    template: string,
    vars: Record<string, string> = {},
    extra?: {
      msgType?: SlingMessageType;
      ctaLabel?: string;
      ctaUrl?: string;
      route?: string;
      aiAssisted?: boolean;
      campaignId?: string;
      rcsCard?: SlingRcsStandaloneCard;
      rcsSuggestions?: SlingRcsSuggestion[];
    },
  ): Promise<Notification> {
    const render =
      COPY_BUILDERS[template] ??
      ((v: Record<string, string>) => ({
        title: v.title || template,
        body: v.body || JSON.stringify(v),
      }));
    const { title, body } = render(vars);
    const id = uuid();
    const reference = `kdb_${channel}_${id.replace(/-/g, '').slice(0, 16)}`;
    const msgType: SlingMessageType =
      template === 'otp' ? 'otp' : extra?.msgType ?? 'transactional';

    let status: Notification['status'] = 'sent';
    let externalId: string | undefined;
    let providerName = 'sling';
    let targetAddress = recipientId;

    try {
      const c = await this.resolveContact(recipientId);
      if (channel === 'sms') {
        const to = c.phone ?? vars.phone ?? recipientId;
        targetAddress = to;
        const r = await this.sms.send(to, body, { type: msgType, reference });
        externalId = r.id;
        providerName = r.provider ?? 'sling';
      } else if (channel === 'whatsapp') {
        const to = c.phone ?? vars.phone ?? recipientId;
        targetAddress = to;
        const r = await this.whatsapp.send(to, body, { type: msgType, reference });
        externalId = r.id;
        providerName = r.provider ?? 'sling-whatsapp';
      } else if (channel === 'rcs') {
        const to = c.phone ?? vars.phone ?? recipientId;
        targetAddress = to;
        const r = await this.rcs.send(to, body, {
          type: msgType,
          reference,
          standalone: extra?.rcsCard,
          suggestions: extra?.rcsSuggestions,
          fallback_sms: true,
        });
        externalId = r.id;
        providerName = r.provider ?? 'sling-rcs';
      } else if (channel === 'truecaller') {
        const to = c.phone ?? vars.phone ?? recipientId;
        targetAddress = to;
        const r = await this.truecaller.send(to, body, { type: msgType, reference });
        externalId = r.id;
        providerName = r.provider ?? 'sling-truecaller';
      } else if (channel === 'email') {
        const to = c.email ?? vars.email ?? recipientId;
        targetAddress = to;
        const mailPiece = templates.newsletter(title, `<p>${body}</p>`, vars.name || c.name || 'there', {
          recipientEmail: to,
        });
        const r = await this.email.send(to, title, mailPiece.html, { reference });
        externalId = r.id;
        providerName = r.provider ?? 'smtp';
      } else if (channel === 'push') {
        const tokens = c.pushTokens.length ? c.pushTokens : vars.pushToken ? [vars.pushToken] : [];
        if (tokens.length === 0) {
          externalId = 'no_device_token';
          providerName = 'fcm-skip';
        } else {
          for (const tk of tokens) {
            const r = await this.push.send(tk, title, body, {
              template,
              ...(extra?.route ? { route: extra.route } : {}),
              ...(extra?.ctaUrl ? { ctaUrl: extra.ctaUrl } : {}),
            });
            externalId = r.id;
          }
          providerName = 'fcm';
        }
      }
    } catch (e) {
      console.warn(`[notify:${channel}] failed for ${recipientId}: ${(e as Error).message}`);
      status = 'failed';
    }

    const n: Notification = {
      id,
      recipientId,
      channel,
      template,
      status,
      sentAt: new Date().toISOString(),
      externalId,
      reference,
      title,
      body,
      ctaLabel: extra?.ctaLabel,
      ctaUrl: extra?.ctaUrl,
      route: extra?.route,
      aiAssisted: Boolean(extra?.aiAssisted),
      read: false,
    };

    await q(
      `INSERT INTO notification.notification
        (id, recipient_id, channel, template, status, sent_at, title, body, cta_label, cta_url, route, kind, ai_assisted)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        n.id,
        n.recipientId,
        n.channel,
        n.template,
        n.status,
        n.sentAt,
        title,
        body,
        extra?.ctaLabel ?? null,
        extra?.ctaUrl ?? null,
        extra?.route ?? null,
        msgType,
        Boolean(extra?.aiAssisted),
      ],
    ).catch(async () => {
      await q(
        `INSERT INTO notification.notification (id, recipient_id, channel, template, status, sent_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [n.id, n.recipientId, n.channel, n.template, n.status, n.sentAt],
      ).catch(() => {});
    });

    await q(
      `INSERT INTO notification.delivery_log
        (id, reference, sling_message_id, user_id, recipient, channel, msg_type, template, campaign_id, status, provider, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        uuid(),
        reference,
        externalId ?? null,
        recipientId,
        targetAddress,
        channel,
        msgType,
        template,
        extra?.campaignId ?? null,
        status,
        providerName,
        JSON.stringify({ title, ctaLabel: extra?.ctaLabel, ctaUrl: extra?.ctaUrl, route: extra?.route }),
      ],
    ).catch(() => {});

    return n;
  }

  public async sendOmnichannel(opts: {
    recipientId: string;
    channels: NotificationChannel[];
    template: string;
    vars?: Record<string, string>;
    category?: 'order' | 'chat' | 'maint' | 'promo' | 'cashback' | 'tips' | 'security';
    msgType?: SlingMessageType;
    ctaLabel?: string;
    ctaUrl?: string;
    route?: string;
    aiAssisted?: boolean;
    campaignId?: string;
    rcsCard?: SlingRcsStandaloneCard;
    rcsSuggestions?: SlingRcsSuggestion[];
  }): Promise<{ results: Notification[]; skippedChannels: string[] }> {
    const prefs = await this.getUserPreferences(opts.recipientId);
    const isCritical = opts.template === 'otp' || opts.category === 'security';
    const skippedChannels: string[] = [];
    const results: Notification[] = [];

    if (!isCritical && opts.category) {
      const catAllowed =
        opts.category === 'order'
          ? prefs.order
          : opts.category === 'chat'
            ? prefs.chat
            : opts.category === 'maint'
              ? prefs.maint
              : opts.category === 'promo'
                ? prefs.promo
                : opts.category === 'cashback'
                  ? prefs.cashback
                  : opts.category === 'tips'
                    ? prefs.tips
                    : true;
      if (!catAllowed) {
        return { results: [], skippedChannels: opts.channels };
      }
    }

    for (const ch of opts.channels) {
      if (!isCritical) {
        const chAllowed =
          ch === 'push'
            ? prefs.push
            : ch === 'sms'
              ? prefs.sms
              : ch === 'whatsapp'
                ? prefs.wa
                : ch === 'rcs'
                  ? prefs.rcs
                  : ch === 'email'
                    ? prefs.email
                    : true;
        if (!chAllowed) {
          skippedChannels.push(ch);
          continue;
        }
      }

      const res = await this.send(opts.recipientId, ch, opts.template, opts.vars ?? {}, {
        msgType: opts.msgType,
        ctaLabel: opts.ctaLabel,
        ctaUrl: opts.ctaUrl,
        route: opts.route,
        aiAssisted: opts.aiAssisted,
        campaignId: opts.campaignId,
        rcsCard: opts.rcsCard,
        rcsSuggestions: opts.rcsSuggestions,
      });
      results.push(res);
    }

    return { results, skippedChannels };
  }
}

export const notificationService = new NotificationService();
