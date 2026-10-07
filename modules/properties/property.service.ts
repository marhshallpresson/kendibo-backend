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
      `INSERT INTO property.address (user_id, lat, lng, street, house_number, estate, landmark, gate_notes, contact_phone, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [userId, a.latitude ?? null, a.longitude ?? null, a.street, a.houseNumber, a.estate ?? null,
       a.landmark ?? null, a.gateInstructions ?? null, a.contactPhone, existing.length === 0],
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
    const rows = await q<Record<string, unknown>>(`SELECT * FROM property.address WHERE id=$1`, [id]);
    return rows[0] ? toAddress(rows[0]) : null;
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
    houseNumber: String(r.house_number ?? ''), street: String(r.street ?? ''), city: '', state: '',
    estate: (r.estate as string) ?? undefined, landmark: (r.landmark as string) ?? undefined,
    gateInstructions: (r.gate_notes as string) ?? undefined, contactPhone: String(r.contact_phone ?? ''),
    latitude: r.lat as number ?? undefined, longitude: r.lng as number ?? undefined,
    id: String(r.id), userId: String(r.user_id), isDefault: Boolean(r.is_default), createdAt: String(r.created_at),
  };
}
