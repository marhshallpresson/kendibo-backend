// WhatsApp Cloud API (Meta Graph) client for the booking assistant.
// Inbound webhooks are authenticated with X-Hub-Signature-256 (HMAC-SHA256 of
// the raw body keyed by the App Secret — NOT the verify token). Outbound calls
// use a System User access token scoped to the WhatsApp Business Account.
// Without credentials (local dev) messages are logged instead of sent.
import crypto from 'node:crypto';

const cfg = () => ({
  token: (process.env.WHATSAPP_ACCESS_TOKEN ?? '').trim(),
  phoneNumberId: (process.env.WHATSAPP_PHONE_NUMBER_ID ?? '').trim(),
  appSecret: (process.env.WHATSAPP_APP_SECRET ?? '').trim(),
  verifyToken: (process.env.WHATSAPP_VERIFY_TOKEN ?? '').trim(),
  version: (process.env.WHATSAPP_GRAPH_VERSION ?? 'v26.0').trim(),
});

/** Send-time values for a template's buttons: a quick-reply payload, or the URL button's variable suffix. */
export type TemplateButton = { index: number; payload: string } | { index: number; urlSuffix: string };

// Customer uploads we accept from WhatsApp: photos, voice notes, short videos, PDFs.
const MEDIA_MIME = /^(image\/(jpeg|png|webp)|audio\/(ogg|mpeg|mp4|aac|amr)|video\/mp4|application\/pdf)$/;
const MEDIA_MAX = 16 * 1024 * 1024;

export const whatsappConfigured = () => !!(cfg().token && cfg().phoneNumberId);

/** GET handshake: Meta sends hub.mode=subscribe, hub.verify_token, hub.challenge. */
export function verifySubscription(query: Record<string, string | undefined>): string | null {
  const { verifyToken } = cfg();
  if (!verifyToken || query['hub.mode'] !== 'subscribe') return null;
  const given = Buffer.from(String(query['hub.verify_token'] ?? ''));
  const want = Buffer.from(verifyToken);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
  return String(query['hub.challenge'] ?? '');
}

/** POST authenticity. Fails closed when the app secret is missing in production. */
export function verifySignature(rawBody: string, header: string | undefined): boolean {
  const { appSecret } = cfg();
  if (!appSecret) return process.env.NODE_ENV !== 'production';
  const sig = String(header ?? '').replace(/^sha256=/, '');
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Interactive limits from the Cloud API: ≤3 reply buttons (title ≤20 chars),
// list rows ≤10 per section (title ≤24, description ≤72), body ≤1024.
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Every message we send is also recorded as an assistant turn (support inbox,
// AI memory). The bot registers the recorder; the client stays storage-free.
type SentHook = (to: string, summary: string) => Promise<void> | void;
let sentHook: SentHook | null = null;
export function onMessageSent(fn: SentHook | null) { sentHook = fn; }
function summarise(p: Record<string, unknown>): string {
  const i = p.interactive as { type?: string; body?: { text?: string }; action?: { buttons?: { reply: { title: string } }[]; button?: string; parameters?: { display_text?: string } } } | undefined;
  if (p.type === 'text') return String((p.text as { body?: string })?.body ?? '');
  if (p.type === 'template') return `[template ${String((p.template as { name?: string })?.name ?? '')}]`;
  if (!i) return `(${String(p.type)})`;
  const extras = i.action?.buttons?.map((b) => b.reply.title) ?? (i.action?.parameters?.display_text ? [i.action.parameters.display_text] : i.action?.button ? [i.action.button] : []);
  return `${i.body?.text ?? ''}${extras.length ? ` [${extras.join(' | ')}]` : ''}`;
}

async function send(to: string, payload: Record<string, unknown>, record = true): Promise<void> {
  const c = cfg();
  if (!c.token || !c.phoneNumberId) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[whatsapp:dev] -> ${to.slice(0, 6)}… ${JSON.stringify(payload).slice(0, 200)}`);
      if (record) await sentHook?.(to, summarise(payload));
      return;
    }
    throw new Error('WHATSAPP_NOT_CONFIGURED');
  }
  const res = await fetch(`https://graph.facebook.com/${c.version}/${c.phoneNumberId}/messages`, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null) as { error?: { code?: unknown } } | null;
    const code = data?.error?.code;
    const suffix = typeof code === 'number' && Number.isSafeInteger(code) && code >= 0 && code < 100_000_000 ? `_META_${code}` : '';
    throw new Error(`WHATSAPP_SEND_${res.status}${suffix}`);
  }
  if (record) await sentHook?.(to, summarise(payload));
}

export const wa = {
  /** `record: false` when the caller stores the turn itself (support replies are kept as "[team] …"). */
  text: (to: string, body: string, opts: { record?: boolean } = {}) => send(to, { type: 'text', text: { preview_url: false, body: clip(body, 4096) } }, opts.record ?? true),

  buttons: (to: string, body: string, buttons: { id: string; title: string }[]) => send(to, {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: clip(body, 1024) },
      action: { buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: clip(b.id, 256), title: clip(b.title, 20) } })) },
    },
  }),

  list: (to: string, body: string, button: string, rows: { id: string; title: string; description?: string }[]) => send(to, {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: clip(body, 1024) },
      action: {
        button: clip(button, 20),
        sections: [{ title: 'Options', rows: rows.slice(0, 10).map((r) => ({ id: clip(r.id, 200), title: clip(r.title, 24), ...(r.description ? { description: clip(r.description, 72) } : {}) })) }],
      },
    },
  }),

  ctaUrl: (to: string, body: string, label: string, url: string) => send(to, {
    type: 'interactive',
    interactive: { type: 'cta_url', body: { text: clip(body, 1024) }, action: { name: 'cta_url', parameters: { display_text: clip(label, 20), url } } },
  }),

  /** Approved template: the only thing we may send outside the 24h window. */
  template: (to: string, name: string, params: string[], buttons: TemplateButton[] = [], language = (process.env.WHATSAPP_TEMPLATE_LANG ?? 'en').trim()) => send(to, {
    type: 'template',
    template: {
      name,
      language: { code: language },
      components: [
        ...(params.length ? [{ type: 'body', parameters: params.map((t) => ({ type: 'text', text: clip(t, 1000) })) }] : []),
        ...buttons.map((b) => ('payload' in b
          ? { type: 'button', sub_type: 'quick_reply', index: String(b.index), parameters: [{ type: 'payload', payload: clip(b.payload, 256) }] }
          : { type: 'button', sub_type: 'url', index: String(b.index), parameters: [{ type: 'text', text: clip(b.urlSuffix, 2000) }] })),
      ],
    },
  }),

  locationRequest: (to: string, body: string) => send(to, {
    type: 'interactive',
    interactive: { type: 'location_request_message', body: { text: clip(body, 1024) }, action: { name: 'send_location' } },
  }),

  /** Typing indicator while the AI works (also marks the message read). */
  typing: async (messageId: string) => {
    const c = cfg();
    if (!c.token || !c.phoneNumberId) return;
    await fetch(`https://graph.facebook.com/${c.version}/${c.phoneNumberId}/messages`, {
      method: 'POST', signal: AbortSignal.timeout(5_000),
      headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId, typing_indicator: { type: 'text' } }),
    }).catch(() => undefined);
  },

  /**
   * Download an inbound photo. Media ids resolve to a short-lived URL that
   * must be fetched with the same bearer token. Capped at 5 MB and images only.
   */
  downloadMedia: async (mediaId: string): Promise<{ bytes: Buffer; mime: string } | null> => {
    const c = cfg();
    if (!c.token) return null;
    const meta = await fetch(`https://graph.facebook.com/${c.version}/${encodeURIComponent(mediaId)}`, {
      signal: AbortSignal.timeout(8_000), headers: { Authorization: `Bearer ${c.token}` },
    });
    if (!meta.ok) return null;
    const m = (await meta.json()) as { url?: string; mime_type?: string; file_size?: number };
    if (!m.url || !MEDIA_MIME.test(String(m.mime_type).split(';')[0].trim()) || Number(m.file_size ?? 0) > MEDIA_MAX) return null;
    // Only follow Meta's own CDN — never an arbitrary URL from a payload.
    if (!/^https:\/\/([a-z0-9-]+\.)*(fbsbx\.com|whatsapp\.net|facebook\.com)\//i.test(m.url)) return null;
    const file = await fetch(m.url, { signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${c.token}` } });
    if (!file.ok) return null;
    const bytes = Buffer.from(await file.arrayBuffer());
    return bytes.length <= MEDIA_MAX ? { bytes, mime: String(m.mime_type).split(';')[0].trim() } : null;
  },

  /** Photo, voice note, video or document by URL (our signed storage link). */
  media: (to: string, kind: 'image' | 'audio' | 'video' | 'document', url: string, caption?: string) => send(to, {
    type: kind,
    [kind]: { link: url, ...(caption && kind !== 'audio' ? { caption: clip(caption, 1024) } : {}) },
  }),

  markRead: async (messageId: string) => {
    const c = cfg();
    if (!c.token || !c.phoneNumberId) return;
    await fetch(`https://graph.facebook.com/${c.version}/${c.phoneNumberId}/messages`, {
      method: 'POST', signal: AbortSignal.timeout(5_000),
      headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }),
    }).catch(() => undefined);
  },
};
