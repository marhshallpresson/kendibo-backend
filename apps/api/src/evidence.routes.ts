// Job evidence: before/after photos from the pro, photos and videos from the
// customer, and the admin view (with hide-with-reason, audited).
// Access: the booking's customer, its accepted provider, or an admin (via the
// bookingParty helper from main.ts). /v1/admin/* is already behind the admin
// gate in main.ts; each handler checks the specific permission too.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { adminCan } from '../../../modules/authorization/rbac.js';
import { auditService } from '../../../modules/audit/audit.service.js';
import {
  addEvidenceAsset, addEvidenceBytes, evidenceFor, getEvidence, hideEvidence, withSignedUrls,
  type EvidenceRow, type EvidenceStage,
} from '../../../modules/media/evidence.service.js';

interface Helpers {
  fail: (reply: FastifyReply, code: string, message: string, status?: number, retryable?: boolean) => unknown;
  bookingParty: (req: never, reply: FastifyReply, bookingId: string) => Promise<{ sub: string; as: 'customer' | 'provider' | 'admin' } | null>;
  adminActor: (req: never) => Promise<{ sub: string; role: string } | { denied: true } | null>;
}

const PROVIDER_STAGES = ['before', 'during', 'after'] as const;
const CUSTOMER_STAGES = ['request', 'during', 'after', 'dispute'] as const;
const uuid = z.string().uuid();

/** What parties see: no hidden rows, no moderation details, no uploader id. */
const forParty = (r: EvidenceRow & { url: string | null }) => ({
  id: r.id, bookingId: r.bookingId, requestId: r.requestId, stage: r.stage, kind: r.kind, mime: r.mime,
  sizeBytes: r.sizeBytes, sha256: r.sha256, caption: r.caption, uploaderRole: r.uploaderRole, source: r.source,
  receivedAt: r.receivedAt, url: r.url,
});

const REASON_TEXT: Record<string, string> = {
  too_large: 'That file is too big. Photos can be up to 10 MB and videos up to 50 MB.',
  type: 'That file type is not supported. Use JPG, PNG, HEIC, MP4, MOV or PDF.',
  rejected: "We couldn't read that file. Please try again with another copy.",
  not_found: "We couldn't find that upload. Please upload the file again.",
};

export function registerEvidenceRoutes(app: FastifyInstance, h: Helpers) {
  /** Body: JSON { stage, assetId, caption? } or multipart (file + stage/caption fields). */
  async function add(req: FastifyRequest, reply: FastifyReply, bookingId: string, who: 'customer' | 'provider', sub: string) {
    const stages = (who === 'provider' ? PROVIDER_STAGES : CUSTOMER_STAGES) as readonly [EvidenceStage, ...EvidenceStage[]];
    const base = { bookingId, uploaderUserId: sub, uploaderRole: who, source: 'app' as const };
    if (req.isMultipart()) {
      const file = await req.file({ limits: { fileSize: 50 * 1024 * 1024, files: 1 } });
      if (!file) return h.fail(reply, 'NO_FILE', 'Attach one file.');
      const fields = (file.fields ?? {}) as Record<string, { value?: unknown } | undefined>;
      const f = z.object({ stage: z.enum(stages), caption: z.string().max(1000).optional() }).parse({
        stage: fields.stage?.value ?? (who === 'customer' ? 'request' : undefined),
        caption: typeof fields.caption?.value === 'string' ? fields.caption.value : undefined,
      });
      const bytes = await file.toBuffer();
      if (file.file.truncated) return h.fail(reply, 'FILE_TOO_LARGE', REASON_TEXT.too_large, 413);
      const out = await addEvidenceBytes({ ...base, stage: f.stage, caption: f.caption, bytes, mime: file.mimetype });
      if (!out.ok) return h.fail(reply, 'EVIDENCE_REJECTED', REASON_TEXT[out.reason], 400);
      return reply.code(201).send({ data: forParty((await withSignedUrls([out.row]))[0]) });
    }
    const body = z.object({
      stage: who === 'customer' ? z.enum(stages).default('request') : z.enum(stages),
      assetId: z.string().min(3).max(80),
      caption: z.string().max(1000).optional(),
    }).parse(req.body);
    const out = await addEvidenceAsset({ ...base, stage: body.stage, assetId: body.assetId, caption: body.caption });
    if (!out.ok) return h.fail(reply, 'EVIDENCE_REJECTED', REASON_TEXT[out.reason], out.reason === 'not_found' ? 404 : 400);
    return reply.code(201).send({ data: forParty((await withSignedUrls([out.row]))[0]) });
  }

  // The assigned pro: before/during/after photos and videos for the job.
  app.post('/v1/jobs/:id/evidence', { bodyLimit: 52 * 1024 * 1024 }, async (req, reply) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const party = await h.bookingParty(req as never, reply, id); if (!party) return reply;
    if (party.as !== 'provider') return h.fail(reply, 'FORBIDDEN', 'Only the assigned provider can add job photos here.', 403);
    return add(req, reply, id, 'provider', party.sub);
  });

  // The customer: photos, videos, voice notes or PDFs about their booking.
  app.post('/v1/bookings/:id/evidence', { bodyLimit: 52 * 1024 * 1024 }, async (req, reply) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const party = await h.bookingParty(req as never, reply, id); if (!party) return reply;
    if (party.as !== 'customer') return h.fail(reply, 'FORBIDDEN', 'Only the customer can add photos to this booking.', 403);
    return add(req, reply, id, 'customer', party.sub);
  });

  // Both parties (and admins) see the visible evidence with short-lived links.
  app.get('/v1/bookings/:id/evidence', async (req, reply) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const party = await h.bookingParty(req as never, reply, id); if (!party) return reply;
    const rows = await withSignedUrls(await evidenceFor(id));
    return { data: rows.map(forParty) };
  });

  // Admin: everything, hidden rows included, with who hid them and why.
  app.get('/v1/admin/evidence', async (req, reply) => {
    const a = await h.adminActor(req as never);
    if (!a) return h.fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
    if ('denied' in a || !adminCan(a.role, 'booking:view:any')) return h.fail(reply, 'FORBIDDEN', 'Support access required', 403);
    const { bookingId } = z.object({ bookingId: uuid }).parse(req.query);
    await auditService.log(a.sub, 'evidence.view', bookingId);
    return { data: await withSignedUrls(await evidenceFor(bookingId, { includeHidden: true })) };
  });

  app.post('/v1/admin/evidence/:id/hide', async (req, reply) => {
    const a = await h.adminActor(req as never);
    if (!a) return h.fail(reply, 'UNAUTHENTICATED', 'Login required', 401);
    if ('denied' in a || !adminCan(a.role, 'booking:override')) return h.fail(reply, 'FORBIDDEN', 'Operations access required', 403);
    const id = uuid.parse((req.params as { id: string }).id);
    const { reason } = z.object({ reason: z.string().trim().min(3).max(500) }).parse(req.body);
    const cur = await getEvidence(id);
    if (!cur) return h.fail(reply, 'NOT_FOUND', 'Evidence not found', 404);
    if (cur.hiddenAt) return { data: cur };
    const row = await hideEvidence(id, a.sub, reason);
    await auditService.log(a.sub, 'evidence.hide', `${id}:${reason.slice(0, 200)}`);
    return { data: row };
  });
}
