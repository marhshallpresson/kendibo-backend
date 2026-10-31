/**
 * SlingOmnichannelAutomationService
 * Orchestrates:
 *   1. Event-driven operational & transactional automations (OTP, welcome, booking lifecycle, quotes, payments, payouts, KYC)
 *   2. Sling Contact & Audience Group synchronization + Visual Form Workflow enrollment (/api/v2/forms/{formId}/submit)
 *   3. AI-Assisted CTA Campaigns & Customer Retainers (recurring maintenance & win-back cadences)
 *   4. Bulk Promotional & Communications Alert Campaigns (/api/v2/send mode="campaign" + Push + In-App)
 *   5. Real-time Sling Webhook Delivery Receipt reconciliation (POST /webhooks/sling)
 */
import { v4 as uuid } from 'uuid';
import { q } from '../../packages/database/db.js';
import { notificationService, NotificationService, type NotificationChannel } from './notification.service.js';
import { SlingClient, slingClient, normalizeNigerianPhone, type SlingChannel } from './sling.client.js';
import { AiCtaRetainerService, aiCtaService, type AiCtaCampaignGoal, type AiCtaGeneratedVariant } from './ai-cta.service.js';

export type RetainerCadence = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'winback_14d' | 'winback_30d';

export interface CustomerRetainer {
  id: string;
  userId: string;
  propertyId?: string | null;
  serviceId: string;
  serviceName: string;
  cadence: RetainerCadence;
  channels: NotificationChannel[];
  aiAssisted: boolean;
  customGoal?: string | null;
  lastCtaLabel?: string | null;
  lastCtaUrl?: string | null;
  nextRunAt: string;
  lastRunAt?: string | null;
  runCount: number;
  status: 'active' | 'paused' | 'completed';
  createdAt: string;
}

export interface BulkCampaignRecord {
  id: string;
  name: string;
  kind: 'bulk_promotional' | 'comms_alert' | 'ai_cta' | 'retainer' | 'automation';
  channels: NotificationChannel[];
  targetSegment: 'all_customers' | 'all_providers' | 'active_retainers' | 'all_users' | 'custom_numbers';
  slingGroupId?: string | null;
  messageBody: string;
  subject?: string | null;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  aiAssisted: boolean;
  aiPrompt?: string | null;
  scheduledAt?: string | null;
  status: 'draft' | 'scheduled' | 'running' | 'completed' | 'failed';
  slingCampaignId?: string | null;
  stats: {
    targeted: number; sent: number; delivered: number; failed: number;
    skippedOptOut?: number; skippedNoConsent?: number;
    /** Per-channel outcome of the last launch; a relaunch only re-sends what failed. */
    channels?: Record<string, 'sent' | 'failed' | 'skipped'>;
  };
  createdBy: string;
  createdAt: string;
}

interface AudienceRow {
  id: string; phone: string | null; email: string | null; name: string | null;
  promo_enabled: boolean | null; sms_enabled: boolean | null; whatsapp_enabled: boolean | null;
  rcs_enabled: boolean | null; push_enabled: boolean | null; email_enabled: boolean | null;
}

function computeNextRunIso(cadence: RetainerCadence, from: Date = new Date()): string {
  const d = new Date(from.getTime());
  switch (cadence) {
    case 'weekly':
      d.setDate(d.getDate() + 7);
      break;
    case 'biweekly':
    case 'winback_14d':
      d.setDate(d.getDate() + 14);
      break;
    case 'quarterly':
      d.setDate(d.getDate() + 90);
      break;
    case 'monthly':
    case 'winback_30d':
    default:
      d.setDate(d.getDate() + 30);
      break;
  }
  return d.toISOString();
}

export class SlingAutomationService {
  constructor(
    private readonly notifications: NotificationService = notificationService,
    private readonly sling: SlingClient = slingClient,
    private readonly aiCta: AiCtaRetainerService = aiCtaService,
  ) {}

  /**
   * Syncs a Kendibo user to Sling Contacts (`/api/v2/upsert-contact`) and optionally
   * enrolls them in a Sling Visual Automation Form (`/api/v2/forms/{formId}/submit`).
   */
  public async syncUserToSling(opts: {
    userId: string;
    phone?: string | null;
    email?: string | null;
    name?: string | null;
    role?: string;
    enrollOnboardingForm?: boolean;
  }): Promise<{ synced: boolean; slingContactId?: string; formEnrolled?: boolean }> {
    const phone = normalizeNigerianPhone(opts.phone || '');
    if (!phone) return { synced: false };

    const parts = String(opts.name || 'Kendibo User').trim().split(/\s+/);
    const firstName = parts[0] || 'Kendibo';
    const lastName = parts.slice(1).join(' ') || 'User';

    const contact = await this.sling.upsertContact({
      name: opts.name || `${firstName} ${lastName}`,
      first_name: firstName,
      last_name: lastName,
      email: opts.email || undefined,
      phone,
      identifier: opts.userId,
      description: `Kendibo ${opts.role || 'CUSTOMER'} (${opts.userId})`,
      group: process.env.SLING_DEFAULT_GROUP_ID || undefined,
    });

    await this.notifications.updateUserPreferences(opts.userId, {
      slingContactId: contact.id,
    });

    let formEnrolled = false;
    if (opts.enrollOnboardingForm) {
      const formId = process.env.SLING_ONBOARDING_FORM_ID || 'kendibo_onboarding_v2';
      const enrolled = await this.sling.submitAutomationForm(formId, {
        name: opts.name || `${firstName} ${lastName}`,
        email: opts.email || undefined,
        phone,
        fields: { userId: opts.userId, role: opts.role || 'CUSTOMER' },
      });
      formEnrolled = enrolled.enrolled;
    }

    return { synced: true, slingContactId: contact.id, formEnrolled };
  }

  /**
   * Bulk-syncs all Kendibo customers & providers into Sling Audience Groups.
   */
  public async syncAudienceGroupsToSling(): Promise<{
    customersGroup: { id: string; imported: number };
    providersGroup: { id: string; imported: number };
  }> {
    const custGrp = await this.sling.createGroup({
      name: 'Kendibo Customers',
      identifier: 'kendibo-customers',
      description: 'All verified Kendibo homeowners and customers',
    });
    const provGrp = await this.sling.createGroup({
      name: 'Kendibo Verified Providers',
      identifier: 'kendibo-providers',
      description: 'All Kendibo technicians and service providers',
    });

    const users = await q<{ id: string; phone: string | null; email: string | null; name: string | null; role: string }>(
      `SELECT id::text, phone, email, name, role FROM identity.users WHERE phone IS NOT NULL`,
    ).catch(() => [] as { id: string; phone: string | null; email: string | null; name: string | null; role: string }[]);

    const custContacts = users
      .filter((u) => u.role !== 'PROVIDER' && u.phone)
      .map((u) => ({
        name: u.name || 'Kendibo Customer',
        email: u.email || undefined,
        phone: u.phone!,
        identifier: u.id,
      }));
    const provContacts = users
      .filter((u) => u.role === 'PROVIDER' && u.phone)
      .map((u) => ({
        name: u.name || 'Kendibo Provider',
        email: u.email || undefined,
        phone: u.phone!,
        identifier: u.id,
      }));

    const cRes = custContacts.length
      ? await this.sling.addContactsBulk(custContacts, custGrp.id)
      : { imported: 0 };
    const pRes = provContacts.length
      ? await this.sling.addContactsBulk(provContacts, provGrp.id)
      : { imported: 0 };

    return {
      customersGroup: { id: custGrp.id, imported: cRes.imported },
      providersGroup: { id: provGrp.id, imported: pRes.imported },
    };
  }

  /**
   * Triggers an event-driven operational or lifecycle automation workflow.
   */
  public async triggerEvent(
    triggerEvent: string,
    recipientId: string,
    vars: Record<string, string> = {},
    opts?: {
      channels?: NotificationChannel[];
      aiGoal?: AiCtaCampaignGoal;
      ctaLabel?: string;
      ctaUrl?: string;
      route?: string;
    },
  ) {
    const ruleRows = await q<{
      channels: NotificationChannel[] | string;
      template: string;
      ai_personalize: boolean;
      active: boolean;
    }>(`SELECT channels, template, ai_personalize, active FROM notification.automation_rule WHERE trigger_event = $1`, [
      triggerEvent,
    ]).catch(() => []);

    const rule = ruleRows[0];
    if (rule && !rule.active) {
      return { triggered: false, reason: 'rule_disabled', results: [] };
    }

    const rawChannels =
      opts?.channels ??
      (rule ? (typeof rule.channels === 'string' ? JSON.parse(rule.channels) : rule.channels) : ['push', 'whatsapp', 'sms']);
    const channels: NotificationChannel[] = Array.isArray(rawChannels) ? rawChannels : ['push', 'whatsapp', 'sms'];
    const template = rule?.template || triggerEvent;
    const shouldAiPersonalize = Boolean(opts?.aiGoal || rule?.ai_personalize);

    let aiVariant: AiCtaGeneratedVariant | undefined;
    if (shouldAiPersonalize && template !== 'otp') {
      aiVariant = await this.aiCta.generateOmnichannelCta({
        goal:
          opts?.aiGoal ??
          (triggerEvent === 'quote.ready'
            ? 'quote_followup'
            : triggerEvent === 'warranty.expiring'
              ? 'warranty_renewal'
              : triggerEvent === 'retainer.due'
                ? 'retainer_maintenance'
                : 'operational_alert'),
        customerName: vars.name,
        serviceName: vars.service,
        customPrompt: vars.body,
        deepLinkRoute: opts?.route,
        ctaUrl: opts?.ctaUrl,
      });
    }

    const category =
      triggerEvent === 'auth.otp'
        ? 'security'
        : triggerEvent.startsWith('booking.') ||
            triggerEvent.startsWith('provider.') ||
            triggerEvent.startsWith('quote.') ||
            triggerEvent.startsWith('payment.')
          ? 'order'
          : triggerEvent.startsWith('retainer.') || triggerEvent.startsWith('warranty.')
            ? 'maint'
            : 'order';

    const dispatch = await this.notifications.sendOmnichannel({
      recipientId,
      channels,
      template,
      vars: {
        ...vars,
        ...(aiVariant && !vars.body ? { title: aiVariant.pushTitle, body: aiVariant.pushBody } : {}),
      },
      category,
      msgType: triggerEvent === 'auth.otp' ? 'otp' : 'transactional',
      ctaLabel: opts?.ctaLabel ?? aiVariant?.ctaLabel,
      ctaUrl: opts?.ctaUrl ?? aiVariant?.ctaUrl,
      route: opts?.route ?? aiVariant?.deepLinkRoute,
      aiAssisted: Boolean(aiVariant),
      rcsCard: aiVariant?.rcsCard,
      rcsSuggestions: aiVariant?.rcsSuggestions,
    });

    return {
      triggered: true,
      triggerEvent,
      template,
      aiAssisted: Boolean(aiVariant),
      ctaLabel: opts?.ctaLabel ?? aiVariant?.ctaLabel,
      ctaUrl: opts?.ctaUrl ?? aiVariant?.ctaUrl,
      results: dispatch.results,
      skippedChannels: dispatch.skippedChannels,
    };
  }

  /**
   * Creates an AI-Assisted Customer Retainer Schedule.
   */
  public async createRetainer(input: {
    userId: string;
    propertyId?: string;
    serviceId: string;
    serviceName: string;
    cadence: RetainerCadence;
    channels?: NotificationChannel[];
    aiAssisted?: boolean;
    customGoal?: string;
  }): Promise<CustomerRetainer> {
    const id = uuid();
    const channels: NotificationChannel[] = input.channels?.length ? input.channels : ['whatsapp', 'push', 'sms'];
    const aiAssisted = input.aiAssisted !== false;
    const nextRunAt = computeNextRunIso(input.cadence);

    const variant = await this.aiCta.generateOmnichannelCta({
      goal: input.cadence.startsWith('winback') ? 'winback_inactive' : 'retainer_maintenance',
      serviceName: input.serviceName,
      customPrompt: input.customGoal,
      deepLinkRoute: '/(tabs)/bookings',
    });

    await q(
      `INSERT INTO notification.retainer_schedule
        (id, user_id, property_id, service_id, service_name, cadence, channels, ai_assisted,
         custom_goal, last_cta_label, last_cta_url, next_run_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active')`,
      [
        id,
        input.userId,
        input.propertyId ?? null,
        input.serviceId,
        input.serviceName,
        input.cadence,
        JSON.stringify(channels),
        aiAssisted,
        input.customGoal ?? null,
        variant.ctaLabel,
        variant.ctaUrl,
        nextRunAt,
      ],
    );

    return {
      id,
      userId: input.userId,
      propertyId: input.propertyId ?? null,
      serviceId: input.serviceId,
      serviceName: input.serviceName,
      cadence: input.cadence,
      channels,
      aiAssisted,
      customGoal: input.customGoal ?? null,
      lastCtaLabel: variant.ctaLabel,
      lastCtaUrl: variant.ctaUrl,
      nextRunAt,
      lastRunAt: null,
      runCount: 0,
      status: 'active',
      createdAt: new Date().toISOString(),
    };
  }

  public async listUserRetainers(userId: string): Promise<CustomerRetainer[]> {
    const rows = await q<Record<string, unknown>>(
      `SELECT * FROM notification.retainer_schedule WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    ).catch(() => [] as Record<string, unknown>[]);
    return rows.map((row) => this.mapRetainerRow(row));
  }

  public async updateRetainer(
    id: string,
    userId: string,
    patch: { status?: 'active' | 'paused' | 'completed'; cadence?: RetainerCadence; channels?: NotificationChannel[] },
  ): Promise<CustomerRetainer | null> {
    const existing = await q<Record<string, unknown>>(
      `SELECT * FROM notification.retainer_schedule WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    if (!existing[0]) return null;
    const current = this.mapRetainerRow(existing[0]);
    const status = patch.status ?? current.status;
    const cadence = patch.cadence ?? current.cadence;
    const channels = patch.channels ?? current.channels;

    await q(
      `UPDATE notification.retainer_schedule
       SET status = $1, cadence = $2, channels = $3, updated_at = now()
       WHERE id = $4 AND user_id = $5`,
      [status, cadence, JSON.stringify(channels), id, userId],
    );

    return {
      ...current,
      status,
      cadence,
      channels,
    };
  }

  /**
   * Immediately executes an AI-Assisted Customer Retainer dispatch across configured channels
   * (WhatsApp, Push, RCS, SMS) and advances `next_run_at`.
   */
  public async triggerRetainerNow(id: string, userId?: string) {
    const rows = userId
      ? await q<Record<string, unknown>>(
          `SELECT * FROM notification.retainer_schedule WHERE id = $1 AND user_id = $2`,
          [id, userId],
        )
      : await q<Record<string, unknown>>(`SELECT * FROM notification.retainer_schedule WHERE id = $1`, [id]);
    const row = rows[0];
    if (!row) return null;

    const retainer = this.mapRetainerRow(row);
    const u = await q<{ name: string | null }>(`SELECT name FROM identity.users WHERE id::text = $1`, [retainer.userId]).catch(
      () => [] as { name: string | null }[],
    );
    const customerName = u[0]?.name || 'Homeowner';

    const variant = await this.aiCta.generateOmnichannelCta({
      goal: retainer.cadence.startsWith('winback') ? 'winback_inactive' : 'retainer_maintenance',
      customerName,
      serviceName: retainer.serviceName,
      discountPct: 10,
      customPrompt: retainer.customGoal || undefined,
      deepLinkRoute: '/(tabs)/bookings',
    });

    const dispatched = await this.notifications.sendOmnichannel({
      recipientId: retainer.userId,
      channels: retainer.channels,
      template: 'ai.retainer.cta',
      vars: {
        name: customerName,
        service: retainer.serviceName,
        title: variant.pushTitle,
        body: variant.whatsappBody,
      },
      category: 'maint',
      msgType: 'transactional',
      ctaLabel: variant.ctaLabel,
      ctaUrl: variant.ctaUrl,
      route: variant.deepLinkRoute,
      aiAssisted: true,
      rcsCard: variant.rcsCard,
      rcsSuggestions: variant.rcsSuggestions,
    });

    const nextRunAt = computeNextRunIso(retainer.cadence);
    await q(
      `UPDATE notification.retainer_schedule
       SET last_run_at = now(), next_run_at = $1, run_count = run_count + 1,
           last_cta_label = $2, last_cta_url = $3, updated_at = now()
       WHERE id = $4`,
      [nextRunAt, variant.ctaLabel, variant.ctaUrl, retainer.id],
    );

    return {
      retainer: {
        ...retainer,
        lastRunAt: new Date().toISOString(),
        nextRunAt,
        runCount: retainer.runCount + 1,
        lastCtaLabel: variant.ctaLabel,
        lastCtaUrl: variant.ctaUrl,
      },
      aiVariant: variant,
      dispatched: dispatched.results,
    };
  }

  public async sweepDueRetainers(): Promise<{ processed: number }> {
    const due = await q<{ id: string }>(
      `SELECT id FROM notification.retainer_schedule WHERE status = 'active' AND next_run_at <= now() LIMIT 50`,
    ).catch(() => [] as { id: string }[]);

    let processed = 0;
    for (const r of due) {
      await this.triggerRetainerNow(r.id);
      processed++;
    }
    return { processed };
  }

  /**
   * Creates and optionally launches a Bulk Promotional, Operational Alert, or AI-Assisted CTA Campaign.
   */
  public async createCampaign(input: {
    name: string;
    kind: BulkCampaignRecord['kind'];
    channels: NotificationChannel[];
    targetSegment?: BulkCampaignRecord['targetSegment'];
    slingGroupId?: string;
    customNumbers?: string[];
    messageBody?: string;
    subject?: string;
    ctaLabel?: string;
    ctaUrl?: string;
    aiAssisted?: boolean;
    aiGoal?: AiCtaCampaignGoal;
    aiPrompt?: string;
    serviceName?: string;
    discountPct?: number;
    scheduledAt?: string;
    autoLaunch?: boolean;
    createdBy?: string;
  }): Promise<{ campaign: BulkCampaignRecord; aiVariant?: AiCtaGeneratedVariant }> {
    const id = uuid();
    const aiAssisted = Boolean(input.aiAssisted || !input.messageBody);
    let aiVariant: AiCtaGeneratedVariant | undefined;

    if (aiAssisted) {
      aiVariant = await this.aiCta.generateOmnichannelCta({
        goal: input.aiGoal ?? (input.kind === 'comms_alert' ? 'operational_alert' : 'seasonal_promo'),
        serviceName: input.serviceName || input.name,
        discountPct: input.discountPct ?? 15,
        customPrompt: input.aiPrompt || input.messageBody,
        ctaUrl: input.ctaUrl,
      });
    }

    const messageBody = input.messageBody || aiVariant?.whatsappBody || aiVariant?.smsBody || input.name;
    const subject = input.subject || aiVariant?.emailSubject || input.name;
    const ctaLabel = input.ctaLabel || aiVariant?.ctaLabel || 'Open KENDIBO';
    const ctaUrl = input.ctaUrl || aiVariant?.ctaUrl || 'https://kendibo.com';
    // 'scheduled' means handed to Sling with send_on; until it is launched it stays a draft.
    const status: BulkCampaignRecord['status'] = 'draft';

    await q(
      `INSERT INTO notification.campaign
        (id, name, kind, channels, target_segment, sling_group_id, message_body, subject,
         cta_label, cta_url, rcs_payload, ai_assisted, ai_prompt, scheduled_at, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        id,
        input.name,
        input.kind,
        JSON.stringify(input.channels),
        input.targetSegment ?? 'all_customers',
        input.slingGroupId ?? null,
        messageBody,
        subject,
        ctaLabel,
        ctaUrl,
        JSON.stringify(aiVariant ? { card: aiVariant.rcsCard, suggestions: aiVariant.rcsSuggestions } : {}),
        aiAssisted,
        input.aiPrompt ?? null,
        input.scheduledAt ?? null,
        status,
        input.createdBy ?? 'admin',
      ],
    );

    let campaign: BulkCampaignRecord = {
      id,
      name: input.name,
      kind: input.kind,
      channels: input.channels,
      targetSegment: input.targetSegment ?? 'all_customers',
      slingGroupId: input.slingGroupId ?? null,
      messageBody,
      subject,
      ctaLabel,
      ctaUrl,
      aiAssisted,
      aiPrompt: input.aiPrompt ?? null,
      scheduledAt: input.scheduledAt ?? null,
      status,
      slingCampaignId: null,
      stats: { targeted: 0, sent: 0, delivered: 0, failed: 0 },
      createdBy: input.createdBy ?? 'admin',
      createdAt: new Date().toISOString(),
    };

    if (input.autoLaunch) {
      campaign = await this.launchCampaign(id, input.customNumbers);
    }

    return { campaign, aiVariant };
  }

  /**
   * Launches a campaign across Sling (`mode: "campaign"`), email, push and the in-app inbox.
   *
   * One-shot: the row is claimed atomically (draft → running), so a double click or a
   * retried request can't send it twice. A failed campaign can be launched again and only
   * what failed goes out: Sling channels that failed, and per-person sends with no
   * successful delivery_log row for this campaign.
   *
   * Audience: active accounts only. Every send skips channels the person turned off;
   * promotional kinds also skip anyone who turned promotions off (or replied STOP), and
   * never go to numbers that don't belong to an account (no consent to market to them,
   * NDPA 2023). A Sling group can't be filtered by our opt-outs, so promotional sends
   * always use the filtered number list.
   */
  public async launchCampaign(campaignId: string, customNumbers?: string[]): Promise<BulkCampaignRecord> {
    const claimed = await q<Record<string, unknown>>(
      `UPDATE notification.campaign SET status = 'running', updated_at = now()
       WHERE id = $1 AND status IN ('draft', 'failed') RETURNING *`,
      [campaignId],
    );
    if (!claimed[0]) {
      const exists = await q<{ status: string }>(`SELECT status FROM notification.campaign WHERE id = $1`, [campaignId]);
      throw new Error(exists[0] ? 'CAMPAIGN_ALREADY_LAUNCHED' : 'CAMPAIGN_NOT_FOUND');
    }
    const campaign = this.mapCampaignRow(claimed[0]);
    const promotional = campaign.kind !== 'comms_alert';
    const msgType = promotional ? 'promotional' : 'transactional';
    const before = campaign.stats.channels ?? {};

    const segment =
      campaign.targetSegment === 'all_providers' ? `AND u.role = 'PROVIDER'`
        : campaign.targetSegment === 'all_customers' ? `AND u.role <> 'PROVIDER'`
          : campaign.targetSegment === 'active_retainers'
            ? `AND u.id::text IN (SELECT user_id FROM notification.retainer_schedule WHERE status = 'active')`
            : '';
    const people = await q<AudienceRow>(
      `SELECT u.id::text AS id, u.phone, u.email, u.name, p.promo_enabled, p.sms_enabled,
              p.whatsapp_enabled, p.rcs_enabled, p.push_enabled, p.email_enabled
       FROM identity.users u LEFT JOIN notification.user_preference p ON p.user_id = u.id::text
       WHERE COALESCE(u.status, 'active') = 'active' ${segment}`,
    );

    let skippedOptOut = 0;
    let skippedNoConsent = 0;
    let audience: AudienceRow[] = people;
    const strangers: string[] = []; // numbers with no account: operational alerts only
    if (customNumbers?.length || campaign.targetSegment === 'custom_numbers') {
      const byPhone = new Map<string, AudienceRow>();
      for (const p of people) {
        const n = normalizeNigerianPhone(p.phone || '');
        if (n) byPhone.set(n, p);
      }
      audience = [];
      for (const n of new Set((customNumbers ?? []).map(normalizeNigerianPhone).filter(Boolean))) {
        const p = byPhone.get(n);
        if (p) audience.push(p);
        else if (promotional) skippedNoConsent++;
        else strangers.push(n);
      }
    }
    if (promotional) {
      const all = audience.length;
      audience = audience.filter((p) => p.promo_enabled !== false);
      skippedOptOut = all - audience.length;
    }
    const allows = (p: AudienceRow, ch: NotificationChannel) =>
      ({ sms: p.sms_enabled, truecaller: p.sms_enabled, whatsapp: p.whatsapp_enabled, rcs: p.rcs_enabled,
        push: p.push_enabled, email: p.email_enabled, inapp: true } as Record<string, boolean | null>)[ch] !== false;

    const channels: Record<string, 'sent' | 'failed' | 'skipped'> = { ...before };
    let slingCampaignId = campaign.slingCampaignId ?? null;
    let sent = 0;
    let failed = 0;

    // 1. Sling bulk channels: one campaign send per channel.
    for (const ch of campaign.channels) {
      if (!['sms', 'whatsapp', 'rcs', 'truecaller'].includes(ch) || before[ch] === 'sent') continue;
      const numbers = [...new Set([
        ...audience.filter((p) => allows(p, ch)).map((p) => normalizeNigerianPhone(p.phone || '')).filter(Boolean),
        ...strangers,
      ])];
      const viaGroup = !promotional && !!campaign.slingGroupId && !customNumbers?.length;
      if (!numbers.length && !viaGroup) { channels[ch] = 'skipped'; continue; }
      try {
        const res = await this.sling.sendUniversal({
          channel: ch as SlingChannel,
          mode: 'campaign',
          campaign_name: campaign.name,
          type: msgType,
          message: campaign.messageBody,
          subject: campaign.subject || campaign.name,
          ...(viaGroup ? { group: campaign.slingGroupId! } : { numbers: numbers.join('\n') }),
          send_on: campaign.scheduledAt || undefined,
          reference: `cmp_${campaign.id.slice(0, 8)}_${ch}`,
        });
        slingCampaignId = res.message_id;
        sent += viaGroup ? 0 : numbers.length;
        channels[ch] = 'sent';
      } catch {
        failed += numbers.length;
        channels[ch] = 'failed';
      }
    }

    // 2. Email, push and in-app go person by person (sendOmnichannel re-checks preferences).
    const perPerson = campaign.channels.filter((c) => (c === 'email' || c === 'push' || c === 'inapp') && before[c] !== 'sent');
    if (perPerson.length) {
      const done = new Set(
        (await q<{ user_id: string; channel: string }>(
          `SELECT user_id, channel FROM notification.delivery_log WHERE campaign_id = $1 AND status = 'sent'`, [campaign.id],
        )).map((r) => `${r.user_id}:${r.channel}`),
      );
      const outcome: Record<string, { ok: number; bad: number }> = {};
      for (const c of perPerson) outcome[c] = { ok: 0, bad: 0 };
      for (const u of audience) {
        const chs = perPerson.filter((c) => allows(u, c) && !done.has(`${u.id}:${c}`) && (c !== 'email' || !!u.email));
        if (!chs.length) continue;
        const res = await this.notifications.sendOmnichannel({
          recipientId: u.id,
          channels: chs,
          template: 'ai.retainer.cta',
          vars: { name: u.name || 'there', title: campaign.subject || campaign.name, body: campaign.messageBody },
          category: promotional ? 'promo' : 'order',
          msgType,
          ctaLabel: campaign.ctaLabel || undefined,
          ctaUrl: campaign.ctaUrl || undefined,
          route: '/(tabs)/bookings',
          aiAssisted: campaign.aiAssisted,
          campaignId: campaign.id,
        });
        for (const n of res.results) {
          if (n.status === 'failed') { outcome[n.channel].bad++; failed++; }
          else { outcome[n.channel].ok++; sent++; }
        }
      }
      for (const c of perPerson) channels[c] = outcome[c].bad ? 'failed' : outcome[c].ok ? 'sent' : 'skipped';
    }

    const stats: BulkCampaignRecord['stats'] = {
      targeted: audience.length + strangers.length,
      sent: campaign.stats.sent + sent, // a relaunch adds to what already went out
      delivered: campaign.stats.delivered,
      failed,
      skippedOptOut,
      skippedNoConsent,
      channels,
    };
    const finalStatus: BulkCampaignRecord['status'] = Object.values(channels).includes('failed')
      ? 'failed'
      : campaign.scheduledAt ? 'scheduled' : 'completed';
    await q(
      `UPDATE notification.campaign SET status = $1, sling_campaign_id = $2, stats = $3, updated_at = now() WHERE id = $4`,
      [finalStatus, slingCampaignId, JSON.stringify(stats), campaign.id],
    );
    return { ...campaign, status: finalStatus, slingCampaignId, stats };
  }

  public async listCampaigns(): Promise<BulkCampaignRecord[]> {
    const rows = await q<Record<string, unknown>>(
      `SELECT * FROM notification.campaign ORDER BY created_at DESC LIMIT 100`,
    ).catch(() => [] as Record<string, unknown>[]);
    return rows.map((row) => this.mapCampaignRow(row));
  }

  public async listAutomationRules() {
    const rows = await q<Record<string, unknown>>(
      `SELECT * FROM notification.automation_rule ORDER BY created_at ASC`,
    ).catch(() => [] as Record<string, unknown>[]);
    return rows.map((r) => ({
      id: String(r.id),
      triggerEvent: String(r.trigger_event),
      name: String(r.name),
      delaySeconds: Number(r.delay_seconds ?? 0),
      channels: typeof r.channels === 'string' ? JSON.parse(r.channels) : r.channels,
      template: String(r.template),
      aiPersonalize: Boolean(r.ai_personalize),
      slingFormId: r.sling_form_id ? String(r.sling_form_id) : null,
      active: Boolean(r.active),
    }));
  }

  /**
   * Reconciles Sling Delivery Webhook Callbacks (`POST /webhooks/sling`).
   */
  public async handleSlingWebhook(payload: Record<string, unknown>): Promise<{
    ok: boolean;
    reference?: string;
    messageId?: string;
    status: string;
  }> {
    const data = (payload.data as Record<string, unknown> | undefined) ?? payload;
    const messageId = data.message_id ? String(data.message_id) : undefined;
    const reference = data.reference ? String(data.reference) : undefined;
    const rawStatus = String(data.status_delivery ?? data.status ?? 'delivered').toLowerCase();
    const status =
      rawStatus.includes('deliv') || rawStatus === 'success'
        ? 'delivered'
        : rawStatus.includes('fail') || rawStatus.includes('undeliv') || rawStatus.includes('reject')
          ? 'failed'
          : 'sent';

    if (reference) {
      await q(
        `UPDATE notification.delivery_log
         SET status = $1, sling_message_id = COALESCE($2, sling_message_id), updated_at = now()
         WHERE reference = $3`,
        [status, messageId ?? null, reference],
      ).catch(() => {});
    } else if (messageId) {
      await q(
        `UPDATE notification.delivery_log
         SET status = $1, updated_at = now()
         WHERE sling_message_id = $2`,
        [status, messageId],
      ).catch(() => {});
    }

    return { ok: true, reference, messageId, status };
  }

  private mapRetainerRow(row: Record<string, unknown>): CustomerRetainer {
    const rawChannels = typeof row.channels === 'string' ? JSON.parse(row.channels) : row.channels;
    return {
      id: String(row.id),
      userId: String(row.user_id),
      propertyId: row.property_id ? String(row.property_id) : null,
      serviceId: String(row.service_id || 'home_cleaning'),
      serviceName: String(row.service_name || 'Preventive Home Maintenance'),
      cadence: String(row.cadence || 'monthly') as RetainerCadence,
      channels: Array.isArray(rawChannels) ? rawChannels : ['whatsapp', 'push', 'sms'],
      aiAssisted: row.ai_assisted !== false,
      customGoal: row.custom_goal ? String(row.custom_goal) : null,
      lastCtaLabel: row.last_cta_label ? String(row.last_cta_label) : null,
      lastCtaUrl: row.last_cta_url ? String(row.last_cta_url) : null,
      nextRunAt: row.next_run_at ? new Date(String(row.next_run_at)).toISOString() : new Date().toISOString(),
      lastRunAt: row.last_run_at ? new Date(String(row.last_run_at)).toISOString() : null,
      runCount: Number(row.run_count ?? 0),
      status: String(row.status || 'active') as CustomerRetainer['status'],
      createdAt: row.created_at ? new Date(String(row.created_at)).toISOString() : new Date().toISOString(),
    };
  }

  private mapCampaignRow(row: Record<string, unknown>): BulkCampaignRecord {
    const rawChannels = typeof row.channels === 'string' ? JSON.parse(row.channels) : row.channels;
    const rawStats = typeof row.stats === 'string' ? JSON.parse(row.stats) : row.stats;
    return {
      id: String(row.id),
      name: String(row.name),
      kind: String(row.kind || 'bulk_promotional') as BulkCampaignRecord['kind'],
      channels: Array.isArray(rawChannels) ? rawChannels : ['sms', 'whatsapp', 'push'],
      targetSegment: String(row.target_segment || 'all_customers') as BulkCampaignRecord['targetSegment'],
      slingGroupId: row.sling_group_id ? String(row.sling_group_id) : null,
      messageBody: String(row.message_body || ''),
      subject: row.subject ? String(row.subject) : null,
      ctaLabel: row.cta_label ? String(row.cta_label) : null,
      ctaUrl: row.cta_url ? String(row.cta_url) : null,
      aiAssisted: Boolean(row.ai_assisted),
      aiPrompt: row.ai_prompt ? String(row.ai_prompt) : null,
      scheduledAt: row.scheduled_at ? new Date(String(row.scheduled_at)).toISOString() : null,
      status: String(row.status || 'draft') as BulkCampaignRecord['status'],
      slingCampaignId: row.sling_campaign_id ? String(row.sling_campaign_id) : null,
      stats: {
        targeted: Number(rawStats?.targeted ?? 0),
        sent: Number(rawStats?.sent ?? 0),
        delivered: Number(rawStats?.delivered ?? 0),
        failed: Number(rawStats?.failed ?? 0),
        skippedOptOut: Number(rawStats?.skippedOptOut ?? 0),
        skippedNoConsent: Number(rawStats?.skippedNoConsent ?? 0),
        channels: rawStats?.channels && typeof rawStats.channels === 'object' ? rawStats.channels : undefined,
      },
      createdBy: String(row.created_by || 'admin'),
      createdAt: row.created_at ? new Date(String(row.created_at)).toISOString() : new Date().toISOString(),
    };
  }
}

export const slingAutomationService = new SlingAutomationService();
