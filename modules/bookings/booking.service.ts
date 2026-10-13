// Bookings — Postgres-backed. Idempotent creation via UNIQUE(user_id, idempotency_key),
// price snapshot frozen, job events + outbox persisted.
import { price } from '../pricing/pricing.engine.js';
import { transition, type JobStatus } from '../job-engine/job.machine.js';
import { q } from '../../packages/database/db.js';
import { emit } from '../../packages/observability/emit.js';

export interface Booking {
  id: string; userId: string; serviceId: string; addressId: string;
  status: JobStatus; priceKobo: string; priceSnapshot: object;
  scheduledAt: string; urgency: string; customerNotes?: string;
  idempotencyKey: string; createdAt: string;
}
const toBooking = (r: Record<string, unknown>): Booking => ({
  id: String(r.id), userId: String(r.user_id), serviceId: String(r.service_id),
  addressId: r.address_id ? String(r.address_id) : '',
  status: r.status as JobStatus, priceKobo: String(r.price_kobo),
  priceSnapshot: r.price_snapshot as object,
  scheduledAt: r.scheduled_at ? String(r.scheduled_at) : '',
  urgency: String(r.urgency || 'standard'), customerNotes: r.customer_notes ? String(r.customer_notes) : undefined,
  idempotencyKey: String(r.idempotency_key), createdAt: String(r.created_at),
});

export const bookingService = {
  async create(userId: string, input: { serviceId: string; addressId: string; scheduledAt: string; urgency?: string; customerNotes?: string; addOnIds?: string[]; idempotencyKey: string }): Promise<Booking> {
    const prior = await q<Record<string, unknown>>(
      `SELECT * FROM booking.booking WHERE user_id=$1 AND idempotency_key=$2`, [userId, input.idempotencyKey],
    );
    if (prior[0]) return toBooking(prior[0]); // double-tap / retry safe
    const breakdown = await price({ serviceId: input.serviceId, addOnIds: input.addOnIds });
    try {
      const rows = await q<Record<string, unknown>>(
        `INSERT INTO booking.booking (user_id, service_id, address_id, status, price_kobo, price_snapshot, scheduled_at, idempotency_key)
         VALUES ($1,$2,$3,'REQUESTED',$4,$5,$6,$7) RETURNING *`,
        [userId, input.serviceId, input.addressId || null, String(breakdown.totalKobo), JSON.stringify(breakdown.snapshot), input.scheduledAt, input.idempotencyKey],
      );
      const b = toBooking(rows[0]);
      await q(`INSERT INTO outbox_event (topic, payload) VALUES ('booking.created',$1)`, [JSON.stringify({ bookingId: b.id })]);
      emit('booking.created', { bookingId: b.id, serviceId: b.serviceId });
      return b;
    } catch (e: unknown) {
      // concurrent double-insert -> second writer reads the winner
      const winner = await q<Record<string, unknown>>(
        `SELECT * FROM booking.booking WHERE user_id=$1 AND idempotency_key=$2`, [userId, input.idempotencyKey],
      );
      if (winner[0]) return toBooking(winner[0]);
      throw e;
    }
  },
  async get(id: string, userId?: string): Promise<Booking | null> {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM booking.booking WHERE id=$1`, [id]);
    const b = rows[0];
    if (!b) return null;
    if (userId && String(b.user_id) !== userId) throw new Error('FORBIDDEN'); // IDOR guard
    return toBooking(b);
  },
  async getRaw(id: string) {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM booking.booking WHERE id=$1`, [id]);
    return rows[0] ? toBooking(rows[0]) : null;
  },
  async list(userId: string, cursor?: string) {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM booking.booking WHERE user_id=$1 ORDER BY created_at DESC LIMIT 21`, [userId]);
    const items = rows.map(toBooking);
    void cursor;
    return { items: items.slice(0, 20), nextCursor: items.length > 20 ? items[19].id : null };
  },
  /** Admin console: recent bookings across all users (was `list('')` → empty). */
  async listAll(limit = 50) {
    const rows = await q<Record<string, unknown>>(
      `SELECT * FROM booking.booking ORDER BY created_at DESC LIMIT $1`, [Math.min(limit, 200)]);
    return { items: rows.map(toBooking) };
  },
  async listForProvider(providerId: string) {
    const rows = await q<Record<string, unknown>>(
      `SELECT b.* FROM booking.booking b
       JOIN dispatch.assignment a ON a.job_id = b.id
       WHERE a.provider_id=$1 AND a.status='accepted'
       ORDER BY b.created_at DESC LIMIT 50`,
      [providerId],
    );
    return { items: rows.map(toBooking) };
  },
  async cancel(id: string, userId: string): Promise<Booking> {
    const b = await this.get(id, userId);
    if (!b) throw new Error('FORBIDDEN');
    await transition(id, b.status, 'CANCELLED', userId);
    const rows = await q<Record<string, unknown>>(`UPDATE booking.booking SET status='CANCELLED' WHERE id=$1 RETURNING *`, [id]);
    await q(`INSERT INTO outbox_event (topic, payload) VALUES ('booking.cancelled',$1)`, [JSON.stringify({ bookingId: id })]);
    return toBooking(rows[0]);
  },
  async setStatus(id: string, to: JobStatus, actor: string): Promise<Booking> {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM booking.booking WHERE id=$1`, [id]);
    if (!rows[0]) throw new Error('NOT_FOUND');
    await transition(id, rows[0].status as JobStatus, to, actor);
    const upd = await q<Record<string, unknown>>(`UPDATE booking.booking SET status=$2 WHERE id=$1 RETURNING *`, [id, to]);
    return toBooking(upd[0]);
  },
  async timeline(id: string) {
    const rows = await q<Record<string, unknown>>(
      `SELECT from_status AS "from", to_status AS "to", actor, created_at AS at FROM booking.job_event WHERE job_id=$1 ORDER BY created_at`, [id],
    );
    return rows;
  },
};
