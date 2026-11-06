/**
 * Sling (HelloSling / SlingAfrica) Omnichannel Communications & Automation Connector
 * Official API Docs:
 *   - https://docs.hellosling.com/v2/introduction
 *   - https://docs.hellosling.com/v2/api-reference/send
 *   - https://sling.com.ng/solution/automation
 *
 * Supports:
 *   - SMS, WhatsApp, RCS (Rich Cards + Interactive Suggestion Chips), Truecaller, Email
 *   - Single transactional/OTP alerts & scheduled/immediate bulk promotional campaigns
 *   - Contact & Audience Group synchronization (/create-group, /add-contacts, /upsert-contact)
 *   - Visual Workflow Form Automation enrollment (/forms/{formId}/submit)
 *   - Phone Carrier/HLR lookup (/phone-number-check) & RCS capability check (/rcs-capability-check)
 *   - Delivery status tracking (/status/{message_id}) & account balance (/balance, /details)
 */
import crypto from 'crypto';

export type SlingChannel = 'sms' | 'whatsapp' | 'rcs' | 'truecaller' | 'email';
export type SlingMessageType = 'transactional' | 'promotional' | 'otp';
export type SlingSendMode = 'single' | 'campaign';

export interface SlingRcsSuggestion {
  type: 'reply' | 'open_url' | 'dial' | 'share_location' | 'calendar_event';
  text: string;
  postback_data?: string;
  url?: string;
  phone_number?: string;
  start_time?: string;
  end_time?: string;
  title?: string;
  description?: string;
}

export interface SlingRcsStandaloneCard {
  title: string;
  description: string;
  image?: string;
  orientation?: 'VERTICAL' | 'HORIZONTAL';
  alignment?: 'LEFT' | 'RIGHT';
}

export interface SlingRcsCarouselCard {
  title: string;
  description: string;
  image?: string;
}

export interface SlingSendRequest {
  channel: SlingChannel;
  sender?: string;
  message: string;
  subject?: string;
  type?: SlingMessageType;
  mode?: SlingSendMode;
  campaign_name?: string;
  to?: string;
  contact?: number | string;
  contacts?: Array<number | string>;
  group?: number | string;
  groups?: Array<number | string>;
  numbers?: string;
  callback?: string;
  reference?: string;
  send_on?: string;
  // RCS rich fields
  template_type?: 'text' | 'standalone' | 'carousel';
  standalone?: SlingRcsStandaloneCard;
  carousel?: SlingRcsCarouselCard[];
  suggestions?: SlingRcsSuggestion[];
  fallback_sms?: boolean;
  fallback_sms_sender?: string;
  // Truecaller fields
  ttl?: number;
}

export interface SlingSendResponse {
  status: string;
  message_id: string;
  reference: string;
  channel: SlingChannel;
  recipient?: string;
  credit_used?: number;
  simulated?: boolean;
  raw?: Record<string, unknown>;
}

export interface SlingContactPayload {
  name?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  phone: string;
  identifier?: string;
  description?: string;
  group?: number | string;
}

export interface SlingGroupPayload {
  name: string;
  identifier?: string;
  description?: string;
}

export interface SlingPhoneLookupResult {
  status: string;
  number: string;
  network: string;
  country: string;
  ported?: boolean;
  simulated?: boolean;
}

export interface SlingRcsCapabilityResult {
  status: string;
  phone: string;
  rcs_enabled: boolean;
  capabilities: string[];
  simulated?: boolean;
}

export function normalizeNigerianPhone(raw: string): string {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  if (trimmed.includes('@')) return trimmed; // email address
  const digits = trimmed.replace(/[^\d+]/g, '');
  if (digits.startsWith('+234')) return digits;
  if (digits.startsWith('234') && digits.length >= 13) return `+${digits}`;
  if (digits.startsWith('0') && digits.length === 11) return `+234${digits.slice(1)}`;
  if (digits.length === 10 && /^[789][01]\d{8}$/.test(digits)) return `+234${digits}`;
  return digits.startsWith('+') ? digits : `+${digits}`;
}

export function detectNigerianCarrier(phone: string): string {
  const norm = normalizeNigerianPhone(phone).replace(/^\+234/, '0');
  const prefix = norm.slice(0, 4);
  const mtn = new Set(['0803', '0806', '0703', '0706', '0813', '0816', '0810', '0814', '0903', '0906', '0913', '0916', '0704']);
  const airtel = new Set(['0802', '0808', '0708', '0812', '0701', '0902', '0901', '0904', '0907', '0912']);
  const glo = new Set(['0805', '0807', '0705', '0815', '0811', '0905', '0915']);
  const nineMobile = new Set(['0809', '0818', '0817', '0909', '0908']);
  if (mtn.has(prefix)) return 'MTN Nigeria';
  if (airtel.has(prefix)) return 'Airtel Nigeria';
  if (glo.has(prefix)) return 'Globacom (Glo)';
  if (nineMobile.has(prefix)) return '9mobile';
  return 'NG-Mobile';
}

export class SlingClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly v1BaseUrl: string;
  private readonly appUrl: string;
  public readonly senders: {
    sms: string;
    whatsapp: string;
    rcs: string;
    truecaller: string;
    email: string;
  };

  constructor(opts?: {
    token?: string;
    baseUrl?: string;
    v1BaseUrl?: string;
    appUrl?: string;
    senders?: Partial<SlingClient['senders']>;
  }) {
    this.token = (opts?.token ?? process.env.SLING_API_TOKEN ?? '').trim();
    this.baseUrl = (opts?.baseUrl ?? process.env.SLING_BASE_URL ?? 'https://app.sling.com.ng/api/v2').replace(/\/+$/, '');
    this.v1BaseUrl = (opts?.v1BaseUrl ?? process.env.SLING_V1_BASE_URL ?? 'https://app.sling.com.ng/api/v1').replace(/\/+$/, '');
    this.appUrl = (opts?.appUrl ?? process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
    this.senders = {
      sms: opts?.senders?.sms ?? process.env.SLING_SMS_SENDER ?? 'Kendibo',
      whatsapp: opts?.senders?.whatsapp ?? process.env.SLING_WHATSAPP_SENDER ?? 'Kendibo',
      rcs: opts?.senders?.rcs ?? process.env.SLING_RCS_SENDER ?? 'Kendibo',
      truecaller: opts?.senders?.truecaller ?? process.env.SLING_TRUECALLER_SENDER ?? 'Kendibo',
      email: opts?.senders?.email ?? process.env.SLING_EMAIL_SENDER ?? 'hello@kendibo.com',
    };
  }

  public isConfigured(): boolean {
    return this.token.length > 0;
  }

  public defaultCallbackUrl(): string {
    return `${this.appUrl}/webhooks/sling`;
  }

  private async request<T = Record<string, unknown>>(
    path: string,
    opts: { method?: 'GET' | 'POST'; body?: Record<string, unknown>; apiVersion?: 'v2' | 'v1' } = {},
  ): Promise<T> {
    const method = opts.method ?? 'POST';
    const root = opts.apiVersion === 'v1' ? this.v1BaseUrl : this.baseUrl;
    const url = `${root}${path.startsWith('/') ? path : `/${path}`}`;

    let lastErr: Error | null = null;
    // A POST may have been accepted even when its response is lost. Retrying it
    // without a provider-guaranteed idempotency key can send duplicate messages.
    const maxAttempts = method === 'GET' ? 3 : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch(url, {
          method,
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.token}`,
          },
          body: method === 'POST' && opts.body ? JSON.stringify(opts.body) : undefined,
        });
        const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
          const msg = String(json.message ?? json.error ?? `Sling HTTP ${res.status}`);
          if (res.status >= 500 || res.status === 429) {
            lastErr = new Error(msg);
            await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
            continue;
          }
          throw new Error(msg);
        }
        if (String(json.status ?? '').toLowerCase() === 'fail' || json.status === false) {
          throw new Error(String(json.message ?? json.error ?? 'Sling request failed'));
        }
        return json as T;
      } catch (e) {
        lastErr = e as Error;
        if (attempt < maxAttempts - 1) {
          await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
          continue;
        }
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastErr ?? new Error('Sling request failed');
  }

  /**
   * Universal Multi-Channel Send (`POST /api/v2/send`)
   * Supports single recipient (`to` / `contact`) and bulk campaign (`group` / `groups[]` / `contacts[]` / `numbers`).
   */
  public async sendUniversal(req: SlingSendRequest): Promise<SlingSendResponse> {
    const reference = req.reference || `slg_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
    const sender = req.sender || this.senders[req.channel] || 'Kendibo';
    const normalizedTo = req.to ? (req.channel === 'email' ? req.to.trim() : normalizeNigerianPhone(req.to)) : undefined;

    const payload: Record<string, unknown> = {
      channel: req.channel,
      sender,
      message: req.message,
      type: req.type ?? 'transactional',
      mode: req.mode ?? (req.group || req.groups || req.contacts || req.numbers ? 'campaign' : 'single'),
      callback: req.callback ?? this.defaultCallbackUrl(),
      reference,
    };

    if (normalizedTo) payload.to = normalizedTo;
    if (req.subject) payload.subject = req.subject;
    if (req.campaign_name) payload.campaign_name = req.campaign_name;
    if (req.contact !== undefined) payload.contact = req.contact;
    if (req.contacts?.length) payload.contacts = req.contacts;
    if (req.group !== undefined) payload.group = req.group;
    if (req.groups?.length) payload.groups = req.groups;
    if (req.numbers) payload.numbers = req.numbers;
    if (req.send_on) payload.send_on = req.send_on;
    if (req.template_type) payload.template_type = req.template_type;
    if (req.standalone) payload.standalone = req.standalone;
    if (req.carousel) payload.carousel = req.carousel;
    if (req.suggestions?.length) payload.suggestions = req.suggestions;
    if (req.fallback_sms !== undefined) payload.fallback_sms = req.fallback_sms;
    if (req.fallback_sms_sender) payload.fallback_sms_sender = req.fallback_sms_sender;
    if (req.ttl !== undefined) payload.ttl = req.ttl;

    if (!this.isConfigured()) {
      if (process.env.NODE_ENV === 'production') throw new Error('SLING_NOT_CONFIGURED');
      const simId = `sim_${req.channel}_${crypto.randomBytes(6).toString('hex')}`;
      console.log(
        `[sling:sim:${req.channel}] to=${normalizedTo ?? req.group ?? 'bulk'} type=${payload.type} ref=${reference} msg=${req.message.slice(0, 90)}`,
      );
      return {
        status: req.send_on ? 'scheduled' : 'sent',
        message_id: simId,
        reference,
        channel: req.channel,
        recipient: normalizedTo,
        credit_used: 1,
        simulated: true,
        raw: payload,
      };
    }

    let raw: Record<string, unknown>;
    try {
      raw = await this.request<Record<string, unknown>>('/send', { method: 'POST', body: payload });
    } catch (err) {
      if (
        req.channel === 'sms' &&
        payload.type !== 'promotional' &&
        err instanceof Error &&
        /cannot send a (transactional|otp) with this sender/i.test(err.message)
      ) {
        payload.type = 'promotional';
        raw = await this.request<Record<string, unknown>>('/send', { method: 'POST', body: payload });
      } else {
        throw err;
      }
    }
    const dataObj = (raw.data as Record<string, unknown> | undefined) ?? raw;
    return {
      status: String(dataObj.status ?? raw.status ?? 'sent'),
      message_id: String(dataObj.message_id ?? dataObj.id ?? reference),
      reference: String(dataObj.reference ?? reference),
      channel: req.channel,
      recipient: normalizedTo,
      credit_used: Number(dataObj.credit_used ?? 1),
      simulated: false,
      raw,
    };
  }

  /** Dedicated SMS (`POST /api/v2/send-sms`) */
  public async sendSms(opts: {
    to: string;
    message: string;
    type?: SlingMessageType;
    reference?: string;
    send_on?: string;
    campaign_name?: string;
  }): Promise<SlingSendResponse> {
    return this.sendUniversal({
      channel: 'sms',
      sender: this.senders.sms,
      to: opts.to,
      message: opts.message,
      type: opts.type ?? 'transactional',
      reference: opts.reference,
      send_on: opts.send_on,
      campaign_name: opts.campaign_name,
    });
  }

  /** Dedicated WhatsApp (`POST /api/v2/send-whatsapp`) */
  public async sendWhatsApp(opts: {
    to: string;
    message: string;
    type?: SlingMessageType;
    reference?: string;
    send_on?: string;
    campaign_name?: string;
  }): Promise<SlingSendResponse> {
    return this.sendUniversal({
      channel: 'whatsapp',
      sender: this.senders.whatsapp,
      to: opts.to,
      message: opts.message,
      type: opts.type ?? 'transactional',
      reference: opts.reference,
      send_on: opts.send_on,
      campaign_name: opts.campaign_name,
    });
  }

  /** Dedicated RCS with Rich Card + Suggestion Chips + SMS Fallback (`POST /api/v2/send-rcs`) */
  public async sendRcs(opts: {
    to: string;
    message: string;
    type?: SlingMessageType;
    template_type?: 'text' | 'standalone' | 'carousel';
    standalone?: SlingRcsStandaloneCard;
    carousel?: SlingRcsCarouselCard[];
    suggestions?: SlingRcsSuggestion[];
    fallback_sms?: boolean;
    reference?: string;
  }): Promise<SlingSendResponse> {
    return this.sendUniversal({
      channel: 'rcs',
      sender: this.senders.rcs,
      to: opts.to,
      message: opts.message,
      type: opts.type ?? 'transactional',
      template_type: opts.template_type ?? (opts.standalone ? 'standalone' : opts.carousel ? 'carousel' : 'text'),
      standalone: opts.standalone,
      carousel: opts.carousel,
      suggestions: opts.suggestions,
      fallback_sms: opts.fallback_sms ?? true,
      fallback_sms_sender: this.senders.sms,
      reference: opts.reference,
    });
  }

  /** Dedicated Truecaller Verified Business Alert (`POST /api/v2/send-truecaller`) */
  public async sendTruecaller(opts: {
    to: string;
    message: string;
    type?: SlingMessageType;
    ttl?: number;
    fallback_sms?: boolean;
    reference?: string;
  }): Promise<SlingSendResponse> {
    return this.sendUniversal({
      channel: 'truecaller',
      sender: this.senders.truecaller,
      to: opts.to,
      message: opts.message,
      type: opts.type ?? 'transactional',
      ttl: opts.ttl ?? 300,
      fallback_sms: opts.fallback_sms ?? true,
      fallback_sms_sender: this.senders.sms,
      reference: opts.reference,
    });
  }

  /** Dedicated Email (`POST /api/v2/send-email`) */
  public async sendEmail(opts: {
    to: string;
    subject: string;
    message: string;
    type?: SlingMessageType;
    reference?: string;
  }): Promise<SlingSendResponse> {
    return this.sendUniversal({
      channel: 'email',
      sender: this.senders.email,
      to: opts.to,
      subject: opts.subject,
      message: opts.message,
      type: opts.type ?? 'transactional',
      reference: opts.reference,
    });
  }

  /**
   * Visual Workflow / Form Automation Enrollment (`POST /api/v2/forms/{formId}/submit`)
   * Enrolls a user into a Sling visual automation drip workflow (welcome sequence, quote follow-up, retainer).
   */
  public async submitAutomationForm(
    formId: string,
    payload: {
      name: string;
      email?: string;
      phone: string;
      fields?: Record<string, unknown>;
    },
  ): Promise<{ status: string; formId: string; enrolled: boolean; simulated: boolean }> {
    const cleanPhone = normalizeNigerianPhone(payload.phone);
    if (!this.isConfigured() || !formId || formId.startsWith('sim_')) {
      if (process.env.NODE_ENV === 'production') throw new Error('SLING_FORM_NOT_CONFIGURED');
      console.log(`[sling:sim:form] form=${formId || 'default_onboarding'} phone=${cleanPhone} name=${payload.name}`);
      return { status: 'success', formId: formId || 'default_onboarding', enrolled: true, simulated: true };
    }
    const res = await this.request<Record<string, unknown>>(`/forms/${encodeURIComponent(formId)}/submit`, {
      method: 'POST',
      body: {
        name: payload.name,
        email: payload.email,
        phone: cleanPhone,
        ...(payload.fields ?? {}),
      },
    });
    return {
      status: String(res.status ?? 'success'),
      formId,
      enrolled: true,
      simulated: false,
    };
  }

  /** Upsert Contact (`POST /api/v2/upsert-contact`) */
  public async upsertContact(contact: SlingContactPayload): Promise<{ id: string; phone: string; simulated: boolean }> {
    const cleanPhone = normalizeNigerianPhone(contact.phone);
    if (!this.isConfigured()) {
      if (process.env.NODE_ENV === 'production') throw new Error('SLING_NOT_CONFIGURED');
      const id = `slg_cnt_${crypto.createHash('sha1').update(cleanPhone).digest('hex').slice(0, 10)}`;
      return { id, phone: cleanPhone, simulated: true };
    }
    const res = await this.request<Record<string, unknown>>('/upsert-contact', {
      method: 'POST',
      body: {
        ...contact,
        phone: cleanPhone,
      },
    });
    const data = (res.data as Record<string, unknown> | undefined) ?? res;
    return {
      id: String(data.id ?? data.contact_id ?? cleanPhone),
      phone: cleanPhone,
      simulated: false,
    };
  }

  /** Bulk Add Contacts (`POST /api/v2/add-contacts`) */
  public async addContactsBulk(
    contacts: SlingContactPayload[],
    groupId?: string | number,
  ): Promise<{ status: string; imported: number; groupId?: string | number; simulated: boolean }> {
    const normalized = contacts.map((c) => ({
      ...c,
      phone: normalizeNigerianPhone(c.phone),
      ...(groupId ? { group: groupId } : {}),
    }));
    if (!this.isConfigured()) {
      if (process.env.NODE_ENV === 'production') throw new Error('SLING_NOT_CONFIGURED');
      return { status: 'success', imported: normalized.length, groupId, simulated: true };
    }
    const res = await this.request<Record<string, unknown>>('/add-contacts', {
      method: 'POST',
      body: {
        contacts: normalized,
        ...(groupId ? { group: groupId } : {}),
      },
    });
    return {
      status: String(res.status ?? 'success'),
      imported: normalized.length,
      groupId,
      simulated: false,
    };
  }

  /** Create Audience Group (`POST /api/v2/create-group`) */
  public async createGroup(group: SlingGroupPayload): Promise<{ id: string; name: string; identifier: string; simulated: boolean }> {
    const identifier = group.identifier || group.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (!this.isConfigured()) {
      if (process.env.NODE_ENV === 'production') throw new Error('SLING_NOT_CONFIGURED');
      const id = `slg_grp_${crypto.createHash('sha1').update(identifier).digest('hex').slice(0, 8)}`;
      return { id, name: group.name, identifier, simulated: true };
    }
    const res = await this.request<Record<string, unknown>>('/create-group', {
      method: 'POST',
      body: {
        name: group.name,
        identifier,
        description: group.description ?? `Kendibo audience segment: ${group.name}`,
      },
    });
    const data = (res.data as Record<string, unknown> | undefined) ?? res;
    return {
      id: String(data.id ?? data.group_id ?? identifier),
      name: group.name,
      identifier,
      simulated: false,
    };
  }

  /** List Audience Groups (`GET /api/v2/groups`) */
  public async listGroups(): Promise<{ groups: Array<{ id: string; name: string; contacts_count?: number }>; simulated: boolean }> {
    if (!this.isConfigured()) {
      if (process.env.NODE_ENV === 'production') throw new Error('SLING_NOT_CONFIGURED');
      return {
        groups: [
          { id: 'slg_grp_customers', name: 'Kendibo Customers', contacts_count: 0 },
          { id: 'slg_grp_providers', name: 'Kendibo Verified Providers', contacts_count: 0 },
          { id: 'slg_grp_retainers', name: 'Kendibo Smart Retainer Subscribers', contacts_count: 0 },
        ],
        simulated: true,
      };
    }
    const res = await this.request<Record<string, unknown>>('/groups', { method: 'GET' });
    const list = Array.isArray(res.data) ? res.data : Array.isArray(res.groups) ? res.groups : [];
    return {
      groups: list.map((g: Record<string, unknown>) => ({
        id: String(g.id ?? g.identifier ?? ''),
        name: String(g.name ?? 'Group'),
        contacts_count: Number(g.contacts_count ?? 0),
      })),
      simulated: false,
    };
  }

  /** Phone Carrier / HLR Check (`POST /api/v2/phone-number-check`) */
  public async checkPhoneNumber(phone: string): Promise<SlingPhoneLookupResult> {
    const norm = normalizeNigerianPhone(phone);
    if (!this.isConfigured()) {
      if (process.env.NODE_ENV === 'production') throw new Error('SLING_NOT_CONFIGURED');
      return {
        status: 'valid',
        number: norm,
        network: detectNigerianCarrier(norm),
        country: norm.startsWith('+234') ? 'NG' : 'INTL',
        ported: false,
        simulated: true,
      };
    }
    const res = await this.request<Record<string, unknown>>('/phone-number-check', {
      method: 'POST',
      body: { phone: norm },
    });
    const data = (res.data as Record<string, unknown> | undefined) ?? res;
    return {
      status: String(data.status ?? 'valid'),
      number: String(data.number ?? norm),
      network: String(data.network ?? detectNigerianCarrier(norm)),
      country: String(data.country ?? 'NG'),
      ported: Boolean(data.ported ?? false),
      simulated: false,
    };
  }

  /** RCS Device Capability Check (`POST /api/v2/rcs-capability-check`) */
  public async checkRcsCapability(phone: string): Promise<SlingRcsCapabilityResult> {
    const norm = normalizeNigerianPhone(phone);
    if (!this.isConfigured()) {
      if (process.env.NODE_ENV === 'production') throw new Error('SLING_NOT_CONFIGURED');
      return {
        status: 'checked',
        phone: norm,
        rcs_enabled: true,
        capabilities: ['RICHCARD_STANDALONE', 'RICHCARD_CAROUSEL', 'ACTION_OPEN_URL', 'ACTION_DIAL', 'ACTION_REPLY'],
        simulated: true,
      };
    }
    const res = await this.request<Record<string, unknown>>('/rcs-capability-check', {
      method: 'POST',
      body: { phone: norm },
    });
    const data = (res.data as Record<string, unknown> | undefined) ?? res;
    return {
      status: String(data.status ?? 'checked'),
      phone: norm,
      rcs_enabled: Boolean(data.rcs_enabled ?? false),
      capabilities: Array.isArray(data.capabilities) ? (data.capabilities as string[]) : [],
      simulated: false,
    };
  }

  /** Check Message Delivery Status (`GET /api/v2/status/{message_id}`) */
  public async getMessageStatus(messageId: string): Promise<{
    message_id: string;
    status: string;
    delivered_at?: string;
    simulated: boolean;
  }> {
    if (!this.isConfigured() || messageId.startsWith('sim_')) {
      if (process.env.NODE_ENV === 'production') throw new Error('SLING_MESSAGE_STATUS_UNAVAILABLE');
      return {
        message_id: messageId,
        status: 'delivered',
        delivered_at: new Date().toISOString(),
        simulated: true,
      };
    }
    const res = await this.request<Record<string, unknown>>(`/status/${encodeURIComponent(messageId)}`, { method: 'GET' });
    const data = (res.data as Record<string, unknown> | undefined) ?? res;
    return {
      message_id: String(data.message_id ?? messageId),
      status: String(data.status_delivery ?? data.status ?? 'sent').toLowerCase(),
      delivered_at: data.delivered_at ? String(data.delivered_at) : undefined,
      simulated: false,
    };
  }

  /** Account Balance & Details (`GET /api/v2/balance`) */
  public async getBalance(): Promise<{ balance: number; currency: string; simulated: boolean }> {
    if (!this.isConfigured()) {
      if (process.env.NODE_ENV === 'production') throw new Error('SLING_NOT_CONFIGURED');
      return { balance: 25000, currency: 'NGN', simulated: true };
    }
    const res = await this.request<Record<string, unknown>>('/balance', { method: 'GET' });
    const data = (res.data as Record<string, unknown> | undefined) ?? res;
    return {
      balance: Number(data.balance ?? data.units ?? 0),
      currency: String(data.currency ?? 'NGN'),
      simulated: false,
    };
  }
}

export const slingClient = new SlingClient();
