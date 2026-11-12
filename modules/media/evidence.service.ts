// Job evidence: photos, videos, voice notes and documents attached to a
// customer's request or booking, from WhatsApp or the apps.
//
//   • Every file goes through the normal media pipeline (magic bytes, sha256,
//     quarantine -> clean) and is recorded in media.evidence with who sent it,
//     at which stage of the job, and when.
//   • Parties can add evidence but never delete it. Admins can hide a row with
//     a reason (audited); the row and the file are kept for disputes.
//   • A customer who sends media with no open request gets "pending" evidence
//     (no request/booking yet). attachPendingEvidence() links it to their next
//     request when it is created.
import { q } from '../../packages/database/db.js';
import { emit } from '../../packages/observability/emit.js';
import { objectStore } from '../../packages/storage/object.store.js';
import { mediaService } from './media.service.js';

export type EvidenceKind = 'image' | 'video' | 'audio' | 'document';
export type EvidenceStage = 'request' | 'before' | 'during' | 'after' | 'dispute';
export type EvidenceRole = 'customer' | 'provider' | 'admin';
export const EVIDENCE_STAGES = ['request', 'before', 'during', 'after', 'dispute'] as const;

const MB = 1024 * 1024;
const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
const VIDEO_MIME = ['video/mp4', 'video/quicktime'];
const AUDIO_MIME = ['audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/amr'];
const DOCUMENT_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'video/mp4', 'video/quicktime'];
const LIMIT_BY_MIME = (mime: string): number =>
  IMAGE_MIME.includes(mime) ? 10 * MB : VIDEO_MIME.includes(mime) ? 50 * MB : AUDIO_MIME.includes(mime) ? 16 * MB : 20 * MB;

/** Why a file can't be kept: null when it's fine. */
export function checkEvidence(kind: EvidenceKind, mime: string, size: number): 'too_large' | 'type' | null {
  const allowed = kind === 'image' ? IMAGE_MIME : kind === 'video' ? VIDEO_MIME : kind === 'audio' ? AUDIO_MIME : DOCUMENT_MIME;
  if (!allowed.includes(mime)) return 'type';
  if (size > LIMIT_BY_MIME(mime)) return 'too_large';
  return null;
}
/** What the file is, from its MIME type (for app uploads). */
export function kindForMime(mime: string): EvidenceKind | null {
  if (IMAGE_MIME.includes(mime)) return 'image';
  if (VIDEO_MIME.includes(mime)) return 'video';
  if (AUDIO_MIME.includes(mime)) return 'audio';
  if (mime === 'application/pdf') return 'document';
  return null;
}

const NOUN: Record<EvidenceKind, string> = { image: 'photo', video: 'video', audio: 'voice note', document: 'document' };

// ── WhatsApp download (swappable in tests: no real Graph calls) ──────────────
export type MediaFetcher = (mediaId: string, precheck: (mime: string, size: number) => 'too_large' | 'type' | null) =>
  Promise<{ ok: true; bytes: Buffer; mime: string } | { ok: false; reason: 'unavailable' | 'too_large' | 'type'; mime?: string }>;
let fetcher: MediaFetcher | null = null;
export function setMediaFetcher(fn: MediaFetcher | null) { fetcher = fn; }
async function fetchMedia(mediaId: string, precheck: (mime: string, size: number) => 'too_large' | 'type' | null) {
  if (fetcher) return fetcher(mediaId, precheck);
  const { wa } = await import('../whatsapp/whatsapp.client.js');
  return wa.fetchMedia(mediaId, precheck);
}

// ── The user's current request or booking ────────────────────────────────────
// Kept local on purpose (a session helper may replace it later).
export interface CurrentRequest { requestId: string | null; bookingId: string | null; label: string; when: string | null; role: 'customer' | 'provider' }

const OPEN_REQUEST = ['SUBMITTED', 'MATCHING', 'OFFERED', 'ACCEPTED', 'BOOKED'];
const CLOSED_BOOKING = ['CLOSED', 'CANCELLED', 'DRAFT'];
const REQUEST_FRESH_MS = 30 * 24 * 3600_000;

const shortDate = (v: unknown): string | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Africa/Lagos' }).format(d).replace(',', '');
};
const ts = (v: unknown) => new Date(String(v instanceof Date ? v.toISOString() : v)).getTime() || 0;

async function labelFor(serviceId: unknown, categoryId: unknown, title: unknown): Promise<string> {
  if (serviceId) {
    const s = await q<{ name: string }>(`SELECT name FROM catalog.service WHERE id=$1`, [String(serviceId)]).catch(() => []);
    if (s[0]?.name) return String(s[0].name);
  }
  if (categoryId) {
    const c = await q<{ name: string }>(`SELECT COALESCE(short_name, name) AS name FROM catalog.category WHERE id=$1`, [String(categoryId)]).catch(() => []);
    if (c[0]?.name) return String(c[0].name);
  }
  return String(title || 'your job').slice(0, 60);
}

/** The customer's latest open request/booking, or the provider's current job. */
export async function currentRequestFor(userId: string): Promise<CurrentRequest | null> {
  // A provider sending media: their latest accepted job that is still open.
  const prov = await q<{ id: string }>(`SELECT id FROM provider.provider WHERE user_id=$1`, [userId]).catch(() => []);
  if (prov[0]) {
    const jobs = await q<{ job_id: string; created_at: string }>(
      `SELECT job_id, created_at FROM dispatch.assignment WHERE provider_id=$1 AND status='accepted' ORDER BY created_at DESC LIMIT 5`, [prov[0].id],
    ).catch(() => []);
    for (const j of jobs) {
      const b = await q<Record<string, unknown>>(`SELECT id, service_id, status, scheduled_at FROM booking.booking WHERE id=$1`, [String(j.job_id)]).catch(() => []);
      if (b[0] && !CLOSED_BOOKING.includes(String(b[0].status))) {
        return { requestId: null, bookingId: String(b[0].id), label: await labelFor(b[0].service_id, null, null), when: shortDate(b[0].scheduled_at), role: 'provider' };
      }
    }
  }
  const reqs = await q<Record<string, unknown>>(
    `SELECT id, title, category_id, service_id, status, booking_id, scheduled_date, created_at FROM booking.service_request WHERE user_id=$1 ORDER BY created_at DESC LIMIT 5`, [userId],
  ).catch(() => []);
  const books = await q<Record<string, unknown>>(
    `SELECT id, service_id, status, scheduled_at, created_at FROM booking.booking WHERE user_id=$1 ORDER BY created_at DESC LIMIT 5`, [userId],
  ).catch(() => []);
  const bookingOpen = new Map(books.map((b) => [String(b.id), !CLOSED_BOOKING.includes(String(b.status))]));
  const candidates: { at: number; pick: () => Promise<CurrentRequest> }[] = [];
  for (const r of reqs) {
    if (!OPEN_REQUEST.includes(String(r.status))) continue;
    const bid = r.booking_id ? String(r.booking_id) : null;
    if (bid && bookingOpen.get(bid) === false) continue;
    if (!bid && Date.now() - ts(r.created_at) > REQUEST_FRESH_MS) continue;
    const b = bid ? books.find((x) => String(x.id) === bid) : undefined;
    candidates.push({
      at: ts(r.created_at),
      pick: async () => ({ requestId: String(r.id), bookingId: bid, label: await labelFor(r.service_id, r.category_id, r.title), when: shortDate(b?.scheduled_at ?? r.scheduled_date ?? r.created_at), role: 'customer' }),
    });
  }
  const linked = new Set(reqs.map((r) => (r.booking_id ? String(r.booking_id) : '')));
  for (const b of books) {
    if (CLOSED_BOOKING.includes(String(b.status)) || linked.has(String(b.id))) continue;
    candidates.push({
      at: ts(b.created_at),
      pick: async () => ({ requestId: null, bookingId: String(b.id), label: await labelFor(b.service_id, null, null), when: shortDate(b.scheduled_at ?? b.created_at), role: 'customer' }),
    });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.at - a.at);
  return candidates[0].pick();
}

// ── Store ─────────────────────────────────────────────────────────────────────
export interface EvidenceRow {
  id: string; requestId: string | null; bookingId: string | null;
  uploaderUserId: string; uploaderRole: EvidenceRole; stage: EvidenceStage;
  assetId: string; kind: EvidenceKind; sha256: string; mime: string; sizeBytes: number;
  caption: string | null; source: 'app' | 'whatsapp'; receivedAt: string; createdAt: string;
  hiddenAt: string | null; hiddenBy: string | null; hiddenReason: string | null;
}
const iso = (v: unknown) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
const toRow = (r: Record<string, unknown>): EvidenceRow => ({
  id: String(r.id), requestId: r.request_id ? String(r.request_id) : null, bookingId: r.booking_id ? String(r.booking_id) : null,
  uploaderUserId: String(r.uploader_user_id), uploaderRole: r.uploader_role as EvidenceRole, stage: r.stage as EvidenceStage,
  assetId: String(r.asset_id), kind: r.kind as EvidenceKind, sha256: String(r.sha256), mime: String(r.mime), sizeBytes: Number(r.size_bytes),
  caption: (r.caption as string) ?? null, source: (r.source as 'app' | 'whatsapp') ?? 'app',
  receivedAt: iso(r.received_at) ?? '', createdAt: iso(r.created_at) ?? '',
  hiddenAt: iso(r.hidden_at), hiddenBy: r.hidden_by ? String(r.hidden_by) : null, hiddenReason: (r.hidden_reason as string) ?? null,
});

interface RecordInput {
  requestId?: string | null; bookingId?: string | null; uploaderUserId: string; uploaderRole: EvidenceRole; stage: EvidenceStage;
  assetId: string; kind: EvidenceKind; sha256: string; mime: string; sizeBytes: number; caption?: string | null;
  source?: 'app' | 'whatsapp'; waMessageId?: string | null;
}
export async function recordEvidence(i: RecordInput): Promise<EvidenceRow> {
  const rows = await q<Record<string, unknown>>(
    `INSERT INTO media.evidence (request_id, booking_id, uploader_user_id, uploader_role, stage, asset_id, kind, sha256, mime, size_bytes, caption, source, wa_message_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [i.requestId ?? null, i.bookingId ?? null, i.uploaderUserId, i.uploaderRole, i.stage, i.assetId, i.kind, i.sha256, i.mime, i.sizeBytes,
     i.caption ? i.caption.slice(0, 1000) : null, i.source ?? 'app', i.waMessageId ?? null],
  );
  const row = toRow(rows[0]);
  emit('evidence.added', { evidenceId: row.id, bookingId: row.bookingId, requestId: row.requestId, stage: row.stage, role: row.uploaderRole, source: row.source });
  return row;
}

/** Link a customer's pending evidence (sent before they had a request) to their new request. */
export async function attachPendingEvidence(userId: string, requestId: string): Promise<number> {
  const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  const pending = await q<{ id: string }>(
    `SELECT id FROM media.evidence WHERE uploader_user_id=$1 AND request_id IS NULL AND booking_id IS NULL AND created_at > $2`, [userId, since],
  );
  for (const p of pending) await q(`UPDATE media.evidence SET request_id=$2 WHERE id=$1 AND request_id IS NULL`, [p.id, requestId]);
  if (pending.length) emit('evidence.pending_attached', { requestId, count: pending.length });
  return pending.length;
}

/** Store bytes through the media pipeline, then record them as evidence. */
export async function addEvidenceBytes(i: Omit<RecordInput, 'assetId' | 'sha256' | 'sizeBytes' | 'kind'> & { bytes: Buffer; kind?: EvidenceKind }):
  Promise<{ ok: true; row: EvidenceRow } | { ok: false; reason: 'too_large' | 'type' | 'rejected' }> {
  const kind = i.kind ?? kindForMime(i.mime);
  if (!kind) return { ok: false, reason: 'type' };
  const refused = checkEvidence(kind, i.mime, i.bytes.length);
  if (refused) return { ok: false, reason: refused };
  const { assetId } = await mediaService.presign(kind === 'image' ? 'photo' : kind === 'video' ? 'video' : 'doc');
  const done = await mediaService.ingest(assetId, i.bytes, i.mime, { maxBytes: LIMIT_BY_MIME(i.mime) });
  if (done.status !== 'clean') return { ok: false, reason: 'rejected' };
  const row = await recordEvidence({ ...i, kind, assetId, sha256: done.sha256, sizeBytes: i.bytes.length });
  return { ok: true, row };
}

/** Record an asset already uploaded through presign/ingest or /v1/media/upload. */
export async function addEvidenceAsset(i: Omit<RecordInput, 'sha256' | 'sizeBytes' | 'kind' | 'mime'>):
  Promise<{ ok: true; row: EvidenceRow } | { ok: false; reason: 'not_found' | 'type' | 'too_large' }> {
  const a = await mediaService.get(i.assetId);
  if (!a || a.status !== 'clean' || !a.mime) return { ok: false, reason: 'not_found' };
  const kind = kindForMime(a.mime);
  if (!kind) return { ok: false, reason: 'type' };
  const { bytes } = await mediaService.readAsset(i.assetId).catch(() => ({ bytes: null as Buffer | null }));
  if (!bytes) return { ok: false, reason: 'not_found' };
  const refused = checkEvidence(kind, a.mime, bytes.length);
  if (refused) return { ok: false, reason: refused };
  const row = await recordEvidence({ ...i, kind, mime: a.mime, sha256: a.sha256, sizeBytes: bytes.length });
  return { ok: true, row };
}

// ── WhatsApp inbound ─────────────────────────────────────────────────────────
interface InboundMedia {
  id: string; type: string;
  image?: { id: string; caption?: string }; video?: { id: string; caption?: string };
  audio?: { id: string }; document?: { id: string; caption?: string; filename?: string };
}
export type InboundEvidence =
  | { status: 'refused'; kind: EvidenceKind; message: string }
  | { status: 'attached' | 'pending'; kind: EvidenceKind; message: string; assetId: string; mime: string; bytes: Buffer | null; row: EvidenceRow };

function refusal(kind: EvidenceKind, reason: 'unavailable' | 'too_large' | 'type' | 'rejected'): string {
  const noun = NOUN[kind];
  if (reason === 'too_large') {
    return kind === 'video'
      ? "That video is a bit too big for us (the limit is 50 MB). Could you send a shorter clip?"
      : kind === 'image'
        ? "That photo is a bit too big for us (the limit is 10 MB). Could you send a smaller one or a screenshot?"
        : `That ${noun} is a bit too big for us. Could you send a smaller one?`;
  }
  if (reason === 'type') {
    return kind === 'document'
      ? "Sorry, I can only keep PDF, JPG, PNG, HEIC, MP4 or MOV files. Could you send it in one of those formats?"
      : `Sorry, I can't keep that kind of ${noun}. Photos (JPG or PNG), MP4 videos, voice notes and PDFs all work.`;
  }
  return `Sorry, I couldn't save that ${noun}. Could you try sending it again?`;
}
const ackFor = (kind: EvidenceKind, cur: CurrentRequest) =>
  `Got it — your ${NOUN[kind]} is saved to ${cur.role === 'provider' ? 'the job' : 'your request'} for ${cur.label}${cur.when ? ` (${cur.when})` : ''}. Send more anytime.`;
const PENDING_ASK = (kind: EvidenceKind) => `Thanks, I've kept your ${NOUN[kind]}. Is this for a new request? Tell me what you need.`;

/**
 * Save a WhatsApp photo, video, voice note or document as evidence.
 * With `collecting` (the customer is in the middle of describing a new job)
 * it stays pending and joins that request when it is submitted.
 * Returns null when the message carries no file.
 */
export async function receiveWhatsappMedia(m: InboundMedia, user: { id: string }, opts: { collecting?: boolean } = {}): Promise<InboundEvidence | null> {
  const kind = (['image', 'audio', 'video', 'document'] as const).find((k) => m.type === k && m[k]?.id);
  if (!kind) return null;
  const caption = (kind === 'audio' ? undefined : (m[kind] as { caption?: string }).caption) ?? null;
  const cur = opts.collecting ? null : await currentRequestFor(user.id);

  // Meta retries webhooks: one row per WhatsApp message.
  const seen = await q<Record<string, unknown>>(`SELECT * FROM media.evidence WHERE wa_message_id=$1`, [m.id]);
  if (seen[0]) {
    const row = toRow(seen[0]);
    const attached = !!(row.requestId || row.bookingId);
    return { status: attached ? 'attached' : 'pending', kind, assetId: row.assetId, mime: row.mime, bytes: null, row,
      message: attached && cur ? ackFor(kind, cur) : PENDING_ASK(kind) };
  }

  const got = await fetchMedia(String(m[kind]!.id), (mime, size) => checkEvidence(kind, mime, size)).catch(() => ({ ok: false as const, reason: 'unavailable' as const }));
  if (!got.ok) return { status: 'refused', kind, message: refusal(kind, got.reason) };
  const out = await addEvidenceBytes({
    requestId: cur?.requestId ?? null, bookingId: cur?.bookingId ?? null,
    uploaderUserId: user.id, uploaderRole: cur?.role ?? 'customer',
    stage: cur?.role === 'provider' ? 'during' : 'request',
    kind, mime: got.mime, bytes: got.bytes, caption, source: 'whatsapp', waMessageId: m.id,
  }).catch(() => ({ ok: false as const, reason: 'rejected' as const }));
  if (!out.ok) return { status: 'refused', kind, message: refusal(kind, out.reason) };
  return cur
    ? { status: 'attached', kind, assetId: out.row.assetId, mime: got.mime, bytes: got.bytes, row: out.row, message: ackFor(kind, cur) }
    : { status: 'pending', kind, assetId: out.row.assetId, mime: got.mime, bytes: got.bytes, row: out.row, message: PENDING_ASK(kind) };
}

// ── Read / moderate ──────────────────────────────────────────────────────────
/** Every evidence row for a booking (including the request it came from), oldest first. */
export async function evidenceFor(bookingId: string, opts: { includeHidden?: boolean } = {}): Promise<EvidenceRow[]> {
  const reqs = await q<{ id: string }>(`SELECT id FROM booking.service_request WHERE booking_id=$1`, [bookingId]).catch(() => []);
  const rows = await q<Record<string, unknown>>(`SELECT * FROM media.evidence WHERE booking_id=$1`, [bookingId]);
  for (const r of reqs) rows.push(...(await q<Record<string, unknown>>(`SELECT * FROM media.evidence WHERE request_id=$1`, [r.id])));
  const byId = new Map(rows.map((r) => [String(r.id), toRow(r)]));
  return [...byId.values()]
    .filter((r) => opts.includeHidden || !r.hiddenAt)
    .sort((a, b) => ts(a.createdAt) - ts(b.createdAt));
}

/** Short-lived signed links for viewing (10 minutes). */
export async function withSignedUrls<T extends EvidenceRow>(rows: T[], ttlSec = 600): Promise<(T & { url: string | null })[]> {
  return Promise.all(rows.map(async (r) => ({ ...r, url: await objectStore.signedUrl(r.assetId, ttlSec).catch(() => null) })));
}

export async function getEvidence(id: string): Promise<EvidenceRow | null> {
  const rows = await q<Record<string, unknown>>(`SELECT * FROM media.evidence WHERE id=$1`, [id]);
  return rows[0] ? toRow(rows[0]) : null;
}

/** Admin-only: hide from the parties. The row and the file are kept. */
export async function hideEvidence(id: string, adminId: string, reason: string): Promise<EvidenceRow | null> {
  const rows = await q<Record<string, unknown>>(
    `UPDATE media.evidence SET hidden_at=now(), hidden_by=$2, hidden_reason=$3 WHERE id=$1 RETURNING *`, [id, adminId, reason.slice(0, 500)],
  );
  if (!rows[0]) return null;
  emit('evidence.hidden', { evidenceId: id, adminId });
  return toRow(rows[0]);
}
