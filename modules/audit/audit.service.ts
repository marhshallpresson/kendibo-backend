// Audit — append-only, Postgres-backed. Every sensitive admin action logged.
import { q } from '../../packages/database/db.js';

/** Who/where/why for an audit row (054 columns). All optional. */
export interface AuditContext {
  entityType?: string;
  reason?: string | null;
  ip?: string | null;
  ua?: string | null;
  meta?: Record<string, unknown> | null;
}

export interface AuditQuery {
  entity?: string; entityId?: string; actor?: string; action?: string; limit?: number; offset?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const parseMeta = (v: unknown): Record<string, unknown> | null => {
  if (v == null) return null;
  if (typeof v === 'object') return v as Record<string, unknown>;
  try { return JSON.parse(String(v)) as Record<string, unknown>; } catch { return null; }
};

export const auditService = {
  async log(actor: string, action: string, target?: string, ctx: AuditContext = {}) {
    const rows = await q<Record<string, unknown>>(
      `INSERT INTO audit.log (actor, action, entity_id, entity_type, reason, ip, user_agent, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [actor, action, target ?? null, ctx.entityType ?? null, ctx.reason ?? null, ctx.ip ?? null,
        ctx.ua ? String(ctx.ua).slice(0, 300) : null, ctx.meta ? JSON.stringify(ctx.meta) : null],
    );
    const r = rows[0];
    return { id: String(r.id), actor: String(r.actor), action: String(r.action), target: r.entity_id ? String(r.entity_id) : undefined, at: String(r.created_at) };
  },
  /**
   * Filtered, paginated audit trail for the admin console. `entity` matches the
   * entity type, `action` is a prefix (e.g. "admin.user."), `actor` an exact id.
   * Raw column names stay on each item for older console builds.
   */
  async query(f: AuditQuery = {}) {
    const where: string[] = [];
    const vals: unknown[] = [];
    if (f.entity) { vals.push(f.entity); where.push(`entity_type=$${vals.length}`); }
    if (f.entityId) { vals.push(f.entityId); where.push(`entity_id=$${vals.length}`); }
    if (f.actor) { vals.push(f.actor); where.push(`actor=$${vals.length}`); }
    if (f.action) { vals.push(`${f.action}%`); where.push(`action LIKE $${vals.length}`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(Number(f.limit ?? 50) || 50, 1), 200);
    const offset = Math.max(Number(f.offset ?? 0) || 0, 0);
    const total = await q<{ n: string }>(`SELECT COUNT(*) AS n FROM audit.log ${w}`, vals);
    const rows = await q<Record<string, unknown>>(
      `SELECT * FROM audit.log ${w} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`, vals,
    );
    const actorIds = [...new Set(rows.map((r) => String(r.actor)).filter((a) => UUID_RE.test(a)))];
    const names = new Map<string, string | null>();
    if (actorIds.length) {
      const us = await q<{ id: string; name: string | null; email: string | null }>(
        `SELECT id, name, email FROM identity.users WHERE id IN (${actorIds.map((_, i) => `$${i + 1}`).join(',')})`, actorIds,
      ).catch(() => []);
      for (const u of us) names.set(String(u.id), u.name ?? u.email ?? null);
    }
    const items = rows.map((r) => ({
      id: String(r.id), at: String(r.created_at), actorId: String(r.actor), actorName: names.get(String(r.actor)) ?? null,
      action: String(r.action), entity: r.entity_type ? String(r.entity_type) : null, entityId: r.entity_id ? String(r.entity_id) : null,
      reason: r.reason ? String(r.reason) : null, ip: r.ip ? String(r.ip) : null, ua: r.user_agent ? String(r.user_agent) : null,
      meta: parseMeta(r.meta),
      // legacy raw names
      actor: String(r.actor), entity_id: r.entity_id ?? null, entity_type: r.entity_type ?? null, created_at: r.created_at,
    }));
    return { items, total: Number(total[0]?.n ?? 0), nextCursor: null as string | null };
  },
  async list(cursor?: string) {
    void cursor;
    return this.query({ limit: 50 });
  },
};
