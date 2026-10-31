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
  version: (process.env.WHATSAPP_GRAPH_VERSION ?? 'v21.0').trim(),
});

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

async function send(to: string, payload: Record<string, unknown>): Promise<void> {
  const c = cfg();
  if (!c.token || !c.phoneNumberId) {
    if (process.env.NODE_ENV !== 'production') console.log(`[whatsapp:dev] -> ${to.slice(0, 6)}… ${JSON.stringify(payload).slice(0, 200)}`);
    return;
  }
  const res = await fetch(`https://graph.facebook.com/${c.version}/${c.phoneNumberId}/messages`, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload }),
  });
  if (!res.ok) throw new Error(`WHATSAPP_SEND_${res.status}`);
}

export const wa = {
  text: (to: string, body: string) => send(to, { type: 'text', text: { preview_url: false, body: clip(body, 4096) } }),

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
    if (!m.url || !/^image\/(jpeg|png|webp)$/.test(String(m.mime_type)) || Number(m.file_size ?? 0) > 5 * 1024 * 1024) return null;
    // Only follow Meta's own CDN — never an arbitrary URL from a payload.
    if (!/^https:\/\/([a-z0-9-]+\.)*(fbsbx\.com|whatsapp\.net|facebook\.com)\//i.test(m.url)) return null;
    const file = await fetch(m.url, { signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${c.token}` } });
    if (!file.ok) return null;
    const bytes = Buffer.from(await file.arrayBuffer());
    return bytes.length <= 5 * 1024 * 1024 ? { bytes, mime: String(m.mime_type) } : null;
  },

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
