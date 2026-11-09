// MapsPort — geocode/reverse abstraction with Google Maps primary provider.
//
// The active provider and its ordered fallbacks live in configuration.platform_setting
// (keys `maps.provider` / `maps.fallbacks`), editable by admins via
// PUT /v1/admin/maps/config — no redeploy needed to swap Google ⇄ Mapbox ⇄ OSM.
import { q } from '../../packages/database/db';

export interface MapsPort {
  geocode(query: string, city?: string): Promise<{ lat: number; lng: number; formatted: string } | null>;
  reverse(lat: number, lng: number): Promise<{ area: string; city: string; formatted?: string } | null>;
}

/** Per-attempt network budget — geocoding must never hold a booking request. */
const ATTEMPT_TIMEOUT_MS = 4000;

function fetchJson(url: string, headers?: Record<string, string>): Promise<unknown> {
  return fetch(url, { headers, signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS) }).then((r) => {
    if (!r.ok) throw new Error(`maps http ${r.status}`);
    return r.json();
  });
}

/** Dev-only deterministic adapter. Never constructed in production. */
export class StubMapsAdapter implements MapsPort {
  async geocode(query: string, city = 'uyo') {
    if (!query.trim()) return null;
    return { lat: 5.0399, lng: 7.9228, formatted: `${query}, ${city}` };
  }
  async reverse(_lat: number, _lng: number) {
    return { area: 'Ikpa Road', city: 'Uyo', formatted: 'Ikpa Road, Uyo' };
  }
}

export class MapboxAdapter implements MapsPort {
  available() { return Boolean(process.env.MAPBOX_ACCESS_TOKEN); }
  async geocode(query: string, city = 'uyo') {
    if (!query.trim()) return null;
    const token = process.env.MAPBOX_ACCESS_TOKEN;
    const q = city && !query.toLowerCase().includes(city.toLowerCase()) ? `${query}, ${city}, Nigeria` : `${query}, Nigeria`;
    const data = await fetchJson(
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?country=ng&access_token=${token}`,
    ) as { features?: Array<{ center: [number, number]; place_name: string }> };
    if (!data.features?.length) return null;
    const [lng, lat] = data.features[0].center;
    return { lat, lng, formatted: data.features[0].place_name };
  }
  async reverse(lat: number, lng: number) {
    const token = process.env.MAPBOX_ACCESS_TOKEN;
    const data = await fetchJson(
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?access_token=${token}`,
    ) as { features?: Array<{ place_type: string[]; text: string; place_name?: string }> };
    if (!data.features?.length) return null;
    let city = '';
    let area = '';
    for (const f of data.features) {
      if (!city && (f.place_type.includes('place') || f.place_type.includes('district') || f.place_type.includes('region'))) {
        city = f.text;
      }
      if (!area && (f.place_type.includes('address') || f.place_type.includes('poi') || f.place_type.includes('neighborhood') || f.place_type.includes('locality'))) {
        area = f.text;
      }
    }
    const formatted = data.features[0]?.place_name;
    if (!area && formatted) area = formatted.split(',')[0]?.trim() || '';
    if (!area && !city) return null;
    return { area: area || city, city: city || area, formatted };
  }
}

/** Google Geocoding REST API. Scales globally; billing-enabled key required. */
export class GoogleMapsAdapter implements MapsPort {
  private key() {
    return process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_BROWSER_KEY || '';
  }
  available() { return Boolean(this.key()); }
  async geocode(query: string, city = 'uyo') {
    if (!query.trim()) return null;
    const key = this.key();
    const q = city && !query.toLowerCase().includes(city.toLowerCase()) ? `${query}, ${city}, Nigeria` : `${query}, Nigeria`;
    const data = await fetchJson(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&region=ng&key=${key}`,
    ) as { status: string; results?: Array<{ geometry: { location: { lat: number; lng: number } }; formatted_address: string }> };
    if (data.status !== 'OK' || !data.results?.length) return null;
    const r = data.results[0];
    return { lat: r.geometry.location.lat, lng: r.geometry.location.lng, formatted: r.formatted_address };
  }
  async reverse(lat: number, lng: number) {
    const key = this.key();
    const data = await fetchJson(
      `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${key}`,
    ) as { status: string; results?: Array<{ address_components: Array<{ long_name: string; types: string[] }>; formatted_address: string }> };
    if (data.status !== 'OK' || !data.results?.length) return null;
    const primary = data.results[0];
    let streetNumber = '';
    let route = '';
    let neighborhood = '';
    let city = '';
    let state = '';
    for (const comp of primary.address_components) {
      if (comp.types.includes('street_number')) streetNumber = comp.long_name;
      if (comp.types.includes('route')) route = comp.long_name;
      if (!neighborhood && (comp.types.includes('neighborhood') || comp.types.includes('sublocality') || comp.types.includes('sublocality_level_1') || comp.types.includes('premise'))) {
        neighborhood = comp.long_name;
      }
      if (!city && (comp.types.includes('locality') || comp.types.includes('administrative_area_level_2'))) {
        city = comp.long_name;
      }
      if (!state && comp.types.includes('administrative_area_level_1')) {
        state = comp.long_name;
      }
    }
    const street = [streetNumber, route].filter(Boolean).join(' ').trim();
    const area = [street, neighborhood].filter(Boolean).join(', ') || primary.formatted_address.split(',')[0]?.trim() || city || state;
    const resolvedCity = city || state || '';
    return { area, city: resolvedCity, formatted: primary.formatted_address };
  }
}

/**
 * High-detail zoom=18 reverse/forward geocoder fallback when Google REST
 * Geocoding API is still propagating activation.
 */
export class OsmAdapter implements MapsPort {
  available() { return true; }
  private headers() {
    return { 'User-Agent': 'Kendibo/1.0 (geocoding; contact ops@kendibo.app)' };
  }
  async geocode(query: string, city = 'uyo') {
    if (!query.trim()) return null;
    const q = city && !query.toLowerCase().includes(city.toLowerCase()) ? `${query}, ${city}, Nigeria` : `${query}, Nigeria`;
    const data = await fetchJson(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=ng&limit=1&q=${encodeURIComponent(q)}`,
      this.headers(),
    ) as Array<{ lat: string; lon: string; display_name: string }>;
    if (!data.length) return null;
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), formatted: data[0].display_name };
  }
  async reverse(lat: number, lng: number) {
    const data = await fetchJson(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=${lat}&lon=${lng}`,
      this.headers(),
    ) as { display_name?: string; address?: Record<string, string> } | null;
    const a = data?.address ?? {};
    const street = [a.house_number, a.road || a.pedestrian || a.residential].filter(Boolean).join(' ').trim();
    const locality = a.neighbourhood || a.suburb || a.quarter || a.village || '';
    const area = [street, locality].filter(Boolean).join(', ') || a.town || a.city || a.state || '';
    const city = a.city || a.town || a.county || a.state || '';
    if (!area && !city) return null;
    return {
      area: area || city,
      city: city || area,
      formatted: data?.display_name,
    };
  }
}

export type MapsProviderName = 'mapbox' | 'google' | 'osm' | 'stub';

const ADAPTERS: Record<MapsProviderName, () => MapsPort & { available?: () => boolean }> = {
  mapbox: () => new MapboxAdapter(),
  google: () => new GoogleMapsAdapter(),
  osm: () => new OsmAdapter(),
  stub: () => new StubMapsAdapter(),
};

export const MAPS_PROVIDER_NAMES: MapsProviderName[] = ['google', 'mapbox', 'osm'];

interface MapsConfig {
  provider: MapsProviderName;
  fallbacks: MapsProviderName[];
  /** adapters with keys/tokens configured — surfaced to the admin console. */
  availability: Record<string, boolean>;
}

// Google is primary.
const DEFAULT_PROVIDER: MapsProviderName = process.env.MAPS_PROVIDER === 'mapbox' ? 'mapbox' : 'google';

let cachedConfig: { at: number; config: MapsConfig } | null = null;
const CONFIG_TTL_MS = 30_000;

function availability(): Record<string, boolean> {
  return {
    mapbox: Boolean(process.env.MAPBOX_ACCESS_TOKEN),
    google: Boolean(process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_BROWSER_KEY),
    osm: true,
  };
}

async function loadConfig(): Promise<MapsConfig> {
  if (cachedConfig && Date.now() - cachedConfig.at < CONFIG_TTL_MS) return cachedConfig.config;
  let provider = DEFAULT_PROVIDER;
  let fallbacks: MapsProviderName[] = DEFAULT_PROVIDER === 'google' ? ['osm', 'mapbox'] : ['google', 'osm'];
  try {
    const rows = await q<{ key: string; value: unknown }>(
      'SELECT key, value FROM configuration.platform_setting WHERE key IN ($1, $2)',
      ['maps.provider', 'maps.fallbacks'],
    );
    for (const row of rows) {
      if (row.key === 'maps.provider' && typeof row.value === 'string' && MAPS_PROVIDER_NAMES.includes(row.value as MapsProviderName)) {
        provider = row.value as MapsProviderName;
      }
      if (row.key === 'maps.fallbacks' && Array.isArray(row.value)) {
        fallbacks = row.value.filter((v): v is MapsProviderName =>
          typeof v === 'string' && (MAPS_PROVIDER_NAMES as string[]).includes(v));
      }
    }
  } catch {
    // settings table missing (pre-023 DB) → env defaults; never fail geocoding.
  }
  const config: MapsConfig = { provider, fallbacks, availability: availability() };
  cachedConfig = { at: Date.now(), config };
  return config;
}

/** Call after PUT /v1/admin/maps/config so the chain re-reads without waiting the TTL. */
export function invalidateMapsConfig(): void {
  cachedConfig = null;
}

async function chain(): Promise<Array<{ name: MapsProviderName; adapter: MapsPort }>> {
  const cfg = await loadConfig();
  const ordered: MapsProviderName[] = [];
  for (const name of [cfg.provider, ...cfg.fallbacks, 'osm' as MapsProviderName]) {
    if (!ordered.includes(name)) ordered.push(name);
  }
  const out: Array<{ name: MapsProviderName; adapter: MapsPort }> = [];
  for (const name of ordered) {
    if (name === 'stub') {
      if (process.env.NODE_ENV !== 'production') out.push({ name, adapter: ADAPTERS.stub() });
      continue;
    }
    const adapter = ADAPTERS[name]() as MapsPort & { available?: () => boolean };
    if (adapter.available && !adapter.available()) continue;
    out.push({ name, adapter });
  }
  return out;
}

async function withFallback<T>(op: (adapter: MapsPort) => Promise<T>): Promise<{ result: T; via: MapsProviderName } | null> {
  for (const { name, adapter } of await chain()) {
    try {
      const result = await op(adapter);
      if (result !== null && result !== undefined) return { result, via: name };
    } catch {
      // adapter down / quota / timeout → next in chain
    }
  }
  return null;
}

/**
 * Facade kept under the historic `maps` export so call sites (geocode and
 * reverse-geocode routes) stay unchanged; each call now walks the chain.
 */
export const maps: MapsPort = {
  async geocode(query, city) {
    const hit = await withFallback((a) => a.geocode(query, city));
    return hit?.result ?? null;
  },
  async reverse(lat, lng) {
    const hit = await withFallback((a) => a.reverse(lat, lng));
    return hit?.result ?? null;
  },
};

/** Admin console: current chain + which adapters have keys configured. */
export async function getMapsConfig(): Promise<MapsConfig> {
  return loadConfig();
}

/** Admin console: switch primary provider and/or reorder fallbacks. */
export async function setMapsConfig(input: {
  provider?: MapsProviderName;
  fallbacks?: MapsProviderName[];
}): Promise<MapsConfig> {
  const cfg = await loadConfig();
  const provider = input.provider ?? cfg.provider;
  const fallbacks = (input.fallbacks ?? cfg.fallbacks).filter((f) => f !== provider);
  await q(
    `INSERT INTO configuration.platform_setting (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    ['maps.provider', JSON.stringify(provider)],
  );
  await q(
    `INSERT INTO configuration.platform_setting (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    ['maps.fallbacks', JSON.stringify(fallbacks)],
  );
  invalidateMapsConfig();
  return loadConfig();
}
