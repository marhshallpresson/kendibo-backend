// WhatsApp message templates: the only messages we may start outside the 24h
// customer service window. The catalogue below is the reviewed copy (with the
// example values Meta requires). It is submitted to our WhatsApp Business
// Account through the Template API, and its review status comes back on the
// message_template_status_update / template_category_update /
// message_template_quality_update webhooks. A template is only sent once Meta
// has approved it; until then policy.ts falls back to SMS.
//
// Meta rules this copy follows: utility templates are transactional (no
// promotion), a body may not start or end with a variable, every variable has
// an example, quick replies ≤ 25 characters, one URL variable at the end.
import { q } from '../../packages/database/db.js';
import { emit } from '../../packages/observability/emit.js';
import { webBase } from './links.js';

export type TemplateKey = 'job_offer' | 'vendor_accepted' | 'request_update';
export interface TemplateDef { key: TemplateKey; name: string; language: string; category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION'; purpose: string; components: () => Record<string, unknown>[] }
export interface TemplateRow { name: string; language: string; metaId: string | null; category: string | null; status: string; quality: string | null; reason: string | null; updatedAt: string | null }

const LANG = () => (process.env.WHATSAPP_TEMPLATE_LANG ?? 'en').trim() || 'en';
/** Template statuses that can be sent (FLAGGED still sends while quality recovers). */
const SENDABLE = new Set(['APPROVED', 'FLAGGED']);

export function catalogue(): TemplateDef[] {
  return [
    {
      key: 'job_offer', name: process.env.WHATSAPP_TEMPLATE_JOB_OFFER || 'kendibo_job_offer', language: LANG(), category: 'UTILITY',
      purpose: 'Job offer to a vendor who has not messaged us in 24 hours (Accept / Decline)',
      components: () => [
        { type: 'BODY', text: 'New job near you: {{1}}. Tap Accept to take it or Decline to pass. The first verified pro to accept gets the job.', example: { body_text: [['Deep clean, 3-bedroom flat, 2.1 km away']] } },
        { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Accept' }, { type: 'QUICK_REPLY', text: 'Decline' }] },
      ],
    },
    {
      key: 'vendor_accepted', name: process.env.WHATSAPP_TEMPLATE_VENDOR_ACCEPTED || 'kendibo_vendor_accepted', language: LANG(), category: 'UTILITY',
      purpose: 'A vendor accepted the customer\'s request: secure payment link',
      components: () => [
        { type: 'BODY', text: 'Good news: {{1}} accepted your Kendibo job. Pay {{2}} to confirm the booking. Kendibo holds the money until you confirm the job is done.', example: { body_text: [['Ewet Cool Air', '₦15,000']] } },
        { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Pay securely', url: `${webBase()}/w/pay?t={{1}}`, example: ['eyJ3IjoiMjM0ODAxIiwiZCI6ImJrXzEifQ.c2ln'] }] },
      ],
    },
    {
      key: 'request_update', name: process.env.WHATSAPP_TEMPLATE_REQUEST_UPDATE || 'kendibo_request_update', language: LANG(), category: 'UTILITY',
      purpose: 'Any other update about a customer\'s own request after the 24h window closed',
      components: () => [
        { type: 'BODY', text: 'Hi, here is an update on your Kendibo request: {{1}}. Reply to this message if you need help.', example: { body_text: [['A verified vendor accepted your AC repair and will inspect it first']] } },
      ],
    },
  ];
}
export const templateDef = (key: TemplateKey) => catalogue().find((t) => t.key === key)!;

const cfg = () => ({
  token: (process.env.WHATSAPP_ACCESS_TOKEN ?? '').trim(),
  waba: (process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ?? '').trim(),
  version: (process.env.WHATSAPP_GRAPH_VERSION ?? 'v26.0').trim(),
});
export const templateApiConfigured = () => !!(cfg().token && cfg().waba);

async function graph<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<T> {
  const c = cfg();
  const res = await fetch(`https://graph.facebook.com/${c.version}/${path}`, {
    method: init.method ?? 'GET',
    signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${c.token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const j = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number; error_user_msg?: string } } & T;
  if (!res.ok) {
    const msg = String(j.error?.error_user_msg || j.error?.message || `HTTP ${res.status}`).split(c.token).join('[token]');
    throw Object.assign(new Error(`META_${res.status}: ${msg.slice(0, 300)}`), { code: j.error?.code });
  }
  return j;
}

/** Every template on the WhatsApp Business Account (all pages). */
export async function remoteTemplates(): Promise<{ id: string; name: string; language: string; status: string; category: string; quality_score?: { score?: string }; rejected_reason?: string }[]> {
  const out: { id: string; name: string; language: string; status: string; category: string; quality_score?: { score?: string }; rejected_reason?: string }[] = [];
  let path = `${cfg().waba}/message_templates?fields=id,name,language,status,category,quality_score,rejected_reason&limit=100`;
  for (let page = 0; page < 20 && path; page++) {
    const r = await graph<{ data?: typeof out; paging?: { next?: string; cursors?: { after?: string } } }>(path);
    out.push(...(r.data ?? []));
    const after = r.paging?.next ? r.paging.cursors?.after : undefined;
    path = after ? `${cfg().waba}/message_templates?fields=id,name,language,status,category,quality_score,rejected_reason&limit=100&after=${encodeURIComponent(after)}` : '';
  }
  return out;
}

async function upsert(row: { name: string; language: string; metaId?: string | null; category?: string | null; status?: string; quality?: string | null; reason?: string | null }) {
  const updated = await q<{ name: string }>(
    `UPDATE messaging.whatsapp_template SET meta_id=COALESCE($3, meta_id), category=COALESCE($4, category), status=COALESCE($5, status),
            quality=COALESCE($6, quality), reason=COALESCE($7, reason), updated_at=now() WHERE name=$1 AND language=$2 RETURNING name`,
    [row.name, row.language, row.metaId ?? null, row.category ?? null, row.status ?? null, row.quality ?? null, row.reason ?? null],
  );
  if (!updated[0]) {
    await q(`INSERT INTO messaging.whatsapp_template (name, language, meta_id, category, status, quality, reason) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [row.name, row.language, row.metaId ?? null, row.category ?? null, row.status ?? 'NOT_SUBMITTED', row.quality ?? null, row.reason ?? null]);
  }
}

/** Pull review status for every catalogue template from Meta. */
export async function syncTemplateStatuses(): Promise<TemplateRow[]> {
  const remote = await remoteTemplates();
  for (const t of catalogue()) {
    const r = remote.find((x) => x.name === t.name && x.language === t.language);
    await upsert(r
      ? { name: t.name, language: t.language, metaId: r.id, category: r.category, status: r.status, quality: r.quality_score?.score ?? null, reason: r.rejected_reason && r.rejected_reason !== 'NONE' ? r.rejected_reason : null }
      : { name: t.name, language: t.language, status: 'NOT_SUBMITTED' });
  }
  return templateRows();
}

let syncTimer: NodeJS.Timeout | null = null;
/** Refresh approvals and categories even if a Meta webhook was missed. */
export function startTemplateStatusSync(intervalMs = 15 * 60_000): void {
  if (syncTimer || !templateApiConfigured()) return;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await syncTemplateStatuses(); }
    catch { emit('whatsapp.template_sync_failed', {}); }
    finally { running = false; }
  };
  void run();
  syncTimer = setInterval(() => { void run(); }, intervalMs);
  syncTimer.unref?.();
}

/** Submit catalogue templates that Meta doesn't have yet (they start PENDING review). */
export async function submitMissingTemplates(): Promise<{ submitted: string[]; existing: string[]; errors: { name: string; error: string }[] }> {
  const remote = await remoteTemplates();
  const res = { submitted: [] as string[], existing: [] as string[], errors: [] as { name: string; error: string }[] };
  for (const t of catalogue()) {
    if (remote.some((x) => x.name === t.name && x.language === t.language)) { res.existing.push(t.name); continue; }
    try {
      const r = await graph<{ id: string; status: string; category: string }>(`${cfg().waba}/message_templates`, {
        method: 'POST', body: { name: t.name, language: t.language, category: t.category, components: t.components() },
      });
      await upsert({ name: t.name, language: t.language, metaId: r.id, category: r.category ?? t.category, status: r.status ?? 'PENDING' });
      res.submitted.push(t.name);
      emit('whatsapp.template_submitted', { name: t.name });
    } catch (e) {
      res.errors.push({ name: t.name, error: (e as Error).message });
    }
  }
  return res;
}

export async function templateRows(): Promise<TemplateRow[]> {
  const rows = await q<Record<string, unknown>>(`SELECT * FROM messaging.whatsapp_template`).catch(() => []);
  return catalogue().map((t) => {
    const r = rows.find((x) => x.name === t.name && x.language === t.language);
    return {
      name: t.name, language: t.language, metaId: r?.meta_id ? String(r.meta_id) : null, category: r?.category ? String(r.category) : t.category,
      status: r ? String(r.status) : 'NOT_SUBMITTED', quality: r?.quality ? String(r.quality) : null, reason: r?.reason ? String(r.reason) : null,
      updatedAt: r?.updated_at ? new Date(String(r.updated_at)).toISOString() : null,
    };
  });
}

/** The template to send for `key`, or null if Meta hasn't approved it. */
export async function approvedTemplate(key: TemplateKey, allowMarketing = false): Promise<{ name: string; language: string } | null> {
  // The currently approved vendor-accepted copy promises a payment hold whose
  // provider arrangement has not been verified. Use a neutral update instead.
  if (key === 'vendor_accepted') return null;
  const t = templateDef(key);
  const rows = await q<{ status: string; category: string | null }>(`SELECT status, category FROM messaging.whatsapp_template WHERE name=$1 AND language=$2`, [t.name, t.language]).catch(() => []);
  const category = String(rows[0]?.category ?? '').toUpperCase();
  const ok = rows[0] && SENDABLE.has(String(rows[0].status)) && (category === 'UTILITY' || (allowMarketing && key === 'job_offer' && category === 'MARKETING'));
  return ok ? { name: t.name, language: t.language } : null;
}

/**
 * WhatsApp Business Account webhooks about templates. Matched by template id,
 * else by name + language. REINSTATED means approved again.
 */
export async function applyTemplateWebhook(field: string, value: Record<string, unknown>): Promise<void> {
  const name = value.message_template_name ? String(value.message_template_name) : null;
  const language = value.message_template_language ? String(value.message_template_language) : null;
  const metaId = value.message_template_id != null ? String(value.message_template_id) : null;
  let key: { name: string; language: string } | null = name && language ? { name, language } : null;
  if (!key && metaId) {
    const rows = await q<{ name: string; language: string }>(`SELECT name, language FROM messaging.whatsapp_template WHERE meta_id=$1`, [metaId]).catch(() => []);
    key = rows[0] ? { name: String(rows[0].name), language: String(rows[0].language) } : null;
  }
  if (!key) return;
  if (field === 'message_template_status_update') {
    const event = String(value.event ?? '').toUpperCase();
    const reason = value.reason && String(value.reason) !== 'NONE' ? String(value.reason) : null;
    await upsert({ ...key, metaId, status: event === 'REINSTATED' ? 'APPROVED' : event || undefined, reason });
    emit('whatsapp.template_status', { name: key.name, status: event });
  } else if (field === 'template_category_update') {
    await upsert({ ...key, metaId, category: value.new_category ? String(value.new_category) : null });
  } else if (field === 'message_template_quality_update') {
    await upsert({ ...key, metaId, quality: value.new_quality_score ? String(value.new_quality_score) : null });
  }
}

/** Meta rejects template parameters with newlines, tabs or 4+ spaces in a row. */
export const templateParam = (s: string, max = 900) => s.replace(/\s+/g, ' ').trim().slice(0, max) || '-';
