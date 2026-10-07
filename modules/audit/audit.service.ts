// Audit — append-only, Postgres-backed. Every sensitive admin action logged.
import { q } from '../../packages/database/db.js';

export const auditService = {
  async log(actor: string, action: string, target?: string) {
    const rows = await q<Record<string, unknown>>(
      `INSERT INTO audit.log (actor, action, entity_id) VALUES ($1,$2,$3) RETURNING *`, [actor, action, target ?? null],
    );
    const r = rows[0];
    return { id: String(r.id), actor: String(r.actor), action: String(r.action), target: r.entity_id ? String(r.entity_id) : undefined, at: String(r.created_at) };
  },
  async list(cursor?: string) {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM audit.log ORDER BY created_at DESC LIMIT 50`, []);
    void cursor;
    return { items: rows, nextCursor: null as string | null };
  },
};
