// Cities (multi-city as data, PRD §64) + Analytics taxonomy (App E) + Maker-checker queue (§56).
// Cities/zones read from geo.*; maker-checker persisted via outbox + audit log.
import { q } from '../../packages/database/db.js';

export interface City { id: string; name: string; zones: { name: string; radiusKm: number }[]; services: string[]; radiusKm: number; vatBps: number; emergencyEnabled: boolean; flags: Record<string, boolean> }
export const cityService = {
  async list(): Promise<City[]> {
    const cities = await q<Record<string, unknown>>(`SELECT * FROM geo.city`);
    const out: City[] = [];
    for (const c of cities) {
      const zones = await q<Record<string, unknown>>(`SELECT name, radius_km FROM geo.zone WHERE city_id=$1`, [String(c.id)]);
      const svcs = await q<{ name: string }>(`SELECT name FROM catalog.category WHERE active`);
      out.push({
        id: String(c.id), name: String(c.name), radiusKm: Number(c.radius_km), vatBps: Number(c.vat_bps),
        emergencyEnabled: Boolean(c.emergency_enabled), flags: (c.flags as Record<string, boolean>) ?? {},
        zones: zones.map((z) => ({ name: String(z.name), radiusKm: Number(z.radius_km) })),
        services: svcs.map((s) => s.name),
      });
    }
    return out;
  },
  async get(id: string) {
    const all = await this.list();
    return all.find((c) => c.id === id) ?? null;
  },
  async upsert(c: City) {
    const exists = await q(`SELECT 1 FROM geo.city WHERE id=$1`, [c.id]);
    if (exists.length === 0) {
      await q(`INSERT INTO geo.city (id, name, radius_km, vat_bps, emergency_enabled, flags) VALUES ($1,$2,$3,$4,$5,$6)`,
        [c.id, c.name, c.radiusKm, c.vatBps, c.emergencyEnabled, JSON.stringify(c.flags)]);
    } else {
      await q(`UPDATE geo.city SET name=$2, radius_km=$3, vat_bps=$4, emergency_enabled=$5, flags=$6 WHERE id=$1`,
        [c.id, c.name, c.radiusKm, c.vatBps, c.emergencyEnabled, JSON.stringify(c.flags)]);
    }
    return c;
  },
};

export const ANALYTIC_EVENTS = [
  'app_opened', 'otp_requested', 'otp_verified', 'property_created', 'asset_created', 'service_viewed',
  'booking_started', 'quote_requested', 'checkout_started', 'payment_initiated', 'payment_confirmed',
  'booking_created', 'provider_assigned', 'quote_approved', 'job_completed', 'rating_submitted',
  'warranty_claim_created', 'dispute_created', 'payout_received', 'sos_triggered',
] as const;
export function analyticProps(base: Record<string, unknown> = {}) {
  return { timestamp: new Date().toISOString(), ...base };
}

export interface CheckerItem { id: string; kind: 'refund' | 'payout' | 'pricing' | 'commission' | 'suspension' | 'promotion' | 'adjustment' | 'bank_change'; refId: string; requestedBy: string; approvedBy?: string; status: 'pending' | 'approved' | 'rejected'; createdAt: string }
export const makerChecker = {
  async submit(kind: CheckerItem['kind'], refId: string, requestedBy: string): Promise<CheckerItem> {
    const rows = await q<Record<string, unknown>>(
      `INSERT INTO checker.item (kind, ref_id, requested_by) VALUES ($1,$2,$3) RETURNING *`, [kind, refId, requestedBy],
    );
    return toChecker(rows[0]);
  },
  async decide(id: string, approver: string, approve: boolean): Promise<CheckerItem> {
    const cur = await q<Record<string, unknown>>(`SELECT * FROM checker.item WHERE id=$1`, [id]);
    if (!cur[0] || String(cur[0].status) !== 'pending') throw new Error('CHECKER_GONE');
    if (String(cur[0].requested_by) === approver) throw new Error('MAKER_CANNOT_CHECK');
    const upd = await q<Record<string, unknown>>(
      `UPDATE checker.item SET status=$2, approved_by=$3 WHERE id=$1 RETURNING *`, [id, approve ? 'approved' : 'rejected', approver],
    );
    return toChecker(upd[0]);
  },
  async pending(): Promise<CheckerItem[]> {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM checker.item WHERE status='pending' ORDER BY created_at DESC LIMIT 50`);
    return rows.map(toChecker);
  },
};
function toChecker(r: Record<string, unknown>): CheckerItem {
  return {
    id: String(r.id), kind: r.kind as CheckerItem['kind'], refId: String(r.ref_id),
    requestedBy: String(r.requested_by), approvedBy: (r.approved_by as string) ?? undefined,
    status: r.status as CheckerItem['status'], createdAt: String(r.created_at),
  };
}
