// Vendor storefronts — a vendor's own branded page on Kendibo, reachable by a
// short link (kendibo.ng/s/<slug>) they can paste into WhatsApp, Instagram or
// a flyer QR code. Every view and request that arrives through it is
// attributed to the vendor, and a request from it is offered to that vendor
// first (still subject to category rules).
//
// Trust rules: only verified, active vendors can publish; badges show only
// what was actually verified; ratings appear only once real reviews exist;
// the vendor's live location is never public.
import { z } from 'zod';
import { q } from '../../packages/database/db.js';
import { emit } from '../../packages/observability/emit.js';
import { providerService } from '../providers/provider.service.js';
import { formatNaira } from '../payments/money.js';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
// Words that would let a vendor impersonate the platform or collide with routes.
const RESERVED = new Set([
  'admin', 'api', 'app', 'help', 'support', 'kendibo', 'official', 'team', 'staff', 'login', 'signup', 'register',
  'pay', 'payment', 'payments', 'wallet', 'booking', 'bookings', 'provider', 'providers', 'vendor', 'vendors', 'store',
  'settings', 'security', 'verify', 'kyc', 'terms', 'privacy', 'about', 'careers', 'blog', 'press', 'status', 'www',
]);

const HOSTS: Record<string, string[]> = {
  instagram: ['instagram.com', 'www.instagram.com'],
  facebook: ['facebook.com', 'www.facebook.com', 'm.facebook.com'],
  tiktok: ['tiktok.com', 'www.tiktok.com'],
  x: ['x.com', 'twitter.com', 'www.x.com'],
  linkedin: ['linkedin.com', 'www.linkedin.com'],
  youtube: ['youtube.com', 'www.youtube.com', 'youtu.be'],
};
const socialUrl = (network: keyof typeof HOSTS) => z.string().url().max(200).refine((u) => {
  try { const x = new URL(u); return x.protocol === 'https:' && HOSTS[network].includes(x.hostname.toLowerCase()); }
  catch { return false; }
}, `Must be an https ${network} link`);

export const brandingSchema = z.object({
  tagline: z.string().trim().max(80).optional(),
  logoAssetId: z.string().max(64).nullable().optional(),
  coverAssetId: z.string().max(64).nullable().optional(),
  serviceAreas: z.array(z.string().trim().min(2).max(40)).max(12).optional(),
  socialLinks: z.object({
    instagram: socialUrl('instagram').optional(), facebook: socialUrl('facebook').optional(),
    tiktok: socialUrl('tiktok').optional(), x: socialUrl('x').optional(),
    linkedin: socialUrl('linkedin').optional(), youtube: socialUrl('youtube').optional(),
  }).partial().optional(),
});

export const publicBaseUrl = () => (process.env.STOREFRONT_BASE_URL || process.env.APP_URL || 'https://kendibo.pxxlspace.cv').replace(/\/+$/, '');

export function suggestSlug(name: string): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28);
  return base.length >= 3 ? base : `pro-${base || 'kendibo'}`;
}

// media.asset has no owner column yet, so the best available check is that the
// asset exists and passed the upload scanner. (Tracked as a follow-up: record
// the uploader on media.asset so branding can be restricted to own uploads.)
async function assetUsable(assetId: string, _userId: string): Promise<boolean> {
  const rows = await q(`SELECT 1 FROM media.asset WHERE id=$1 AND status='clean'`, [assetId]);
  return !!rows[0];
}

export const storefrontService = {
  async claimSlug(providerId: string, raw: string) {
    const slug = raw.trim().toLowerCase();
    if (!SLUG_RE.test(slug)) throw new Error('SLUG_FORMAT'); // 3-32 chars, a-z 0-9 and inner hyphens
    if (RESERVED.has(slug) || slug.includes('kendibo')) throw new Error('SLUG_RESERVED');
    const taken = await q<{ id: string }>(`SELECT id FROM provider.provider WHERE slug=$1`, [slug]);
    if (taken[0] && String(taken[0].id) !== providerId) throw new Error('SLUG_TAKEN');
    await q(`UPDATE provider.provider SET slug=$2 WHERE id=$1`, [providerId, slug]);
    emit('storefront.slug_claimed', { providerId, slug });
    return { slug, url: `${publicBaseUrl()}/s/${slug}` };
  },

  async updateBranding(providerId: string, userId: string, input: z.infer<typeof brandingSchema>) {
    const b = brandingSchema.parse(input);
    for (const id of [b.logoAssetId, b.coverAssetId]) {
      if (id && !(await assetUsable(id, userId))) throw new Error('ASSET_NOT_FOUND');
    }
    const sets: string[] = []; const vals: unknown[] = [providerId];
    const push = (col: string, v: unknown) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
    if (b.tagline !== undefined) push('tagline', b.tagline);
    if (b.logoAssetId !== undefined) push('logo_asset_id', b.logoAssetId);
    if (b.coverAssetId !== undefined) push('cover_asset_id', b.coverAssetId);
    if (b.serviceAreas !== undefined) push('service_areas', JSON.stringify(b.serviceAreas));
    if (b.socialLinks !== undefined) push('social_links', JSON.stringify(b.socialLinks));
    if (sets.length) await q(`UPDATE provider.provider SET ${sets.join(', ')} WHERE id=$1`, vals);
    return this.ownerView(providerId);
  },

  /** Publishing needs: verified + active, a slug, and the basics a customer needs to decide. */
  async publishChecklist(providerId: string) {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM provider.provider WHERE id=$1`, [providerId]);
    const p = rows[0];
    if (!p) throw new Error('PROVIDER_NOT_FOUND');
    const services = await q(`SELECT 1 FROM provider.skill WHERE provider_id=$1 LIMIT 1`, [providerId]);
    const missing: string[] = [];
    if (String(p.kyc_status ?? '').toUpperCase() !== 'VERIFIED') missing.push('verification');
    if (String(p.status ?? 'active') !== 'active') missing.push('account_active');
    if (!p.slug) missing.push('link');
    if (!p.business_name) missing.push('business_name');
    if (!p.bio || String(p.bio).trim().length < 40) missing.push('about');
    if (!services[0]) missing.push('services');
    return { ready: missing.length === 0, missing };
  },

  async setPublished(providerId: string, publish: boolean) {
    if (publish) {
      const c = await this.publishChecklist(providerId);
      if (!c.ready) { const e = new Error('NOT_READY') as Error & { missing?: string[] }; e.missing = c.missing; throw e; }
    }
    await q(
      `UPDATE provider.provider SET storefront_published=$2, published_at=CASE WHEN $2 THEN now() ELSE published_at END WHERE id=$1`,
      [providerId, publish],
    );
    emit('storefront.published', { providerId, published: publish });
    return this.ownerView(providerId);
  },

  async ownerView(providerId: string) {
    const rows = await q<Record<string, unknown>>(`SELECT * FROM provider.provider WHERE id=$1`, [providerId]);
    const p = rows[0];
    if (!p) throw new Error('PROVIDER_NOT_FOUND');
    return {
      slug: p.slug ? String(p.slug) : null,
      url: p.slug ? `${publicBaseUrl()}/s/${String(p.slug)}` : null,
      suggestedSlug: suggestSlug(String(p.business_name ?? 'my-business')),
      published: p.storefront_published === true,
      tagline: p.tagline ? String(p.tagline) : '',
      logoAssetId: p.logo_asset_id ? String(p.logo_asset_id) : null,
      coverAssetId: p.cover_asset_id ? String(p.cover_asset_id) : null,
      serviceAreas: (p.service_areas ?? []) as string[],
      socialLinks: (p.social_links ?? {}) as Record<string, string>,
      checklist: await this.publishChecklist(providerId),
    };
  },

  /** Public, privacy-safe view. Null when the vendor is not publicly listable. */
  async publicView(providerId: string, opts: { requirePublished?: boolean } = {}) {
    const p = await providerService.byId(providerId);
    if (!p) return null;
    const raw = (await q<Record<string, unknown>>(`SELECT * FROM provider.provider WHERE id=$1`, [providerId]))[0] ?? {};
    const verified = String(p.kycStatus ?? '').toUpperCase() === 'VERIFIED';
    const active = String(raw.status ?? 'active') === 'active';
    if (!verified || !active) return null;
    if (opts.requirePublished && raw.storefront_published !== true) return null;
    const gallery = await providerService.gallery(providerId).catch(() => []);
    const stats = await q<{ n: string; avg: string | null }>(
      `SELECT COUNT(*) AS n, AVG(provider) AS avg FROM payment.review WHERE provider_id=$1`, [providerId],
    ).catch(() => [{ n: '0', avg: null }]);
    const reviewCount = Number(stats[0]?.n ?? 0);
    const jobs = await q<{ n: string }>(`SELECT COUNT(*) AS n FROM provider.earning WHERE provider_id=$1`, [providerId]).catch(() => [{ n: '0' }]);
    const opHours = (p.operatingHours ?? {}) as Record<string, unknown>;
    const categories = await q<{ id: string; name: string }>(
      `SELECT c.id, c.name FROM provider.category_enrollment e JOIN catalog.category c ON c.id=e.category_id
        WHERE e.provider_id=$1 AND e.status='eligible' ORDER BY c.sort_order`, [providerId],
    ).catch(() => []);
    const name = p.businessName || p.displayName || 'Kendibo vendor';
    // Home products the vendor sells (052), as their own list; customers see the price, not the split.
    const { offeringService } = await import('../vendors/offering.service.js');
    const products = (await offeringService.listForProvider(providerId, false, 'product').catch(() => []))
      .map((o) => ({
        id: o.id, categoryId: o.categoryId, name: o.name, description: o.description, priceKobo: o.priceKobo,
        priceUnit: o.priceUnit, stockNote: o.stockNote, maxQuantity: o.maxQuantity, photoUrl: o.photoUrl,
      }));
    return {
      id: p.id,
      slug: raw.slug ? String(raw.slug) : null,
      url: raw.slug ? `${publicBaseUrl()}/s/${String(raw.slug)}` : null,
      name,
      businessName: name,
      headline: p.headline ?? null,
      tagline: raw.tagline ? String(raw.tagline) : null,
      bio: p.bio ?? null,
      logoAssetId: raw.logo_asset_id ? String(raw.logo_asset_id) : null,
      coverAssetId: raw.cover_asset_id ? String(raw.cover_asset_id) : null,
      officeCity: p.officeCity ?? null,
      officeLandmark: p.officeLandmark ?? null,
      serviceAreas: (raw.service_areas ?? []) as string[],
      serviceRadiusKm: p.serviceRadiusKm ?? 15,
      // Honest stats: no rating until real reviews exist.
      rating: reviewCount > 0 ? Math.round(Number(stats[0]?.avg ?? 0) * 10) / 10 : null,
      reviewCount,
      completedJobs: Number(jobs[0]?.n ?? 0),
      badges: {
        identityVerified: verified,
        faceVerified: Boolean(p.faceVerified),
        businessRegistered: raw.cac_verified === true,
      },
      categories: categories.map((c) => ({ id: String(c.id), name: String(c.name) })),
      skills: p.skills ?? [],
      operatingHours: p.operatingHours ?? {},
      packages: Array.isArray(opHours.packages) ? opHours.packages : [],
      products,
      socialLinks: (raw.social_links ?? {}) as Record<string, string>,
      gallery,
    };
  },

  async bySlug(slug: string) {
    const rows = await q<{ id: string }>(`SELECT id FROM provider.provider WHERE slug=$1`, [slug.toLowerCase()]);
    if (!rows[0]) return null;
    return this.publicView(String(rows[0].id), { requirePublished: true });
  },

  async track(providerId: string, kind: 'view' | 'share' | 'request' | 'booking', channel?: string) {
    await q(`INSERT INTO provider.storefront_event (provider_id, kind, channel) VALUES ($1,$2,$3)`, [providerId, kind, (channel ?? 'link').slice(0, 24)])
      .catch(() => undefined);
  },

  async insights(providerId: string, days = 30) {
    const since = new Date(Date.now() - Math.min(days, 365) * 86_400_000).toISOString();
    const rows = await q<{ kind: string; n: string }>(
      `SELECT kind, COUNT(*) AS n FROM provider.storefront_event WHERE provider_id=$1 AND created_at >= $2 GROUP BY kind`, [providerId, since],
    );
    const by = Object.fromEntries(rows.map((r) => [String(r.kind), Number(r.n)]));
    const requests = await q<{ n: string }>(
      `SELECT COUNT(*) AS n FROM booking.service_request WHERE preferred_provider_id=$1 AND created_at >= $2`, [providerId, since],
    ).catch(() => [{ n: '0' }]);
    return { days, views: by.view ?? 0, shares: by.share ?? 0, requests: Number(requests[0]?.n ?? 0) };
  },

  /** Copy-ready share kit: link, WhatsApp text and a wa.me deep link. */
  async shareKit(providerId: string) {
    const v = await this.ownerView(providerId);
    if (!v.url) throw new Error('NO_LINK');
    const rows = await q<{ business_name: string }>(`SELECT business_name FROM provider.provider WHERE id=$1`, [providerId]);
    const name = String(rows[0]?.business_name ?? 'my business');
    const text = `Book ${name} on Kendibo — see my work, prices and reviews, and pay safely in the app: ${v.url}?src=wa`;
    return {
      url: v.url,
      whatsappText: text,
      whatsappShareUrl: `https://wa.me/?text=${encodeURIComponent(text)}`,
      qrPayload: `${v.url}?src=qr`,
      published: v.published,
    };
  },
};

// ── Server-rendered share page ────────────────────────────────────────────
// WhatsApp, Instagram and Facebook build link previews from OpenGraph tags in
// the raw HTML, so /s/<slug> is rendered on the server. Every interpolated
// value is HTML-escaped.
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/**
 * "Connect on WhatsApp": opens a chat with Kendibo's number (never the vendor's),
 * prefilled with the storefront reference the bot uses to route the booking.
 */
export function waConnect(sf: { name: string; slug: string | null }): string | null {
  const number = (process.env.WHATSAPP_BUSINESS_NUMBER ?? '').replace(/\D/g, '');
  if (!/^[1-9]\d{7,14}$/.test(number) || !sf.slug) return null;
  return `https://wa.me/${number}?text=${encodeURIComponent(`Hi Kendibo, I'd like to book ${sf.name} (ref KB-${sf.slug})`)}`;
}

export function renderStorefrontPage(sf: NonNullable<Awaited<ReturnType<typeof storefrontService.publicView>>>, opts: { appScheme?: string } = {}): string {
  const base = publicBaseUrl();
  const title = `${sf.name} on Kendibo`;
  const desc = sf.tagline || sf.headline || (sf.categories.length ? `${sf.categories.map((c) => c.name).join(', ')} in ${sf.officeCity ?? 'your area'}` : 'Book a verified home-service pro on Kendibo');
  const deepLink = `${opts.appScheme ?? 'kendibo'}://provider/${encodeURIComponent(sf.id)}`;
  // Media URLs are signed and short-lived, so previews use the stable brand card.
  const image = `${(process.env.APP_URL || base).replace(/\/+$/, '')}/og-kendibo-preview.png`;
  const badges = [
    sf.badges.identityVerified ? 'ID verified' : '',
    sf.badges.faceVerified ? 'Face matched' : '',
    sf.badges.businessRegistered ? 'CAC registered' : '',
  ].filter(Boolean);
  const rating = sf.rating !== null ? `${sf.rating.toFixed(1)} from ${sf.reviewCount} review${sf.reviewCount === 1 ? '' : 's'}` : 'New on Kendibo';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(sf.url ?? base)}">
<meta property="og:type" content="profile">
<meta property="og:site_name" content="Kendibo">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(sf.url ?? base)}">
<meta property="og:image" content="${esc(image)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#1D5BD6">
<style>
:root{--ink:#0F172A;--sub:#475569;--line:#E2E8F0;--brand:#1D5BD6;--bg:#F6F7F9}
*{box-sizing:border-box}body{margin:0;font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg)}
main{max-width:560px;margin:0 auto;padding:24px 16px 96px}
.card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:20px;margin-bottom:12px}
h1{font-size:24px;line-height:1.25;margin:0 0 4px}p{margin:0;color:var(--sub)}
.badges{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.badge{font-size:13px;font-weight:600;color:#15803D;background:#EAF6EE;border-radius:999px;padding:4px 10px}
.meta{margin-top:12px;font-size:14px;color:var(--sub)}ul{margin:8px 0 0;padding-left:18px;color:var(--sub)}
.cta{position:fixed;left:0;right:0;bottom:0;padding:12px 16px calc(12px + env(safe-area-inset-bottom));background:#fff;border-top:1px solid var(--line)}
.cta a{display:block;max-width:528px;margin:0 auto;text-align:center;background:var(--brand);color:#fff;font-weight:700;text-decoration:none;border-radius:12px;padding:14px;min-height:48px}
</style>
</head>
<body>
<main>
  <section class="card">
    <h1>${esc(sf.name)}</h1>
    <p>${esc(sf.tagline || sf.headline || '')}</p>
    ${badges.length ? `<div class="badges">${badges.map((b) => `<span class="badge">${esc(b)}</span>`).join('')}</div>` : ''}
    <div class="meta">${esc(rating)} · ${esc(String(sf.completedJobs))} jobs completed${sf.officeCity ? ` · ${esc(sf.officeCity)}` : ''}</div>
  </section>
  ${sf.bio ? `<section class="card"><h2 style="font-size:17px;margin:0 0 6px">About</h2><p>${esc(sf.bio)}</p></section>` : ''}
  ${sf.categories.length ? `<section class="card"><h2 style="font-size:17px;margin:0 0 6px">Services</h2><ul>${sf.categories.map((c) => `<li>${esc(c.name)}</li>`).join('')}</ul></section>` : ''}
  ${sf.products.length ? `<section class="card"><h2 style="font-size:17px;margin:0 0 6px">Products</h2><ul>${sf.products.map((o) => `<li>${esc(o.name)} · ${esc(formatNaira(BigInt(o.priceKobo)))} per item${o.stockNote ? ` · ${esc(o.stockNote)}` : ''}</li>`).join('')}</ul></section>` : ''}
  ${sf.serviceAreas.length ? `<section class="card"><h2 style="font-size:17px;margin:0 0 6px">Areas covered</h2><p>${esc(sf.serviceAreas.join(', '))}</p></section>` : ''}
  <p style="font-size:13px;text-align:center;margin-top:16px">Payments are held by Kendibo until the job is done.</p>
</main>
<div class="cta">
  <a href="${esc(deepLink)}">Book ${esc(sf.name)} in the app</a>
  ${waConnect(sf) ? `<a href="${esc(waConnect(sf)!)}" style="margin-top:8px;background:#fff;color:#14212b;border:1px solid #d0d5dd" aria-label="Connect with ${esc(sf.name)} on WhatsApp through Kendibo">Connect on WhatsApp</a>
  <p style="text-align:center;font-size:12px;margin-top:6px;color:#52606d">Chats go through Kendibo, so your number stays private and payment stays protected.</p>` : ''}
  <p style="text-align:center;font-size:13px;margin-top:8px"><a style="all:unset;color:#1D5BD6;font-weight:600;cursor:pointer" href="${esc(`${(process.env.APP_URL || base).replace(/\/+$/, '')}/#/download`)}">Don't have Kendibo yet? Get the app</a></p>
</div>
</body>
</html>`;
}
