// B2B — Postgres-backed organisations, members, work orders, approvals, invoices.
import { q } from '../../packages/database/db.js';
import { emit } from '../../packages/observability/emit.js';

export interface Org { id: string; name: string; type: string; createdAt: string }
export interface OrgUser { orgId: string; userId: string; role: 'B2B_ADMIN' | 'FACILITY_MANAGER' | 'PROPERTY_MANAGER' | 'APPROVER' | 'STAFF' | 'FINANCE' }
export interface WorkOrder {
  id: string; orgId: string; propertyId: string; title: string; amountKobo: string;
  status: 'draft' | 'pending_approval' | 'approved' | 'assigned' | 'completed' | 'invoiced' | 'paid' | 'rejected';
  approvals: { role: string; by: string; at: string }[]; createdAt: string;
}
export interface Invoice { id: string; orgId: string; workOrderId: string; amountKobo: string; status: 'issued' | 'approved' | 'paid'; createdAt: string }
const LIMITS: Record<string, bigint> = { SUPERVISOR: 5000000n, MANAGER: 25000000n };

const toWO = (r: Record<string, unknown>): WorkOrder => ({
  id: String(r.id), orgId: String(r.org_id), propertyId: r.property_id ? String(r.property_id) : '',
  title: String(r.title), amountKobo: String(r.amount_kobo),
  status: r.status as WorkOrder['status'], approvals: (r.approvals as WorkOrder['approvals']) ?? [],
  createdAt: String(r.created_at),
});

export const b2bService = {
  async createOrg(name: string, type: string): Promise<Org> {
    const rows = await q<Record<string, unknown>>(`INSERT INTO b2b.organisation (name, type) VALUES ($1,$2) RETURNING *`, [name, type]);
    const r = rows[0];
    return { id: String(r.id), name: String(r.name), type: String(r.type), createdAt: String(r.created_at) };
  },
  async addMember(orgId: string, userId: string, role: OrgUser['role']): Promise<OrgUser> {
    const exists = await q(`SELECT 1 FROM b2b.organisation_user WHERE organisation_id=$1 AND user_id=$2`, [orgId, userId]);
    if (exists.length === 0) {
      await q(`INSERT INTO b2b.organisation_user (organisation_id, user_id, role) VALUES ($1,$2,$3)`, [orgId, userId, role]);
    }
    return { orgId, userId, role };
  },
  async memberRole(orgId: string, userId: string): Promise<OrgUser['role'] | null> {
    const rows = await q<{ role: string }>(`SELECT role FROM b2b.organisation_user WHERE organisation_id=$1 AND user_id=$2`, [orgId, userId]);
    return (rows[0]?.role as OrgUser['role']) ?? null;
  },
  async createWorkOrder(orgId: string, propertyId: string, title: string, amountKobo: bigint): Promise<WorkOrder> {
    const rows = await q<Record<string, unknown>>(
      `INSERT INTO b2b.work_order (org_id, property_id, title, amount_kobo) VALUES ($1,$2,$3,$4) RETURNING *`,
      [orgId, propertyId || null, title, String(amountKobo)],
    );
    const wo = toWO(rows[0]);
    emit('b2b.work_order_created', { orgId, workOrderId: wo.id });
    return wo;
  },
  async approve(id: string, role: string, by: string): Promise<WorkOrder> {
    const cur = await q<Record<string, unknown>>(`SELECT * FROM b2b.work_order WHERE id=$1`, [id]);
    if (!cur[0] || String(cur[0].status) !== 'pending_approval') throw new Error('WO_GONE');
    const amount = BigInt(String(cur[0].amount_kobo));
    const limit = role === 'SUPERVISOR' ? LIMITS.SUPERVISOR : role === 'MANAGER' ? LIMITS.MANAGER : null;
    if (limit !== null && amount > limit) throw new Error('ABOVE_APPROVAL_LIMIT');
    const approvals = [...((cur[0].approvals as WorkOrder['approvals']) ?? []), { role, by, at: new Date().toISOString() }];
    const upd = await q<Record<string, unknown>>(
      `UPDATE b2b.work_order SET approvals=$2, status='approved' WHERE id=$1 RETURNING *`, [id, JSON.stringify(approvals)],
    );
    return toWO(upd[0]);
  },
  async invoice(orgId: string, workOrderId: string): Promise<Invoice> {
    const w = await q<Record<string, unknown>>(`SELECT * FROM b2b.work_order WHERE id=$1`, [workOrderId]);
    if (!w[0]) throw new Error('NOT_FOUND');
    const rows = await q<Record<string, unknown>>(
      `INSERT INTO b2b.invoice (org_id, work_order_id, amount_kobo) VALUES ($1,$2,$3) RETURNING *`,
      [orgId, workOrderId, String(w[0].amount_kobo)],
    );
    await q(`UPDATE b2b.work_order SET status='invoiced' WHERE id=$1`, [workOrderId]);
    const r = rows[0];
    return { id: String(r.id), orgId: String(r.org_id), workOrderId: String(r.work_order_id), amountKobo: String(r.amount_kobo), status: r.status as Invoice['status'], createdAt: String(r.created_at) };
  },
  async list(orgId: string, cursor?: string) {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM b2b.work_order WHERE org_id=$1 ORDER BY created_at DESC LIMIT 20`, [orgId]);
    void cursor;
    return { items: rows.map(toWO), nextCursor: null as string | null };
  },
  async report(orgId: string) {
    const rows = await q<{ n: string; spend: string }>(
      `SELECT count(*) n, COALESCE(SUM(amount_kobo),0) spend FROM b2b.work_order WHERE org_id=$1`, [orgId],
    );
    return { workOrders: Number(rows[0]?.n ?? 0), spendKobo: String(rows[0]?.spend ?? 0) };
  },
};
