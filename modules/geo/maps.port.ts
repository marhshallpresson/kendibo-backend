// MapsPort — geocode/zone abstraction (Google/Mapbox/alt swap without touching domain).
// Dev: deterministic stub over configured cities. Prod: set MAPS_PROVIDER=google|mapbox + key.
export interface MapsPort {
  geocode(query: string, city?: string): Promise<{ lat: number; lng: number; formatted: string } | null>;
  reverse(lat: number, lng: number): Promise<{ area: string; city: string } | null>;
}
const CITY_CENTERS: Record<string, { lat: number; lng: number }> = {
  uyo: { lat: 4.99, lng: 7.93 }, abuja: { lat: 9.06, lng: 7.49 }, lagos: { lat: 6.52, lng: 3.37 },
};
export class StubMapsAdapter implements MapsPort {
  async geocode(query: string, city = 'abuja') {
    const c = CITY_CENTERS[city.toLowerCase()] ?? CITY_CENTERS.abuja;
    if (!query.trim()) return null;
    // deterministic jitter so identical queries map identically (cacheable)
    let h = 0; for (const ch of query) h = (h * 31 + ch.charCodeAt(0)) % 1000;
    return { lat: c.lat + (h % 100) / 10000, lng: c.lng + (h % 77) / 10000, formatted: `${query}, ${city}` };
  }
  async reverse(lat: number, lng: number) {
    let best = 'abuja', bd = Infinity;
    for (const [k, c] of Object.entries(CITY_CENTERS)) {
      const d = Math.hypot(lat - c.lat, lng - c.lng);
      if (d < bd) { bd = d; best = k; }
    }
    return { area: 'Central', city: best };
  }
}
export class MapboxAdapter implements MapsPort {
  async geocode(query: string, city = 'abuja') {
    if (!query.trim()) return null;
    const token = process.env.MAPBOX_ACCESS_TOKEN;
    const res = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query + ', ' + city)}.json?access_token=${token}`);
    const data = await res.json() as any;
    if (!data.features || data.features.length === 0) return null;
    const [lng, lat] = data.features[0].center;
    return { lat, lng, formatted: data.features[0].place_name };
  }
  async reverse(lat: number, lng: number) {
    const token = process.env.MAPBOX_ACCESS_TOKEN;
    const res = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?access_token=${token}`);
    const data = await res.json() as any;
    if (!data.features || data.features.length === 0) return null;
    
    let city = 'abuja';
    let area = 'Central';
    for (const f of data.features) {
      if (f.place_type.includes('place')) city = f.text;
      if (f.place_type.includes('neighborhood') || f.place_type.includes('locality')) area = f.text;
    }
    return { area, city };
  }
}
export const maps: MapsPort = process.env.MAPS_PROVIDER === 'mapbox' ? new MapboxAdapter() : new StubMapsAdapter();
