// Admin operations: the management side of the platform.
//   • WhatsApp support inbox — conversations the AI handed to a person
//   • Payouts desk — vendor balances, fees, and paying out
//   • Matching model — status and retraining
// Access comes from ADMIN_OPS_POLICY (merged into the deny-by-default gate in
// main.ts) — every route needs an admin seat holding the named permission.
// Every write is audited.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Permission } from '../../../modules/authorization/rbac.js';
import { q } from '../../../packages/database/db.js';
import { auditService } from '../../../modules/audit/audit.service.js';
import { vendorFinanceService } from '../../../modules/vendors/vendor-finance.service.js';
import { payoutService } from '../../../modules/payouts/payout.service.js';
import { activeModel, FEATURES } from '../../../modules/matching/matching.service.js';
import { trainAndMaybeActivate, MIN_ROWS } from '../../../modules/matching/trainer.js';

export const ADMIN_OPS_POLICY: Record<string, Permission> = {
  'GET /v1/admin/whatsapp/conversations': 'booking:view:any',
  'GET /v1/admin/whatsapp/conversations/:waId': 'booking:view:any',
  'POST /v1/admin/whatsapp/conversations/:waId/reply': 'booking:view:any',
  'POST /v1/admin/whatsapp/conversations/:waId/resolve': 'booking:view:any',
  'GET /v1/admin/payouts/queue': 'payout:approve',
  'POST /v1/admin/payouts/:providerId/pay': 'payout:approve',
  'GET /v1/admin/ml/status': 'configuration:edit',
  'POST /v1/admin/ml/train': 'configuration:edit',
};

interface Helpers {
  authed: (req: never) => { sub: string } | null;
  fail: (reply: FastifyReply, code: string, message: string, status?: number, retryable?: boolean) => unknown;
}

// Meta only allows free-form replies within 24h of the customer's last message;
// after that a pre-approved template is required.
const WINDOW_MS = 24 * 3600_000;

export function registerAdminOpsRoutes(app: FastifyInstance, h: Helpers) {
  // ── WhatsApp support inbox ───────────────────────────────────────────────
  app.get('/v1/admin/whatsapp/conversations', async (req) => {
    const state = z.enum(['HUMAN', 'all']).catch('HUMAN').parse((req.query as { state?: string }).state);
    const sessions = await q<{ wa_id: string; user_id: string | null; state: string; updated_at: string }>(
      state === 'HUMAN'
        ? `SELECT wa_id, user_id, state, updated_at FROM messaging.whatsapp_session WHERE state='HUMAN' ORDER BY updated_at DESC LIMIT 100`
        : `SELECT wa_id, user_id, state, updated_at FROM messaging.whatsapp_session ORDER BY updated_at DESC LIMIT 100`,
    );
    const out = [];
    for (const s of sessions) {
      const last = await q<{ role: string; content: string; created_at: string }>(
        `SELECT role, content, created_at FROM messaging.whatsapp_turn WHERE wa_id=$1 ORDER BY created_at DESC LIMIT 1`, [s.wa_id],
      );
      const lastUser = await q<{ created_at: string }>(
        `SELECT created_at FROM messaging.whatsapp_turn WHERE wa_id=$1 AND role='user' ORDER BY created_at DESC LIMIT 1`, [s.wa_id],
      );
      const user = s.user_id ? await q<{ name: string | null }>(`SELECT name FROM identity.users WHERE id=$1`, [s.user_id]) : [];
      out.push({
        waId: s.wa_id,
        name: user[0]?.name ?? null,
        state: s.state,
        updatedAt: String(s.updated_at),
        lastMessage: last[0] ? { role: last[0].role, text: String(last[0].content).slice(0, 160), at: String(last[0].created_at) } : null,
        canReply: lastUser[0] ? Date.now() - new Date(String(lastUser[0].created_at)).getTime() < WINDOW_MS : false,
      });
    }
    return { data: out };
  });

  app.get('/v1/admin/whatsapp/conversations/:waId', async (req, reply) => {
    const waId = String((req.params as { waId: string }).waId);
    const session = await q<{ wa_id: string; user_id: string | null; state: string }>(`SELECT wa_id, user_id, state FROM messaging.whatsapp_session WHERE wa_id=$1`, [waId]);
    if (!session[0]) return h.fail(reply, 'NOT_FOUND', 'Conversation not found', 404);
    const turns = await q<{ role: string; content: string; created_at: string }>(
      `SELECT role, content, created_at FROM messaging.whatsapp_turn WHERE wa_id=$1 ORDER BY created_at DESC LIMIT 60`, [waId],
    );
    const draft = await q<Record<string, unknown>>(
      `SELECT need, category_id, budget_kobo, address_text, landmark, scheduled_date, time_window, status, request_id, created_at
         FROM messaging.whatsapp_job_draft WHERE wa_id=$1 ORDER BY created_at DESC LIMIT 1`, [waId],
    );
    const a = h.authed(req as never)!;
    await auditService.log(a.sub, 'whatsapp.conversation.view', waId);
    return {
      data: {
        waId, state: session[0].state, userId: session[0].user_id,
        turns: turns.reverse().map((t) => ({ role: t.role, text: t.content, at: String(t.created_at) })),
        draft: draft[0] ?? null,
      },
    };
  });

  app.post('/v1/admin/whatsapp/conversations/:waId/reply', async (req, reply) => {
    const waId = String((req.params as { waId: string }).waId);
    const { text } = z.object({ text: z.string().trim().min(1).max(1000) }).parse(req.body ?? {});
    const lastUser = await q<{ created_at: string }>(
      `SELECT created_at FROM messaging.whatsapp_turn WHERE wa_id=$1 AND role='user' ORDER BY created_at DESC LIMIT 1`, [waId],
    );
    if (!lastUser[0] || Date.now() - new Date(String(lastUser[0].created_at)).getTime() >= WINDOW_MS) {
      return h.fail(reply, 'OUTSIDE_24H_WINDOW', 'WhatsApp only allows replies within 24 hours of the customer\'s last message. Use an approved template instead.', 409);
    }
    const { wa } = await import('../../../modules/whatsapp/whatsapp.client.js');
    try { await wa.text(waId, text); }
    catch { return h.fail(reply, 'SEND_FAILED', 'WhatsApp did not accept the message. Try again.', 502, true); }
    await q(`INSERT INTO messaging.whatsapp_turn (wa_id, role, content) VALUES ($1,'assistant',$2)`, [waId, `[team] ${text}`]);
    // Keep the conversation with the team while they are replying.
    await q(`UPDATE messaging.whatsapp_session SET state='HUMAN', updated_at=now() WHERE wa_id=$1`, [waId]);
    const a = h.authed(req as never)!;
    await auditService.log(a.sub, 'whatsapp.reply', waId);
    return { data: { sent: true } };
  });

  app.post('/v1/admin/whatsapp/conversations/:waId/resolve', async (req, reply) => {
    const waId = String((req.params as { waId: string }).waId);
    const rows = await q(`UPDATE messaging.whatsapp_session SET state='MENU', updated_at=now() WHERE wa_id=$1 RETURNING wa_id`, [waId]);
    if (!rows[0]) return h.fail(reply, 'NOT_FOUND', 'Conversation not found', 404);
    const a = h.authed(req as never)!;
    await auditService.log(a.sub, 'whatsapp.resolve', waId);
    return { data: { resolved: true } };
  });

  // ── Payouts desk ─────────────────────────────────────────────────────────
  app.get('/v1/admin/payouts/queue', async () => {
    const providers = await q<{ id: string; business_name: string | null }>(
      `SELECT DISTINCT p.id, p.business_name FROM provider.provider p
         JOIN provider.earning e ON e.provider_id = p.id LIMIT 500`,
    );
    const rows = [];
    for (const p of providers) {
      const bal = await vendorFinanceService.balance(String(p.id));
      const eligible = await payoutService.bankEligible(String(p.id)).catch(() => false);
      rows.push({ providerId: String(p.id), name: p.business_name ?? 'Vendor', ...bal, bankReady: eligible });
    }
    rows.sort((a, b) => Number(BigInt(b.availableKobo) - BigInt(a.availableKobo)));
    return { data: rows };
  });

  app.post('/v1/admin/payouts/:providerId/pay', async (req, reply) => {
    const providerId = String((req.params as { providerId: string }).providerId);
    const { amountKobo } = z.object({ amountKobo: z.string().regex(/^\d+$/) }).parse(req.body ?? {});
    const bal = await vendorFinanceService.balance(providerId);
    if (BigInt(amountKobo) <= 0n || BigInt(amountKobo) > BigInt(bal.availableKobo)) {
      return h.fail(reply, 'PAYOUT_EXCEEDS_BALANCE', `Available to pay out: ${bal.availableKobo} kobo`, 409);
    }
    const a = h.authed(req as never)!;
    try {
      const payout = await payoutService.create(providerId, BigInt(amountKobo), `adm_${Date.now().toString(36)}`);
      await vendorFinanceService.recoverFees(providerId, payout.reference);
      await auditService.log(a.sub, 'payout.create', `${providerId}:${payout.reference}:${amountKobo}`);
      return { data: payout };
    } catch (e) {
      const code = (e as Error).message;
      return h.fail(reply, code === 'PAYOUT_COOLING' ? 'PAYOUT_COOLING' : 'PAYOUT_BLOCKED',
        code === 'PAYOUT_COOLING' ? 'Bank details changed recently — payouts are paused for the cooling period.' : 'Payout could not be created.', 409);
    }
  });

  // ── Matching model ───────────────────────────────────────────────────────
  app.get('/v1/admin/ml/status', async () => {
    const active = await activeModel();
    const models = await q<{ version: number; metrics: unknown; trained_rows: number; active: boolean; created_at: string }>(
      `SELECT version, metrics, trained_rows, active, created_at FROM ml.model WHERE name='vendor_match' ORDER BY version DESC LIMIT 10`,
    ).catch(() => []);
    const counts = await q<{ total: string; labelled: string; chosen: string }>(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN accepted IS NOT NULL THEN 1 ELSE 0 END) AS labelled, SUM(CASE WHEN chosen THEN 1 ELSE 0 END) AS chosen FROM ml.match_event`,
    ).catch(() => [{ total: '0', labelled: '0', chosen: '0' }]);
    return {
      data: {
        activeVersion: active.version, coldStart: active.version === 0, weights: active.weights, features: FEATURES,
        minRowsToTrain: MIN_ROWS,
        rankingsLogged: Number(counts[0]?.total ?? 0), labelled: Number(counts[0]?.labelled ?? 0), chosenByCustomers: Number(counts[0]?.chosen ?? 0),
        history: models.map((m) => ({ version: Number(m.version), active: m.active, trainedRows: Number(m.trained_rows), metrics: typeof m.metrics === 'string' ? JSON.parse(m.metrics) : m.metrics, at: String(m.created_at) })),
      },
    };
  });

  app.post('/v1/admin/ml/train', async (req) => {
    const a = h.authed(req as never)!;
    const result = await trainAndMaybeActivate();
    await auditService.log(a.sub, 'ml.train', `v${result.version ?? '-'}:${result.activated ? 'activated' : 'kept'}`);
    return { data: result };
  });
}
