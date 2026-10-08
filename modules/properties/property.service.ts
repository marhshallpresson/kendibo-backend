// Properties + Nigerian addresses + assets — Postgres-backed.
import { z } from 'zod';
import { q } from '../../packages/database/db.js';

export const addressSchema = z.object({
  houseNumber: z.string(), street: z.string(), area: z.string().optional(),
  city: z.string(), state: z.string(),
  estate: z.string().optional(), landmark: z.string().optional(),
  gateInstructions: z.string().optional(), contactPhone: z.string(),
  latitude: z.number().optional(), longitude: z.number().optional(),
});
export interface Address extends z.infer<typeof addressSchema> { id: string; userId: string; isDefault: boolean; createdAt: string }
export interface Asset { id: string; propertyId: string; kind: string; brand?: string; installedAt?: string; lastServicedAt?: string; warrantyUntil?: string }
export interface Property { id: string; userId: string; name: string; addressId: string; createdAt: string }

export const propertyService = {
  async createAddress(userId: string, input: unknown): Promise<Address> {
    const a = addressSchema.parse(input);
    const existing = await q<{ id: string }>(`SELECT id FROM property.address WHERE user_id=$1 LIMIT 1`, [userId]);
    const rows = await q<Record<string, unknown>>(
      `INSERT INTO property.address (user_id, lat, lng, street, house_number, estate, landmark, gate_notes, contact_phone, city, state, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [userId, a.latitude ?? null, a.longitude ?? null, a.street, a.houseNumber, a.estate ?? null,
       a.landmark ?? null, a.gateInstructions ?? null, a.contactPhone, a.city, a.state, existing.length === 0],
    );
    return toAddress(rows[0]);
  },
  async listAddresses(userId: string, cursor?: string) {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM property.address WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`, [userId]);
    void cursor;
    const items = rows.map(toAddress);
    return { items, nextCursor: null as string | null };
  },
  async setDefault(userId: string, id: string) {
    await q(`UPDATE property.address SET is_default=(id=$2) WHERE user_id=$1`, [userId, id]);
    const rows = await q<Record<string, unknown>>(`SELECT * FROM property.address WHERE id=$1 AND user_id=$2`, [id, userId]);
    return rows[0] ? toAddress(rows[0]) : null;
  },
  async updateAddress(userId: string, id: string, input: unknown): Promise<Address | null> {
    const a = addressSchema.partial().parse(input);
    const sets: string[] = [];
    const vals: unknown[] = [userId, id];
    const col = (sql: string, v: unknown) => { vals.push(v); sets.push(`${sql}=$${vals.length}`); };
    if (a.latitude !== undefined) col('lat', a.latitude);
    if (a.longitude !== undefined) col('lng', a.longitude);
    if (a.street !== undefined) col('street', a.street);
    if (a.houseNumber !== undefined) col('house_number', a.houseNumber);
    if (a.estate !== undefined) col('estate', a.estate);
    if (a.landmark !== undefined) col('landmark', a.landmark);
    if (a.gateInstructions !== undefined) col('gate_notes', a.gateInstructions);
    if (a.contactPhone !== undefined) col('contact_phone', a.contactPhone);
    if (a.city !== undefined) col('city', a.city);
    if (a.state !== undefined) col('state', a.state);
    if (sets.length === 0) {
      const rows = await q<Record<string, unknown>>(`SELECT * FROM property.address WHERE id=$2 AND user_id=$1`, [userId, id]);
      return rows[0] ? toAddress(rows[0]) : null;
    }
    const rows = await q<Record<string, unknown>>(
      `UPDATE property.address SET ${sets.join(', ')} WHERE user_id=$1 AND id=$2 RETURNING *`, vals,
    );
    return rows[0] ? toAddress(rows[0]) : null;
  },
  async deleteAddress(userId: string, id: string): Promise<boolean> {
    const current = await q<{ id: string }>(`SELECT id FROM property.address WHERE user_id=$1 AND id=$2`, [userId, id]);
    if (current.length === 0) return false;
    await q(`UPDATE property.property SET address_id=NULL WHERE address_id=$1 AND owner_id=$2`, [id, userId]);
    await q(`DELETE FROM property.address WHERE user_id=$1 AND id=$2`, [userId, id]);
    // If the deleted address was the default, promote the most recent remaining one.
    await q(
      `UPDATE property.address SET is_default=TRUE
       WHERE user_id=$1 AND is_default=FALSE AND id=(
         SELECT id FROM property.address WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1
       ) AND NOT EXISTS (SELECT 1 FROM property.address WHERE user_id=$1 AND is_default)`,
      [userId],
    );
    return true;
  },
  async createProperty(userId: string, name: string, addressId: string): Promise<Property> {
    const rows = await q<Record<string, unknown>>(
      `INSERT INTO property.property (owner_id, name, address_id) VALUES ($1,$2,$3) RETURNING *`, [userId, name, addressId || null],
    );
    const r = rows[0];
    return { id: String(r.id), userId: String(r.owner_id), name: String(r.name), addressId: r.address_id ? String(r.address_id) : '', createdAt: String(r.created_at) };
  },
  async addAsset(propertyId: string, kind: string, brand?: string): Promise<Asset> {
    const rows = await q<Record<string, unknown>>(
      `INSERT INTO property.asset (property_id, category, brand) VALUES ($1,$2,$3) RETURNING *`, [propertyId, kind, brand ?? null],
    );
    const r = rows[0];
    return { id: String(r.id), propertyId: String(r.property_id), kind: String(r.category), brand: (r.brand as string) ?? undefined };
  },
  async assetsOf(propertyId: string): Promise<Asset[]> {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM property.asset WHERE property_id=$1`, [propertyId]);
    return rows.map((r) => ({ id: String(r.id), propertyId: String(r.property_id), kind: String(r.category), brand: (r.brand as string) ?? undefined }));
  },
};
function toAddress(r: Record<string, unknown>): Address {
  return {
    houseNumber: String(r.house_number ?? ''), street: String(r.street ?? ''), city: String(r.city ?? ''), state: String(r.state ?? ''),
    estate: (r.estate as string) ?? undefined, landmark: (r.landmark as string) ?? undefined,
    gateInstructions: (r.gate_notes as string) ?? undefined, contactPhone: String(r.contact_phone ?? ''),
    latitude: r.lat as number ?? undefined, longitude: r.lng as number ?? undefined,
    id: String(r.id), userId: String(r.user_id), isDefault: Boolean(r.is_default), createdAt: String(r.created_at),
  };
}
