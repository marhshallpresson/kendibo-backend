// Catalog — DB-driven (catalog.* tables seeded in 004_reference_data.sql).
import { q } from '../../packages/database/db.js';

export interface Service { id: string; category: string; name: string; bookingMode: 'fixed' | 'quote'; baseKobo: bigint; warrantyDays: number; durationMinutes: number; requiresSkill?: string; }
export interface AddOn { id: string; serviceId: string; name: string; priceKobo: bigint; }

export const catalogService = {
  async categories(): Promise<string[]> {
    const rows = await q<{ name: string }>(`SELECT name FROM catalog.category WHERE active ORDER BY sort_order`);
    return rows.map((r) => r.name);
  },
  async list(category?: string): Promise<Service[]> {
    const rows = await q<Record<string, unknown>>(
      `SELECT s.id, c.name AS category, s.name, s.booking_type, s.base_price_kobo, s.warranty_days, s.duration_minutes, s.requires_skill
       FROM catalog.service s JOIN catalog.category c ON c.id = s.category_id
       WHERE s.active AND ($1::text IS NULL OR c.name = $1)`, [category ?? null],
    );
    return rows.map(toService);
  },
  async get(id: string): Promise<Service | null> {
    const rows = await q<Record<string, unknown>>(
      `SELECT s.id, c.name AS category, s.name, s.booking_type, s.base_price_kobo, s.warranty_days, s.duration_minutes, s.requires_skill
       FROM catalog.service s JOIN catalog.category c ON c.id = s.category_id WHERE s.id=$1`, [id],
    );
    return rows[0] ? toService(rows[0]) : null;
  },
  async addOns(serviceId: string): Promise<AddOn[]> {
    const rows = await q<Record<string, unknown>>(`SELECT id, service_id, name, price_kobo FROM catalog.addon WHERE service_id=$1`, [serviceId]);
    return rows.map((r) => ({ id: String(r.id), serviceId: String(r.service_id), name: String(r.name), priceKobo: BigInt(String(r.price_kobo)) }));
  },
  async search(query: string): Promise<Service[]> {
    const all = await this.list();
    return all.filter((s) => `${s.category} ${s.name}`.toLowerCase().includes(query.toLowerCase()));
  },
};
function toService(r: Record<string, unknown>): Service {
  return {
    id: String(r.id), category: String(r.category), name: String(r.name),
    bookingMode: r.booking_type === 'quote' ? 'quote' : 'fixed',
    baseKobo: BigInt(String(r.base_price_kobo)), warrantyDays: Number(r.warranty_days),
    durationMinutes: Number(r.duration_minutes),
    requiresSkill: (r.requires_skill as string) ?? undefined,
  };
}
