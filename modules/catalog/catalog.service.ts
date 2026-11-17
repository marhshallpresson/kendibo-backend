// Catalog — DB-driven (catalog.* tables seeded in 004_reference_data.sql and
// 051_catalog_categories.sql: 9 groups, 58 landing-page trades + products).
import { q } from '../../packages/database/db.js';

export interface Service {
  id: string;
  /** Category id (e.g. 'ac'). Was the display name before 051; the app reads it as an id. */
  category: string;
  categoryId: string;
  categoryName: string;
  name: string; bookingMode: 'fixed' | 'quote'; baseKobo: bigint; warrantyDays: number; durationMinutes: number; requiresSkill?: string;
  /** Set when the listing is a verified vendor's offering (id is then the offering id). */
  source?: 'offering'; offeringId?: string; providerId?: string; providerName?: string;
  priceUnit?: string; description?: string; rating?: number; reviewCount?: number; completedJobs?: number;
}
export interface AddOn { id: string; serviceId: string; name: string; priceKobo: bigint; }
export type CategoryKind = 'service' | 'product';
export interface Category {
  id: string; name: string; shortName: string; description: string; iconName: string; sortOrder: number; isActive: boolean;
  group: string; groupName: string; kind: CategoryKind; isNew: boolean; keywords: string[];
}
export interface CategoryGroup { id: string; name: string; shortName: string; kind: CategoryKind; iconName: string; sortOrder: number; categories: Category[] }

/** TEXT[] comes back as an array from Postgres; pg-mem can hand back the literal '{}' for defaulted rows. */
export function toKeywords(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).toLowerCase().trim()).filter(Boolean);
  if (typeof v === 'string' && v.startsWith('{')) {
    const body = v.slice(1, -1).trim();
    if (!body) return [];
    return body.split(',').map((x) => x.trim().replace(/^"|"$/g, '').toLowerCase()).filter(Boolean);
  }
  return [];
}

const asKind = (v: unknown): CategoryKind => (v === 'product' ? 'product' : 'service');

async function groupRows(): Promise<Omit<CategoryGroup, 'categories'>[]> {
  const rows = await q<Record<string, unknown>>(`SELECT id, name, short_name, sort_order, icon_name, kind FROM catalog.category_group ORDER BY sort_order`).catch(() => []);
  return rows.map((g) => ({
    id: String(g.id), name: String(g.name), shortName: String(g.short_name ?? g.name), kind: asKind(g.kind),
    iconName: String(g.icon_name ?? 'Sparkles'), sortOrder: Number(g.sort_order ?? 0),
  }));
}

/** Active service offerings of verified, active, real (non-test, non-suspended) vendors, as catalog listings. */
async function offeringListings(f: { category?: string; id?: string }): Promise<Service[]> {
  const rows = await q<Record<string, unknown>>(
    `SELECT o.id, o.category_id, c.name AS category_name, o.name, o.description, o.price_kobo, o.price_unit, o.duration_minutes, o.created_at,
            p.id AS provider_id, p.business_name, p.rating, u.name AS user_name
       FROM provider.offering o
       JOIN provider.provider p ON p.id = o.provider_id
       JOIN identity.users u ON u.id = p.user_id
       JOIN catalog.category c ON c.id = o.category_id
      WHERE o.active AND COALESCE(o.kind, 'service') = 'service' AND c.active
        AND p.kyc_status = 'VERIFIED' AND p.status = 'active'
        AND COALESCE(u.is_test, false) = false AND u.suspended_at IS NULL
        AND ($1::text IS NULL OR c.id = $1 OR c.name = $1)
        AND ($2::text IS NULL OR o.id::text = $2)`,
    [f.category ?? null, f.id ?? null],
  );
  if (!rows.length) return [];
  const jobs = new Map<string, number>();
  const reviews = new Map<string, number>();
  for (const r of await q<{ provider_id: string; n: string }>(`SELECT provider_id, COUNT(*) AS n FROM provider.earning GROUP BY provider_id`).catch(() => [])) jobs.set(String(r.provider_id), Number(r.n));
  for (const r of await q<{ provider_id: string; n: string }>(`SELECT provider_id, COUNT(*) AS n FROM payment.review GROUP BY provider_id`).catch(() => [])) reviews.set(String(r.provider_id), Number(r.n));
  // Only vendors booking would accept: the same gate offeringService.book applies (vendorEligibilityService.allowed).
  const { vendorEligibilityService, eligibilityEnforced } = await import('../vendors/eligibility.service.js');
  const gate = new Map<string, boolean>();
  const eligible: Record<string, unknown>[] = [];
  for (const r of rows) {
    if (eligibilityEnforced()) {
      const key = `${r.provider_id}|${r.category_id}|${r.price_kobo}`;
      if (!gate.has(key)) gate.set(key, await vendorEligibilityService.canWork(String(r.provider_id), String(r.category_id), { amountKobo: BigInt(String(r.price_kobo)) }).catch(() => false));
      if (!gate.get(key)) continue;
    }
    eligible.push(r);
  }
  if (!eligible.length) return [];
  const out = eligible.map((r) => {
    const pid = String(r.provider_id);
    return {
      svc: {
        ...toService({ ...r, booking_type: 'fixed', base_price_kobo: r.price_kobo, warranty_days: 0, duration_minutes: r.duration_minutes ?? 60 }),
        source: 'offering' as const, offeringId: String(r.id), providerId: pid,
        providerName: String(r.business_name ?? r.user_name ?? 'Kendibo vendor'),
        priceUnit: String(r.price_unit ?? 'job'), description: r.description ? String(r.description) : '',
        rating: Number(r.rating ?? 0), reviewCount: reviews.get(pid) ?? 0, completedJobs: jobs.get(pid) ?? 0,
      } as Service,
      created: new Date(String(r.created_at)).getTime() || 0,
    };
  });
  out.sort((a, b) => (b.svc.completedJobs! - a.svc.completedJobs!) || (b.svc.rating! - a.svc.rating!) || (b.created - a.created) || a.svc.id.localeCompare(b.svc.id));
  return out.map((x) => x.svc);
}

export const catalogService = {
  async categories(opts: { kind?: CategoryKind } = {}): Promise<Category[]> {
    const rows = await q<Record<string, unknown>>(
      `SELECT id, name, short_name, description, icon_name, sort_order, active, kind, keywords, is_new, group_id
         FROM catalog.category WHERE active ORDER BY sort_order`,
    );
    const groups = new Map((await groupRows()).map((g) => [g.id, g]));
    const out = rows.map((r) => {
      const gid = r.group_id && groups.has(String(r.group_id)) ? String(r.group_id) : 'other';
      return {
        id: String(r.id), name: String(r.name), shortName: String(r.short_name ?? r.name), description: String(r.description ?? ''),
        iconName: String(r.icon_name ?? 'Sparkles'), sortOrder: Number(r.sort_order ?? 0), isActive: Boolean(r.active),
        group: gid, groupName: groups.get(gid)?.name ?? 'Other Services', kind: asKind(r.kind), isNew: r.is_new === true,
        keywords: toKeywords(r.keywords),
      };
    });
    // pg-mem ignores ORDER BY next to some indexes; keep the order stable here.
    out.sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
    return opts.kind ? out.filter((c) => c.kind === opts.kind) : out;
  },

  /** Groups in display order, each with its active categories; empty groups are left out. */
  async grouped(opts: { kind?: CategoryKind } = {}): Promise<CategoryGroup[]> {
    const cats = await this.categories(opts);
    const groups = await groupRows();
    return groups
      .map((g) => ({ ...g, categories: cats.filter((c) => c.group === g.id) }))
      .filter((g) => g.categories.length > 0 && (!opts.kind || g.kind === opts.kind || g.categories.some((c) => c.kind === opts.kind)));
  },

  /**
   * The public service list is built from real vendor offerings: active
   * offerings of VERIFIED, active, non-suspended, non-test vendors. Nothing is
   * stored, so verifying a vendor, or adding/editing/pausing/removing an
   * offering (or suspending/un-verifying the vendor), shows on the next read.
   * Most popular first: completed jobs, then rating, then newest.
   */
  async list(category?: string): Promise<Service[]> {
    return offeringListings({ category });
  },
  async get(id: string): Promise<Service | null> {
    // Legacy catalog.service rows (existing bookings reference them) first, then vendor offerings.
    const rows = await q<Record<string, unknown>>(
      `SELECT s.id, s.category_id, c.name AS category_name, s.name, s.booking_type, s.base_price_kobo, s.warranty_days, s.duration_minutes, s.requires_skill
       FROM catalog.service s JOIN catalog.category c ON c.id = s.category_id WHERE s.id=$1`, [id],
    );
    if (rows[0]) return toService(rows[0]);
    return (await offeringListings({ id }))[0] ?? null;
  },
  async addOns(serviceId: string): Promise<AddOn[]> {
    const rows = await q<Record<string, unknown>>(`SELECT id, service_id, name, price_kobo FROM catalog.addon WHERE service_id=$1`, [serviceId]);
    return rows.map((r) => ({ id: String(r.id), serviceId: String(r.service_id), name: String(r.name), priceKobo: BigInt(String(r.price_kobo)) }));
  },
  async search(query: string): Promise<Service[]> {
    const all = await this.list();
    const needle = query.toLowerCase();
    return all.filter((s) => `${s.categoryId} ${s.categoryName} ${s.name}`.toLowerCase().includes(needle));
  },
};
function toService(r: Record<string, unknown>): Service {
  return {
    id: String(r.id), category: String(r.category_id), categoryId: String(r.category_id), categoryName: String(r.category_name ?? r.category_id),
    name: String(r.name),
    bookingMode: r.booking_type === 'quote' ? 'quote' : 'fixed',
    baseKobo: BigInt(String(r.base_price_kobo)), warrantyDays: Number(r.warranty_days),
    durationMinutes: Number(r.duration_minutes),
    requiresSkill: (r.requires_skill as string) ?? undefined,
  };
}
