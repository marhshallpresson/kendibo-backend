// Property history timeline + maintenance reminders + recurring bookings — Postgres-backed.
import { q } from '../../packages/database/db.js';

export interface HistoryEntry { id: string; propertyId: string; kind: string; label: string; at: string; refId?: string }
export const historyService = {
  async record(propertyId: string, kind: string, label: string, refId?: string): Promise<HistoryEntry> {
    const rows = await q<Record<string, unknown>>(
      `INSERT INTO property.history (property_id, kind, label, ref_id) VALUES ($1,$2,$3,$4) RETURNING *`,
      [propertyId, kind, label, refId ?? null],
    );
    const r = rows[0];
    return { id: String(r.id), propertyId: String(r.property_id), kind: String(r.kind), label: String(r.label), at: String(r.created_at), refId: r.ref_id ? String(r.ref_id) : undefined };
  },
  async timeline(propertyId: string): Promise<HistoryEntry[]> {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM property.history WHERE property_id=$1 ORDER BY created_at`, [propertyId]);
    return rows.map((r) => ({ id: String(r.id), propertyId: String(r.property_id), kind: String(r.kind), label: String(r.label), at: String(r.created_at), refId: r.ref_id ? String(r.ref_id) : undefined }));
  },
};

export interface Reminder { id: string; propertyId: string; assetId?: string; message: string; dueAt: string; source: string; done: boolean }
export const reminderService = {
  async generate(propertyId: string, message: string, dueAt: string, source: string, assetId?: string): Promise<Reminder> {
    const rows = await q<Record<string, unknown>>(
      `INSERT INTO property.reminder (property_id, asset_id, message, due_at, source) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [propertyId, assetId ?? null, message, dueAt, source],
    );
    return toReminder(rows[0]);
  },
  async due(propertyId: string): Promise<Reminder[]> {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM property.reminder WHERE property_id=$1 AND done=FALSE ORDER BY due_at`, [propertyId]);
    return rows.map(toReminder);
  },
  async complete(id: string) {
    const rows = await q<Record<string, unknown>>(`UPDATE property.reminder SET done=TRUE WHERE id=$1 RETURNING *`, [id]);
    return rows[0] ? toReminder(rows[0]) : null;
  },
};
function toReminder(r: Record<string, unknown>): Reminder {
  return { id: String(r.id), propertyId: String(r.property_id), assetId: r.asset_id ? String(r.asset_id) : undefined, message: String(r.message), dueAt: String(r.due_at), source: String(r.source), done: Boolean(r.done) };
}

export type Frequency = 'weekly' | 'biweekly' | 'monthly' | 'quarterly';
export interface Recurring { id: string; userId: string; propertyId: string; serviceId: string; frequency: Frequency; startDate: string; endDate?: string; timeWindow: string; paymentMethod: string; status: 'active' | 'paused' | 'ended'; createdAt: string }
export const recurringService = {
  async create(userId: string, input: { propertyId: string; serviceId: string; frequency: Frequency; startDate: string; endDate?: string; timeWindow: string; paymentMethod: string }): Promise<Recurring> {
    const rows = await q<Record<string, unknown>>(
      `INSERT INTO property.recurring (user_id, property_id, service_id, frequency, start_date, end_date, time_window, payment_method)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [userId, input.propertyId, input.serviceId, input.frequency, input.startDate, input.endDate ?? null, input.timeWindow, input.paymentMethod],
    );
    return toRecurring(rows[0]);
  },
  async set(id: string, status: Recurring['status']) {
    const rows = await q<Record<string, unknown>>(`UPDATE property.recurring SET status=$2 WHERE id=$1 RETURNING *`, [id, status]);
    if (!rows[0]) throw new Error('NOT_FOUND');
    return toRecurring(rows[0]);
  },
  async forUser(userId: string) {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM property.recurring WHERE user_id=$1 ORDER BY created_at DESC`, [userId]);
    return rows.map(toRecurring);
  },
};
function toRecurring(r: Record<string, unknown>): Recurring {
  return {
    id: String(r.id), userId: String(r.user_id), propertyId: String(r.property_id), serviceId: String(r.service_id),
    frequency: r.frequency as Frequency, startDate: String(r.start_date), endDate: r.end_date ? String(r.end_date) : undefined,
    timeWindow: String(r.time_window), paymentMethod: String(r.payment_method),
    status: r.status as Recurring['status'], createdAt: String(r.created_at),
  };
}
